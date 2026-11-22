// Отправить сообщение (или «Заново / Короче / Подробнее»). Ход работы пишется в kv — клиент читает его через poll.
import { EndpointError } from 'sdk';
import { askAi, checkQuota, getAiConfig, AiError, lastKey } from '../lib/ai.js';
import { logAi } from '../lib/stats.js';
import { kvGetMany, kvSet } from '../lib/store.js';
import { appUser, loadRun, saveRun, publicRun, appError } from '../lib/webapp.js';

const MODES = new Set(['short', 'long']);
const SAVE_EVERY_MS = 450;     // не чаще — это запись в базу
const STALE_RUN_MS = 6 * 60 * 1000;

export default async function (input, ctx) {
  const { tg, user } = await appUser(ctx);
  const mode = MODES.has(input.mode) ? input.mode : null;
  const regen = input.regen === true || Boolean(mode);

  let text = String(input.text ?? '').trim();
  if (regen) {
    try { text = JSON.parse((await kvGetMany([lastKey(user.tgId)]))[lastKey(user.tgId)] ?? 'null')?.q ?? ''; } catch { text = ''; }
    if (!text) throw new EndpointError('Не нашёл прошлый вопрос — задайте его заново', { code: 'NO_LAST' });
  }
  if (!text) throw new EndpointError('Пустое сообщение', { code: 'EMPTY' });
  text = text.slice(0, 4000);

  // Один запрос за раз: параллельные писали бы в одну историю.
  const prev = await loadRun(user.tgId);
  if (prev && !prev.done && Date.now() - prev.t0 < STALE_RUN_MS) {
    throw new EndpointError('Предыдущий ответ ещё готовится', { code: 'BUSY' });
  }

  const run = { id: String(input.runId || Date.now()).slice(0, 40), t0: Date.now(), text: '', live: '', trace: [], done: false, error: null };
  let savedAt = 0;
  const save = async (force = false) => {
    const now = Date.now();
    if (!force && now - savedAt < SAVE_EVERY_MS) return;
    savedAt = now;
    await saveRun(user.tgId, run);
  };

  try {
    await checkQuota(user.tgId);
    if (!(await getAiConfig())) throw new AiError('not_configured');
    await save(true);

    const out = await askAi({
      userId: user.tgId, name: user.name, persona: user.persona, input: text, useMemory: user.aiMemory !== false,
      canImage: false,        // в приложении пока без картинок
      github: true, thinkSummary: true, mode, replaceLast: regen,
      onText: async (t) => { run.text = t; await save(); },
      onTrace: async (e, trace) => {
        run.trace = trace;
        if (e.k === 'think_live') run.live = e.t;
        else if (e.k === 'think') run.live = '';
        await save();
      },
    });
    await logAi({ from: tg, kind: 'app', input: text, model: out.model, usage: out.usage });
    Object.assign(run, { text: out.text, trace: out.trace, live: '', done: true, ms: Date.now() - run.t0, model: out.model });
    if (out.text) await kvSet(lastKey(user.tgId), JSON.stringify({ q: text }));
    await out.commit();
    await save(true);
    return publicRun(run);
  } catch (e) {
    const mapped = appError(e, user.tgId);
    Object.assign(run, { done: true, live: '', ms: Date.now() - run.t0, error: mapped ? mapped[0] : 'Что-то пошло не так. Попробуйте ещё раз.' });
    await save(true).catch(() => {});
    if (!mapped) throw e;
    throw new EndpointError(mapped[0], { code: mapped[1] });
  }
}
