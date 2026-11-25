// «Стоп»: закрыть текущий запуск, чтобы приложение не ждало и можно было писать дальше.
import { appUser, loadRun, saveRun } from '../lib/webapp.js';

export default async function (input, ctx) {
  const { user } = await appUser(ctx);
  const run = await loadRun(user.tgId);
  if (run && !run.done && (!input.runId || run.id === String(input.runId))) {
    Object.assign(run, { done: true, pending: null, live: '', ms: Date.now() - run.t0, error: 'Остановлено' });
    await saveRun(user.tgId, run);
  }
  return { ok: true };
}
