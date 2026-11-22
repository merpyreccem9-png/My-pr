// Забрать нарисованную картинку (dataURL) — отдельным запросом, чтобы не раздувать прогресс запроса.
import { EndpointError } from 'sdk';
import { kvGetMany } from '../lib/store.js';
import { appUser, imgKey } from '../lib/webapp.js';

export default async function (input, ctx) {
  const { user } = await appUser(ctx);
  let rec = null;
  try { rec = JSON.parse((await kvGetMany([imgKey(user.tgId)]))[imgKey(user.tgId)] || 'null'); } catch { /* повреждено */ }
  if (!rec || (input.runId && rec.runId !== String(input.runId))) throw new EndpointError('Картинка уже недоступна — нарисуйте заново', { code: 'GONE' });
  return { dataUrl: rec.dataUrl };
}
