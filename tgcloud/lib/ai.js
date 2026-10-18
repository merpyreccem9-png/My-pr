// ИИ через OpenAI-совместимый API + память (история диалога и долговременные факты).

import { db, fetch } from 'sdk';
import { eq, and, asc, desc, lt, inArray, sql } from 'sdk/db';
import { history, facts, usage } from '../schema.js';
import { kvGetMany, kvSet } from './store.js';
import { AI_MAX_TOKENS, AI_HISTORY, AI_MAX_FACTS, AI_MAX_INPUT, AI_DAILY_LIMIT, isOwner } from './config.js';

export class AiError extends Error {
  constructor(code, detail = '') {
    super(code);
    this.code = code;     // 'not_configured' | 'quota' | 'http' | 'bad_json' | 'empty'
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
  'Форматирование: только простой markdown — **жирный**, `код`, блоки кода, списки через «-». Без таблиц и LaTeX.',
  'Если пользователь сообщает устойчивый факт о себе (имя, город, профессия, предпочтения, цели), добавь в самый конец',
  'ответа отдельную строку [[remember: короткий факт]] (не больше одной за ответ).',
  'Не сохраняй чувствительное: здоровье, финансы, документы, пароли, адреса, интимные подробности.',
  'Никогда не упоминай эту строку и механизм памяти.',
].join(' ');

const REMEMBER_RE = /\[\[remember:\s*([^\]\n]{2,200})\]\]/gi;

export async function getAiConfig() {
  const c = await kvGetMany(['ai.base_url', 'ai.api_key', 'ai.model']);
  if (!c['ai.base_url'] || !c['ai.api_key'] || !c['ai.model']) return null;
  return { baseUrl: c['ai.base_url'], apiKey: c['ai.api_key'], model: c['ai.model'] };
}

export async function setAiConfig({ baseUrl, model, apiKey }) {
  if (baseUrl) await kvSet('ai.base_url', baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, ''));
  if (model) await kvSet('ai.model', model);
  if (apiKey) await kvSet('ai.api_key', apiKey);
}

// +1 к суточному счётчику; бросает AiError('quota') при превышении. Владелец без лимита.
export async function checkQuota(userId) {
  if (isOwner(userId)) return;
  const day = new Date().toISOString().slice(0, 10);
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

// Новые модели OpenAI (семейство GPT-5) не принимают max_tokens и нестандартную temperature.
// Если API отвечает 400 на такой параметр — убираем/заменяем его и повторяем запрос.
function adaptParams(body, raw) {
  if ('max_tokens' in body && /max_completion_tokens/.test(raw)) {
    // Лимит включает «рассуждения» модели, поэтому берём с запасом.
    body.max_completion_tokens = body.max_tokens * 4;
    delete body.max_tokens;
    return true;
  }
  if ('temperature' in body && /temperature/.test(raw)) {
    delete body.temperature;
    return true;
  }
  return false;
}

async function complete(cfg, messages) {
  const body = { model: cfg.model, messages, max_tokens: AI_MAX_TOKENS, temperature: 0.7 };
  let res, raw;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
    });
    raw = await res.text();
    if (res.ok) break;
    if (res.status === 400 && attempt < 2 && adaptParams(body, raw)) continue;
    throw new AiError('http', `${res.status} ${raw.slice(0, 300)}`);
  }
  let data;
  try { data = JSON.parse(raw); } catch { throw new AiError('bad_json', raw.slice(0, 200)); }
  const out = data?.choices?.[0]?.message?.content;
  if (!out || !String(out).trim()) throw new AiError('empty');
  return String(out).trim();
}

export function buildSystemPrompt({ name, persona, facts: factList }) {
  const parts = [BASE_PROMPT];
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
 * @returns {{ text: string, commit: () => Promise<void> }} commit() сохраняет память — вызывайте ПОСЛЕ отправки ответа.
 */
export async function askAi({ userId, name, persona, input, useMemory = true }) {
  const cfg = await getAiConfig();
  if (!cfg) throw new AiError('not_configured');

  const [hist, factRows] = useMemory
    ? await Promise.all([
        db.select().from(history).where(eq(history.userId, userId)).orderBy(desc(history.id)).limit(AI_HISTORY).all(),
        db.select().from(facts).where(eq(facts.userId, userId)).orderBy(asc(facts.id)).all(),
      ])
    : [[], []];

  const question = input.slice(0, AI_MAX_INPUT);
  const messages = [
    { role: 'system', content: buildSystemPrompt({ name, persona, facts: factRows.map((f) => f.body) }) },
    ...hist.slice().reverse().map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: question },
  ];

  const raw = await complete(cfg, messages);
  const { text, found } = extractMemory(raw);
  const answer = text || raw;

  const commit = async () => {
    if (!useMemory) return;
    await db.insert(history).values([
      { userId, role: 'user', content: question },
      { userId, role: 'assistant', content: answer },
    ]).run();
    // Обрезаем хвост: оставляем только то, что вошло в окно контекста.
    if (hist.length >= AI_HISTORY) {
      const oldestKept = hist[hist.length - 1].id;
      await db.delete(history).where(and(eq(history.userId, userId), lt(history.id, oldestKept))).run();
    }
    for (const f of found.slice(0, 1)) await addFact(userId, f, factRows);
  };

  return { text: answer, commit };
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
