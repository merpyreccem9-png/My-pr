// Хелперы отправки и обработки ошибок Bot API.

import { api, BotApiError } from 'sdk';
import { esc, mdToHtml, chunk } from './fmt.js';

export function baseParams(msg, reply = true) {
  const p = { chat_id: msg.chat.id, link_preview_options: { is_disabled: true } };
  if (msg.is_topic_message && msg.message_thread_id) p.message_thread_id = msg.message_thread_id;
  if (reply && msg.chat.type !== 'private') {
    p.reply_parameters = { message_id: msg.message_id, allow_sending_without_reply: true };
  }
  return p;
}

// Ответ в тот же чат (HTML). В группах — реплаем на сообщение-команду.
export function say(msg, html, { reply = true, ...extra } = {}) {
  return api.sendMessage({ ...baseParams(msg, reply), ...extra, text: html, parse_mode: 'HTML' });
}

// Ответ ИИ: markdown → HTML, длинное режется на части; при ошибке разметки уходит обычным текстом.
export async function sayMarkdown(msg, md, { reply = true } = {}) {
  const base = baseParams(msg, reply);
  for (const part of chunk(md)) {
    try {
      await api.sendMessage({ ...base, text: mdToHtml(part), parse_mode: 'HTML' });
    } catch (e) {
      if (!(e instanceof BotApiError) || e.code !== 400) throw e;
      await api.sendMessage({ ...base, text: part });
    }
    delete base.reply_parameters; // реплаем только первая часть
  }
}

export function typing(msg) {
  const p = { chat_id: msg.chat.id, action: 'typing' };
  if (msg.is_topic_message && msg.message_thread_id) p.message_thread_id = msg.message_thread_id;
  return quiet(api.sendChatAction(p));
}

// Глотает ожидаемые ошибки Bot API (сообщение уже удалено и т.п.).
export const quiet = (promise) =>
  promise.catch((e) => {
    if (e instanceof BotApiError) return null;
    throw e;
  });

export const notModified = (e) => e instanceof BotApiError && /not modified/i.test(e.description ?? '');

export function humanError(e) {
  const d = e.description ?? '';
  if (/not enough rights|CHAT_ADMIN_REQUIRED|have no rights|need to be (an )?administrator/i.test(d)) {
    return 'У бота нет нужных прав администратора.';
  }
  if (/administrator|USER_ADMIN_INVALID/i.test(d)) return 'Нельзя применить это к администратору.';
  if (/user not found|PARTICIPANT_ID_INVALID|member not found|chat not found/i.test(d)) {
    return 'Пользователь не найден в чате.';
  }
  if (/message to (delete|pin) not found|message can't be deleted/i.test(d)) {
    return 'Не удалось: сообщение не найдено или слишком старое.';
  }
  return `Ошибка Telegram: ${esc(d)}`;
}

// Единая точка обработки ошибок команд в группах.
export async function fail(msg, e) {
  if (e instanceof BotApiError) {
    console.warn('bot api', e.method, e.code, e.description);
    return say(msg, `⚠️ ${humanError(e)}`);
  }
  console.error(e);
  return say(msg, '⚠️ Что-то пошло не так. Попробуйте позже.');
}
