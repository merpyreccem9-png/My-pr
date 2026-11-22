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
});

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
