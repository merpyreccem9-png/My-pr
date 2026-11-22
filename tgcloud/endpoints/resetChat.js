// «Новый чат»: сбросить диалог (факты о пользователе остаются).
import { clearHistory, lastKey } from '../lib/ai.js';
import { kvSet } from '../lib/store.js';
import { appUser } from '../lib/webapp.js';

export default async function (input, ctx) {
  const { user } = await appUser(ctx);
  await clearHistory(user.tgId);
  await kvSet(lastKey(user.tgId), '');
  return { ok: true };
}
