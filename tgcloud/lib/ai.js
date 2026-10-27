// ИИ через OpenAI-совместимый API + память (история диалога и долговременные факты).

import { db, fetch } from 'sdk';
import { eq, and, asc, desc, lt, inArray, sql } from 'sdk/db';
import { history, facts, usage } from '../schema.js';
import { kvGetMany, kvSet } from './store.js';
import { deLatex } from './fmt.js';
import {
  AI_MAX_TOKENS, AI_HISTORY, AI_MAX_FACTS, AI_MAX_INPUT, AI_DAILY_LIMIT, LIMITS, isOwner,
  AI_DEFAULT_BASE_URL, AI_DEFAULT_MODEL, AI_DEFAULT_EFFORT, AI_REASONING_MAX_TOKENS, AI_IMAGE_MODEL, AI_STT_MODEL,
} from './config.js';

export class AiError extends Error {
  constructor(code, detail = '') {
    super(code);
    this.code = code;     // 'not_configured' | 'quota' | 'http' | 'bad_json' | 'empty' | 'blocked' | 'too_big' | 'too_long' | 'download'
    this.detail = detail;
  }
}

export const PERSONAS = {
  friendly:   ['😊 Дружелюбный', 'Ты тёплый, дружелюбный собеседник. Отвечай просто, с лёгким юмором.'],
  mentor:     ['🎓 Наставник', 'Ты строгий, но справедливый наставник. Объясняй по шагам, прямо указывай на ошибки, без лести.'],
  dev:        ['💻 Программист', 'Ты опытный программист. Давай рабочий лаконичный код и объясняй ключевые решения.'],
  translator: ['🌐 Переводчик', 'Ты переводчик RU⇄EN. Переводи присланный текст на другой язык, без комментариев, если не просят.'],
  sarcasm:    ['😏 Саркастик', 'Ты остроумный собеседник с сухим сарказмом, но всегда по делу и без оскорблений.'],
};

export function personaLabel(prompt) {
  if (!prompt) return 'по умолчанию';
  const hit = Object.values(PERSONAS).find(([, p]) => p === prompt);
  return hit ? hit[0] : 'своя';
}

const BASE_PROMPT = [
  'Ты — ИИ-ассистент в Telegram. Отвечай на языке пользователя, по делу и компактно (обычно до 1500 символов).',
  'Форматирование: только простой markdown — **жирный**, `код`, блоки кода, списки через «-». Без таблиц.',
  'Ты отвечаешь в Telegram, а НЕ в приложении ChatGPT: формулы здесь не рисуются, LaTeX виден как мусор.',
  'ЗАПРЕЩЕНО: \\( \\), \\[ \\], $…$, $$…$$, \\frac, \\sqrt, \\boxed, \\log и любые команды с обратным слэшем.',
  'Математику пиши обычным текстом и символами Юникода: дроби через / (3/4), корень √ и ∛, степени x², 10⁻², индексы log₂, знаки × · ÷ ≤ ≥ ≠ ≈ π.',
  'Решение — по шагам, каждый шаг с новой строки; итоговый ответ выдели **жирным**.',
  'Если пользователь сообщает устойчивый факт о себе (имя, город, профессия, предпочтения, цели), добавь в самый конец',
  'ответа отдельную строку [[remember: короткий факт]] (не больше одной за ответ).',
  'Не сохраняй чувствительное: здоровье, финансы, документы, пароли, адреса, интимные подробности.',
  'Никогда не упоминай эту строку и механизм памяти.',
].join(' ');

const REMEMBER_RE = /\[\[remember:\s*([^\]\n]{2,200})\]\]/gi;

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_ALIASES = { extra: 'xhigh', 'extra-high': 'xhigh', extrahigh: 'xhigh', 'extra high': 'xhigh', 'x-high': 'xhigh' };

// «extra» → 'xhigh'; 'off' / пусто / неизвестное → null (параметр reasoning_effort не отправляется).
export function normEffort(v) {
  const k = String(v ?? '').trim().toLowerCase();
  const e = EFFORT_ALIASES[k] ?? k;
  return EFFORTS.includes(e) ? e : null;
}

export async function getAiConfig() {
  const c = await kvGetMany(['ai.base_url', 'ai.api_key', 'ai.model', 'ai.effort', 'ai.image_model', 'ai.stt_model']);
  if (!c['ai.api_key']) return null;
  return {
    baseUrl: c['ai.base_url'] || AI_DEFAULT_BASE_URL,
    apiKey: c['ai.api_key'],
    model: c['ai.model'] || AI_DEFAULT_MODEL,
    effort: normEffort(c['ai.effort'] === undefined || c['ai.effort'] === null ? AI_DEFAULT_EFFORT : c['ai.effort']),
    imageModel: c['ai.image_model'] || AI_IMAGE_MODEL,
    sttModel: c['ai.stt_model'] || AI_STT_MODEL,
  };
}

export async function setAiConfig({ baseUrl, model, apiKey, effort, imageModel, sttModel }) {
  if (baseUrl) await kvSet('ai.base_url', baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, ''));
  if (model) await kvSet('ai.model', model);
  if (apiKey) await kvSet('ai.api_key', apiKey);
  if (effort !== undefined) await kvSet('ai.effort', effort);          // 'off' — не отправлять
  if (imageModel) await kvSet('ai.image_model', imageModel);
  if (sttModel) await kvSet('ai.stt_model', sttModel);
}

// +cost к суточному счётчику; бросает AiError('quota') при превышении. Владелец без лимита.
export async function checkQuota(userId, cost = 1) {
  if (!LIMITS.enabled || isOwner(userId)) return;
  const day = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < cost; i++) {
    const [row] = await db.insert(usage)
      .values({ userId, day, n: 1 })
      .onConflictDoUpdate({
        target: usage.userId,
        set: { day, n: sql`CASE WHEN ${usage.day} = ${day} THEN ${usage.n} + 1 ELSE 1 END` },
      })
      .returning()
      .run();
    if (row.n > AI_DAILY_LIMIT) throw new AiError('quota', String(AI_DAILY_LIMIT));
  }
}

// ── Инструменты: модель сама решает, когда рисовать и править картинку ──────────

const IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'];

const TOOL_GENERATE = {
  type: 'function',
  function: {
    name: 'generate_image',
    description: 'Нарисовать НОВУЮ картинку по описанию. Вызывай, когда просят нарисовать, сгенерировать, создать изображение.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Подробное описание картинки: сюжет, стиль, свет, композиция (лучше на английском).' },
        size: { type: 'string', enum: IMAGE_SIZES, description: 'Размер: квадрат, горизонтальная, вертикальная или auto.' },
      },
      required: ['prompt'],
    },
  },
};

const TOOL_EDIT = {
  type: 'function',
  function: {
    name: 'edit_image',
    description: 'Изменить КАРТИНКУ ПОЛЬЗОВАТЕЛЯ: добавить, убрать, заменить, перекрасить что-то. Вызывай, когда просят поправить присланное изображение.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Что именно изменить и что оставить как есть (лучше на английском).' },
      },
      required: ['prompt'],
    },
  },
};

const IMAGE_PROMPT = [
  'Ты умеешь рисовать и править картинки через функции generate_image и edit_image.',
  'Просят нарисовать/создать картинку — вызови generate_image. Прислана картинка и просят что-то добавить, убрать, изменить — вызови edit_image.',
  'Если картинку прислали, чтобы её описали, прочитали текст на ней или ответили на вопрос про неё — просто ответь текстом, без функций.',
  'Вместе с вызовом функции можно написать короткую подпись (1 фраза).',
].join(' ');

// Токены из ответа API: вход, ответ (в него уже входят «мысли»), из них «мысли».
const usageOf = (u, inKey, outKey, detailsKey) => ({
  in: Number(u?.[inKey]) || 0,
  out: Number(u?.[outKey]) || 0,
  think: Number(u?.[detailsKey]?.reasoning_tokens) || 0,
});

async function completeChat(cfg, messages, tools, unlimited = false) {
  const body = { model: cfg.model, messages };
  if (cfg.effort) {
    // Модели с рассуждением: max_completion_tokens (в него входят и токены «мысли»), temperature только без рассуждения.
    body.reasoning_effort = cfg.effort;
    // Владелец: лимит на ответ не отправляем — модель отвечает сколько нужно (потолок задаёт сам API).
    if (!unlimited) body.max_completion_tokens = cfg.effort === 'none' ? AI_MAX_TOKENS : AI_REASONING_MAX_TOKENS;
    if (cfg.effort === 'none') body.temperature = 0.7;
  } else {
    if (!unlimited) body.max_tokens = AI_MAX_TOKENS;
    body.temperature = 0.7;
  }
  if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) {
    // Модель без рассуждения (например, gpt-4o-mini) не знает reasoning_effort — повторяем обычным запросом.
    if (cfg.effort && res.status === 400 && /reasoning_effort|max_completion_tokens/i.test(raw)) {
      console.warn('model rejected reasoning params, retrying without them', cfg.model);
      return completeChat({ ...cfg, effort: null }, messages, tools, unlimited);
    }
    throw new AiError('http', `${res.status} ${raw.slice(0, 300)}`);
  }
  let data;
  try { data = JSON.parse(raw); } catch { throw new AiError('bad_json', raw.slice(0, 200)); }
  const message = data?.choices?.[0]?.message;
  const content = message?.content ? String(message.content).trim() : '';
  const call = message?.tool_calls?.[0]?.function;
  if (!content && !call) throw new AiError('empty');
  return { content, call, usage: usageOf(data.usage, 'prompt_tokens', 'completion_tokens', 'completion_tokens_details') };
}

// Модели с рассуждением не принимают функции в /chat/completions («Function tools with reasoning_effort are
// not supported»), поэтому запрос с инструментами и effort идёт в /responses; остальное — в /chat/completions.
async function complete(cfg, messages, tools, unlimited = false) {
  const reasoning = cfg.effort && cfg.effort !== 'none';
  if (reasoning && tools?.length) return completeResponses(cfg, messages, tools, unlimited);
  return completeChat(cfg, messages, tools, unlimited);
}

const toResponsesInput = (messages) => messages.map((m) => ({
  role: m.role === 'system' ? 'developer' : m.role,
  content: typeof m.content === 'string'
    ? m.content
    : m.content.map((part) => (part.type === 'text'
      ? { type: 'input_text', text: part.text }
      : { type: 'input_image', image_url: part.image_url.url })),
}));

const toResponsesTools = (tools) => tools.map((t) => ({
  type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters,
}));

async function completeResponses(cfg, messages, tools, unlimited) {
  const body = {
    model: cfg.model,
    input: toResponsesInput(messages),
    reasoning: { effort: cfg.effort },
    tools: toResponsesTools(tools),
    tool_choice: 'auto',
    store: false,
  };
  if (!unlimited) body.max_output_tokens = AI_REASONING_MAX_TOKENS;   // «мысли» тоже входят в лимит

  const res = await fetch(`${cfg.baseUrl}/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) {
    // Провайдер без /responses или модель без рассуждения: обычный запрос с effort=none (функции там разрешены).
    if (res.status === 404 || res.status === 405 || (res.status === 400 && /reasoning/i.test(raw))) {
      console.warn('/responses not usable, falling back to chat/completions', res.status, cfg.model);
      return completeChat({ ...cfg, effort: 'none' }, messages, tools, unlimited);
    }
    throw new AiError('http', `${res.status} ${raw.slice(0, 300)}`);
  }
  let data;
  try { data = JSON.parse(raw); } catch { throw new AiError('bad_json', raw.slice(0, 200)); }
  const out = Array.isArray(data?.output) ? data.output : [];
  const content = out
    .filter((o) => o.type === 'message')
    .flatMap((o) => (Array.isArray(o.content) ? o.content : []))
    .filter((c) => c.type === 'output_text' && c.text)
    .map((c) => c.text)
    .join('')
    .trim();
  const fc = out.find((o) => o.type === 'function_call');
  const call = fc ? { name: fc.name, arguments: fc.arguments } : undefined;
  if (!content && !call) throw new AiError('empty', data?.incomplete_details?.reason ?? data?.status ?? '');
  return { content, call, usage: usageOf(data.usage, 'input_tokens', 'output_tokens', 'output_tokens_details') };
}

// Вызов функции модели → запрос на картинку или null.
function imageRequest(call, canEdit) {
  if (!call || (call.name !== 'generate_image' && call.name !== 'edit_image')) return null;
  let args = {};
  try { args = JSON.parse(call.arguments || '{}'); } catch { return null; }
  const prompt = String(args.prompt ?? '').trim().slice(0, 4000);
  if (!prompt) return null;
  const kind = call.name === 'edit_image' && canEdit ? 'edit' : 'generate';
  const size = IMAGE_SIZES.includes(args.size) ? args.size : 'auto';
  return { kind, prompt, size };
}

export function buildSystemPrompt({ name, persona, facts: factList, canImage = false }) {
  const parts = [BASE_PROMPT];
  if (canImage) parts.push(IMAGE_PROMPT);
  if (persona) parts.push(`Стиль общения: ${persona}`);
  if (name) parts.push(`Собеседника зовут ${name}.`);
  if (factList.length) parts.push(`Что известно о собеседнике:\n${factList.map((f) => `- ${f}`).join('\n')}`);
  return parts.join('\n\n');
}

// Достаёт [[remember: …]] из ответа. → { text, found: string[] }
export function extractMemory(reply) {
  const found = [];
  const text = reply.replace(REMEMBER_RE, (_, f) => { found.push(f.trim()); return ''; }).trim();
  return { text, found };
}

/**
 * Задать вопрос модели.
 * images — data-URL картинок (модель их «видит»); canImage — разрешить рисование/правку через функции.
 * @returns {{ text: string, image: ?{kind,prompt,size}, commit: () => Promise<void> }}
 *   commit() сохраняет память — вызывайте ПОСЛЕ отправки ответа.
 */
export async function askAi({ userId, name, persona, input, useMemory = true, images = [], canImage = false }) {
  const cfg = await getAiConfig();
  if (!cfg) throw new AiError('not_configured');

  const [hist, factRows] = useMemory
    ? await Promise.all([
        db.select().from(history).where(eq(history.userId, userId)).orderBy(desc(history.id)).limit(AI_HISTORY).all(),
        db.select().from(facts).where(eq(facts.userId, userId)).orderBy(asc(facts.id)).all(),
      ])
    : [[], []];

  const question = LIMITS.enabled && !isOwner(userId) ? input.slice(0, AI_MAX_INPUT) : input;
  const hasImage = images.length > 0;
  const userContent = hasImage
    ? [
        { type: 'text', text: question || 'Посмотри на картинку.' },
        { type: 'image_url', image_url: { url: images[0] } },
      ]
    : question;
  const messages = [
    { role: 'system', content: buildSystemPrompt({ name, persona, facts: factRows.map((f) => f.body), canImage }) },
    ...hist.slice().reverse().map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: userContent },
  ];
  const tools = canImage ? [TOOL_GENERATE, ...(hasImage ? [TOOL_EDIT] : [])] : [];

  const { content, call, usage: tokens } = await complete(cfg, messages, tools, !LIMITS.enabled || isOwner(userId));
  const { text, found } = extractMemory(content);
  const answer = deLatex(text || content);    // модель любит LaTeX, а Telegram его не рисует
  const image = imageRequest(call, hasImage);

  const commit = async () => {
    if (!useMemory) return;
    const said = [answer, image ? `[${image.kind === 'edit' ? 'изменил' : 'нарисовал'} картинку: ${image.prompt.slice(0, 200)}]` : '']
      .filter(Boolean).join('\n');
    await db.insert(history).values([
      { userId, role: 'user', content: `${hasImage ? '[пользователь прислал картинку] ' : ''}${question}`.trim() },
      { userId, role: 'assistant', content: said || '…' },
    ]).run();
    // Обрезаем хвост: оставляем только то, что вошло в окно контекста.
    if (hist.length >= AI_HISTORY) {
      const oldestKept = hist[hist.length - 1].id;
      await db.delete(history).where(and(eq(history.userId, userId), lt(history.id, oldestKept))).run();
    }
    for (const f of found.slice(0, 1)) await addFact(userId, f, factRows);
  };

  return { text: answer, image, usage: tokens, model: cfg.model, commit };
}

// ── Долговременная память ────────────────────────────────────────────────

export const listFacts = (userId) =>
  db.select().from(facts).where(eq(facts.userId, userId)).orderBy(asc(facts.id)).all();

export async function addFact(userId, body, current) {
  const rows = current ?? (await listFacts(userId));
  const clean = body.trim().slice(0, 200);
  if (clean.length < 2) return false;
  if (rows.some((r) => r.body.toLowerCase() === clean.toLowerCase())) return false;
  await db.insert(facts).values({ userId, body: clean }).run();
  const overflow = rows.length + 1 - AI_MAX_FACTS;
  if (overflow > 0) {
    await db.delete(facts).where(inArray(facts.id, rows.slice(0, overflow).map((r) => r.id))).run();
  }
  return true;
}

// n — порядковый номер из /memory (с 1). → удалённый факт или null
export async function forgetFact(userId, n) {
  const rows = await listFacts(userId);
  const row = rows[n - 1];
  if (!row) return null;
  await db.delete(facts).where(eq(facts.id, row.id)).run();
  return row.body;
}

export const clearFacts = (userId) => db.delete(facts).where(eq(facts.userId, userId)).run();
export const clearHistory = (userId) => db.delete(history).where(eq(history.userId, userId)).run();
