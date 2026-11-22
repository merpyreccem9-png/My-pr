// Отправить нарисованную картинку в чат с ботом: как фото или как файл (без сжатия).
import { api, InputFile, EndpointError } from 'sdk';
import { kvGetMany } from '../lib/store.js';
import { b64ToBytes, sniffMime } from '../lib/media.js';
import { appUser, imgKey } from '../lib/webapp.js';

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const PHOTO_LIMIT = 10 * 1024 * 1024;

export default async function (input, ctx) {
  const { user } = await appUser(ctx);
  let rec = null;
  try { rec = JSON.parse((await kvGetMany([imgKey(user.tgId)]))[imgKey(user.tgId)] || 'null'); } catch { /* повреждено */ }
  if (!rec) throw new EndpointError('Картинка уже недоступна — нарисуйте заново', { code: 'GONE' });
  const bytes = b64ToBytes(rec.dataUrl.split(',')[1]);
  const mime = sniffMime(bytes);
  const file = new InputFile(bytes, `image.${EXT[mime] ?? 'png'}`, { type: mime });
  if (input.as === 'document' || bytes.length > PHOTO_LIMIT) await api.sendDocument({ chat_id: user.tgId, document: file });
  else await api.sendPhoto({ chat_id: user.tgId, photo: file });
  return { ok: true };
}
