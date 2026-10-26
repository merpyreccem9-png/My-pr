// Картинки и голос: скачивание файлов из Telegram, распознавание речи,
// генерация и правка изображений через OpenAI-совместимый API.

import { api, fetch, FormData, InputFile, BotApiError } from 'sdk';
import { AiError } from './ai.js';
import { AI_MAX_FILE_BYTES } from './config.js';

// ── base64 (btoa/atob в изолята может не быть — свой кодек) ─────────────────

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = (() => {
  const t = new Uint8Array(128).fill(255);
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
  return t;
})();

export function bytesToB64(bytes) {
  const parts = [];
  const STEP = 3 * 8192;
  for (let start = 0; start < bytes.length; start += STEP) {
    const end = Math.min(start + STEP, bytes.length);
    let out = '';
    let i = start;
    for (; i + 2 < end; i += 3) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
    }
    if (i < end) {
      const a = bytes[i];
      const b = i + 1 < end ? bytes[i + 1] : 0;
      const n = (a << 16) | (b << 8);
      out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + (i + 1 < end ? ALPHABET[(n >> 6) & 63] : '=') + '=';
    }
    parts.push(out);
  }
  return parts.join('');
}

export function b64ToBytes(str) {
  const clean = str.replace(/^data:[^,]*,/, '').replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = LOOKUP[clean.charCodeAt(i)];
    const b = LOOKUP[clean.charCodeAt(i + 1)];
    const c = i + 2 < clean.length ? LOOKUP[clean.charCodeAt(i + 2)] : 0;
    const d = i + 3 < clean.length ? LOOKUP[clean.charCodeAt(i + 3)] : 0;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

export const toDataUrl = (bytes, mime) => `data:${mime};base64,${bytesToB64(bytes)}`;

// Тип картинки по первым байтам (Telegram-фото — всегда JPEG, а файлы и результаты ИИ — разные).
export function sniffMime(b) {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  return 'image/png';
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

// ── Telegram: входящие файлы ─────────────────────────────────────────────

// Что прислали: картинку, голос/аудио/кружок или ничего интересного.
export function pickMedia(msg) {
  if (msg.photo?.length) {
    const p = msg.photo[msg.photo.length - 1];
    return { kind: 'image', fileId: p.file_id, size: p.file_size };
  }
  const d = msg.document;
  if (d && /^image\/(png|jpe?g|webp|gif)$/i.test(d.mime_type ?? '')) {
    return { kind: 'image', fileId: d.file_id, size: d.file_size };
  }
  if (msg.voice) {
    return { kind: 'audio', fileId: msg.voice.file_id, size: msg.voice.file_size, duration: msg.voice.duration, name: 'voice.ogg', mime: 'audio/ogg' };
  }
  if (msg.video_note) {
    return { kind: 'audio', fileId: msg.video_note.file_id, size: msg.video_note.file_size, duration: msg.video_note.duration, name: 'note.mp4', mime: 'video/mp4' };
  }
  if (msg.audio) {
    const a = msg.audio;
    const ext = (a.file_name ?? '').match(/\.(mp3|m4a|wav|ogg|oga|opus|flac|webm|mp4|mpeg|mpga)$/i)?.[1] ?? 'mp3';
    return { kind: 'audio', fileId: a.file_id, size: a.file_size, duration: a.duration, name: `audio.${ext.toLowerCase()}`, mime: a.mime_type ?? 'audio/mpeg' };
  }
  return null;
}

export async function downloadFile(fileId, size) {
  if (size && size > AI_MAX_FILE_BYTES) throw new AiError('too_big');
  try {
    return await api.getFileContent(fileId);
  } catch (e) {
    if (!(e instanceof BotApiError)) throw e;
    if (/too big/i.test(e.description ?? '')) throw new AiError('too_big');
    throw new AiError('download', e.description ?? '');
  }
}

// Картинка из Telegram → { bytes, mime }
export async function loadImage(fileId, size) {
  const bytes = await downloadFile(fileId, size);
  return { bytes, mime: sniffMime(bytes) };
}

// ── OpenAI-совместимые вызовы ────────────────────────────────────────────

function apiError(res, raw) {
  const detail = `${res.status} ${raw.slice(0, 300)}`;
  if (/moderation_blocked|safety system|content_policy_violation|safety_violations/i.test(raw)) {
    return new AiError('blocked', detail);
  }
  return new AiError('http', detail);
}

async function readBytes(res) {
  if (typeof res.arrayBuffer === 'function') return new Uint8Array(await res.arrayBuffer());
  const parts = [];
  let n = 0;
  for await (const c of res.body) { parts.push(c); n += c.length; }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Голос → текст.
export async function transcribe(cfg, bytes, { filename, type }) {
  const form = new FormData();
  form.append('file', new InputFile(bytes, filename, { type }));
  form.append('model', cfg.sttModel);
  const res = await fetch(`${cfg.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}` },   // Content-Type с boundary выставит сама платформа
    body: form,
  });
  const raw = await res.text();
  if (!res.ok) throw apiError(res, raw);
  try { return String(JSON.parse(raw).text ?? '').trim(); } catch { return raw.trim(); }
}

async function parseImage(res) {
  const raw = await res.text();
  if (!res.ok) throw apiError(res, raw);
  let item;
  try { item = JSON.parse(raw)?.data?.[0]; } catch { throw new AiError('bad_json', raw.slice(0, 200)); }
  let bytes;
  if (item?.b64_json) {
    bytes = b64ToBytes(item.b64_json);
  } else if (item?.url) {
    const img = await fetch(item.url);
    if (!img.ok) throw new AiError('http', `image url ${img.status}`);
    bytes = await readBytes(img);
  } else {
    throw new AiError('empty');
  }
  return { bytes, mime: sniffMime(bytes) };
}

// Нарисовать новую картинку.
export async function generateImage(cfg, prompt, size = 'auto') {
  const res = await fetch(`${cfg.baseUrl}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.imageModel, prompt, size, n: 1 }),
  });
  return parseImage(res);
}

// Изменить присланную картинку: добавить/убрать/заменить по описанию.
export async function editImage(cfg, src, prompt) {
  const form = new FormData();
  form.append('model', cfg.imageModel);
  form.append('prompt', prompt);
  form.append('n', '1');
  form.append('image', new InputFile(src.bytes, `image.${EXT[src.mime] ?? 'png'}`, { type: src.mime }));
  const res = await fetch(`${cfg.baseUrl}/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body: form,
  });
  return parseImage(res);
}

// ── Отправка результата ──────────────────────────────────────────────────

const PHOTO_LIMIT = 10 * 1024 * 1024;

// Шлёт картинку в чат; → file_id отправленного (для следующих правок «добавь ещё…»).
export async function sendImage(msg, { bytes, mime }) {
  const params = { chat_id: msg.chat.id };
  if (msg.is_topic_message && msg.message_thread_id) params.message_thread_id = msg.message_thread_id;
  const file = new InputFile(bytes, `image.${EXT[mime] ?? 'png'}`, { type: mime });

  if (bytes.length <= PHOTO_LIMIT) {
    const sent = await api.sendPhoto({ ...params, photo: file });
    return sent?.photo?.[sent.photo.length - 1]?.file_id ?? null;
  }
  const sent = await api.sendDocument({ ...params, document: file });   // слишком тяжёлая для фото
  return sent?.document?.file_id ?? null;
}
