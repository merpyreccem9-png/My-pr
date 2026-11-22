// Прогресс текущего (или только что завершённого) запроса: текст, «мысли», команды.
import { appUser, loadRun, publicRun } from '../lib/webapp.js';

export default async function (input, ctx) {
  const { user } = await appUser(ctx);
  const run = await loadRun(user.tgId);
  if (!run || (input.runId && run.id !== String(input.runId))) return { run: null };
  return { run: publicRun(run) };
}
