// Хелперы отправки и обработки ошибок Bot API.

import { api, BotApiError } from 'sdk';
import { esc, mdToHtml, chunk } from './fmt.js';
import { AI_STREAM_INTERVAL_MS } from './config.js';

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

const CURSOR = ' ▍';

// Плавный вывод ответа ИИ: сообщение появляется с первыми словами и дописывается правками (editMessageText),
// как печатает ChatGPT. push(текст) — «текст на данный момент» (не чаще раза в interval мс уходит правка);
// finish(итог) — финальная версия без курсора, длинный ответ режется на несколько сообщений;
// abort() — убрать курсор, если генерация оборвалась. Ничего не отправлено → finish работает как sayMarkdown.
// Правки — украшение: сбой промежуточной правки (429, сообщение удалено) не ломает ответ, итог дойдёт в finish.
export function streamReply(msg, { reply = false, interval = AI_STREAM_INTERVAL_MS } = {}) {
  const base = baseParams(msg, reply);
  const sent = [];            // по частям: { id, shown }
  let latest = '';
  let last = 0;
  let backoffUntil = 0;
  let closed = false;

  async function put(i, md, cursor, strict = false) {
    const tail = cursor ? CURSOR : '';
    const html = mdToHtml(md) + tail;
    const slot = sent[i];
    if (slot && slot.shown === html) return;
    const attempt = async (asHtml) => {
      const text = asHtml ? html : md + tail;
      const extra = asHtml ? { parse_mode: 'HTML' } : {};
      if (!slot) {
        const m = await api.sendMessage({ ...base, ...extra, text });
        delete base.reply_parameters;
        sent[i] = { id: m.message_id, shown: html };
      } else {
        await api.editMessageText({
          chat_id: msg.chat.id, message_id: slot.id, link_preview_options: { is_disabled: true }, ...extra, text,
        });
        slot.shown = html;
      }
    };
    try {
      try {
        await attempt(true);
      } catch (e) {
        if (!(e instanceof BotApiError) || notModified(e) || e.code !== 400) throw e;
        await attempt(false);                       // разметка не прошла — обычным текстом
      }
    } catch (e) {
      if (!(e instanceof BotApiError)) throw e;
      if (notModified(e)) { if (slot) slot.shown = html; return; }
      if (e.code === 429) backoffUntil = Date.now() + (Number(e.parameters?.retry_after) || 3) * 1000;
      console.warn('stream put failed', e.code, e.description);
      if (!strict) return;
      if (!slot) throw e;
      // Итог обязан дойти: правка не удалась — присылаем часть новым сообщением.
      const m = await api.sendMessage({ ...base, text: md });
      await quiet(api.deleteMessage({ chat_id: msg.chat.id, message_id: slot.id }));
      sent[i] = { id: m.message_id, shown: html };
    }
  }

  async function flush(text, cursor, strict = false) {
    const parts = chunk(text);
    for (let i = 0; i < parts.length; i++) await put(i, parts[i], cursor && i === parts.length - 1, strict);
    return parts.length;
  }

  return {
    async push(text) {
      latest = text;
      const now = Date.now();
      if (closed || !text.trim() || now < backoffUntil || now - last < interval) return;
      last = now;
      await flush(text, true);
    },

    async finish(text) {
      closed = true;
      const final = String(text ?? '').trim();
      if (!sent.length) {
        if (final) await sayMarkdown(msg, final, { reply });
        return;
      }
      const n = final ? await flush(final, false, true) : 0;
      for (const s of sent.splice(n)) await quiet(api.deleteMessage({ chat_id: msg.chat.id, message_id: s.id }));
    },

    async abort() {
      closed = true;
      if (!sent.length || !latest.trim()) return;
      try { await flush(latest, false); } catch (e) { console.warn('stream abort failed', e?.description ?? e); }
    },
  };
}

// Временное сообщение-статус («💭 Думаю…»): показываем на время работы и удаляем, когда функция завершилась
// (ответом или ошибкой). Статус — украшение: если не отправился или не удалился, это не ломает основной ответ.
export async function withStatus(msg, text, fn) {
  let sent = null;
  try {
    sent = await api.sendMessage({ ...baseParams(msg, true), text });
  } catch (e) {
    console.warn('status not sent', e?.description ?? e);
  }
  const setStatus = async (next) => {
    if (!sent) return;
    try {
      await api.editMessageText({ chat_id: msg.chat.id, message_id: sent.message_id, text: next });
    } catch (e) {
      if (!(e instanceof BotApiError)) throw e;   // «not modified» и т.п. — не страшно
    }
  };
  try {
    return await fn(setStatus);
  } finally {
    if (sent) {
      try {
        await api.deleteMessage({ chat_id: msg.chat.id, message_id: sent.message_id });
      } catch (e) {
        console.warn('status not deleted', e?.description ?? e);
      }
    }
  }
}

export function typing(msg, action = 'typing') {
  const p = { chat_id: msg.chat.id, action };
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
