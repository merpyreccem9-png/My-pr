// Общее для эндпоинтов Mini App: пользователь из initData, ход выполнения запроса («run»), перевод ошибок.

import { EndpointError } from 'sdk';
import { touchUser, kvGetMany, kvSet } from './store.js';
import { AiError } from './ai.js';
import { isOwner, AI_MAX_AUDIO_SEC } from './config.js';

export const runKey = (id) => `run.${id}`;

export async function appUser(ctx) {
  const u = ctx?.initData?.user;
  if (!u?.id) throw new EndpointError('Откройте приложение из Telegram', { code: 'NO_USER' });
  return { tg: u, user: await touchUser(u) };
}

export async function loadRun(userId) {
  const raw = (await kvGetMany([runKey(userId)]))[runKey(userId)];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export const saveRun = (userId, run) => kvSet(runKey(userId), JSON.stringify(run));

// Что видит клиент: без служебных полей.
export const publicRun = (r) => r && ({
  id: r.id, text: r.text, live: r.live, trace: r.trace, done: r.done, error: r.error ?? null, ms: r.ms ?? null, model: r.model ?? null,
  image: r.image ?? null, files: r.files ?? [],
});

export const imgKey = (id) => `appimg.${id}`;   // последняя нарисованная картинка (dataURL) — клиент забирает отдельным запросом

// Вложения из приложения: одна картинка (dataURL, уже уменьшенная клиентом) и до 3 текстовых файлов.
const IMG_RE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
export const MAX_IMG_CHARS = 3_000_000;
export const MAX_FILE_CHARS = 60_000;

export function attachments(input) {
  const images = (Array.isArray(input.images) ? input.images : [])
    .filter((v) => typeof v === 'string' && v.length <= MAX_IMG_CHARS && IMG_RE.test(v))
    .slice(0, 1);
  const files = (Array.isArray(input.files) ? input.files : []).slice(0, 3)
    .map((f) => ({ name: String(f?.name ?? 'файл').replace(/[\r\n`]/g, ' ').slice(0, 80), text: String(f?.text ?? '').slice(0, MAX_FILE_CHARS) }))
    .filter((f) => f.text.trim());
  return { images, files };
}

// Вопрос + содержимое файлов блоками кода (так модель их видит, и так они остаются в истории).
export function withFiles(text, files) {
  const blocks = files.map((f) => `📎 ${f.name}:\n\`\`\`\n${f.text.replace(/```/g, '`\u200b``')}\n\`\`\``);
  return [text, ...blocks].filter(Boolean).join('\n\n');
}

// AiError → понятное сообщение для приложения (код — машинный, текст — для человека).
export function appError(e, userId) {
  if (!(e instanceof AiError)) return null;
  const owner = isOwner(userId);
  switch (e.code) {
    case 'not_configured': return [owner ? 'ИИ не настроен: отправьте боту /setkey ВАШ_КЛЮЧ' : 'ИИ пока не подключён владельцем бота.', 'NOT_CONFIGURED'];
    case 'quota': return [`Дневной лимит ИИ-запросов (${e.detail}) исчерпан. Попробуйте завтра.`, 'QUOTA'];
    case 'too_long': return [`Голосовое длиннее ${Math.round(AI_MAX_AUDIO_SEC / 60)} мин.`, 'TOO_LONG'];
    default:
      console.error('ai failed (app)', e.code, e.detail);
      return [owner ? `Ошибка ИИ (${e.code}): ${String(e.detail ?? '').slice(0, 300)}` : 'ИИ сейчас недоступен. Попробуйте позже.', 'AI_ERROR'];
  }
}
