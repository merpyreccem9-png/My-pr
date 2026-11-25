// Второй этап «нарисуй/измени»: send решил, что нужна картинка, а рисует её этот запрос (со своим запасом времени).
// Результат: в чат с ботом (фото) + в приложение (лёгкий JPEG), текущая картинка запоминается для следующих правок.
import { EndpointError } from 'sdk';
import { checkQuota, getAiConfig, AiError } from '../lib/ai.js';
import { generateImage, editImage, sendImage, b64ToBytes, toDataUrl } from '../lib/media.js';
import { AI_IMAGE_QUOTA_COST } from '../lib/config.js';
import { logAi } from '../lib/stats.js';
import { appUser, loadRun, saveRun, publicRun, appError, recentAppImage, rememberAppImage } from '../lib/webapp.js';

const RESTART_AFTER_MS = 170_000;   // раньше этого второй вызов не запускает вторую генерацию — отдаёт текущее состояние

export default async function (input, ctx) {
  const { tg, user } = await appUser(ctx);
  const run = await loadRun(user.tgId);
  if (!run || (input.runId && run.id !== String(input.runId)) || (!run.pending && !run.image)) {
    throw new EndpointError('Картинку рисовать не нужно', { code: 'NO_PENDING' });
  }
  if (run.image || run.done) return publicRun(run);                       // уже готово (или остановлено)
  if (run.imageStarted && Date.now() - run.imageStarted < RESTART_AFTER_MS) return publicRun(run);   // уже рисуется

  run.imageStarted = Date.now();
  await saveRun(user.tgId, run);
  const step = run.trace.find((x) => x.id === 'img') ?? { k: 'tool', id: 'img', name: 'generate_image', label: 'Рисую картинку…', state: 'run' };
  if (!run.trace.includes(step)) run.trace.push(step);

  const beat = typeof setInterval === 'function' ? setInterval(() => { saveRun(user.tgId, run).catch(() => {}); }, 20_000) : null;   // «пульс» на время генерации
  try {
    await checkQuota(user.tgId, Math.max(0, AI_IMAGE_QUOTA_COST - 1));   // 1 запрос уже списан за текст
    const cfg = await getAiConfig();
    if (!cfg) throw new AiError('not_configured');
    const { kind, prompt, size } = run.pending;
    const rec = kind === 'edit' ? await recentAppImage(user.tgId) : null;
    const src = rec ? { bytes: b64ToBytes(rec.dataUrl.split(',')[1]), mime: rec.dataUrl.slice(5, rec.dataUrl.indexOf(';')) } : null;

    const t0 = Date.now();
    const result = src ? await editImage(cfg, src, prompt, { compact: true }) : await generateImage(cfg, prompt, size ?? 'auto', { compact: true });
    // Сначала в чат — самый надёжный путь, придёт даже если приложение закрыли.
    let sent = true;
    try { await sendImage({ chat: { id: user.tgId } }, result); } catch (e) { sent = false; console.warn('sendPhoto failed', e?.description ?? e); }
    await rememberAppImage(user.tgId, run.id, toDataUrl(result.bytes, result.mime));

    const kb = Math.round(result.bytes.length / 1024);
    Object.assign(step, { name: src ? 'edit_image' : 'generate_image', state: 'ok', ms: Date.now() - t0, out: `${kb} КБ${sent ? ' · отправлено в чат' : ''}` });
    Object.assign(run, { image: { id: run.id, mime: result.mime, kb, sent }, pending: null, done: true, live: '', ms: Date.now() - run.t0 });
    await logAi({ from: tg, kind: src ? 'img-edit' : 'img-gen', input: prompt, model: cfg.imageModel });
    await saveRun(user.tgId, run);
    return publicRun(run);
  } catch (e) {
    const mapped = appError(e, user.tgId);
    Object.assign(step, { state: 'err', out: mapped ? mapped[0] : 'ошибка' });
    Object.assign(run, { pending: null, done: true, live: '', ms: Date.now() - run.t0, error: mapped ? mapped[0] : 'Не получилось нарисовать. Попробуйте ещё раз.' });
    await saveRun(user.tgId, run).catch(() => {});
    if (!mapped) throw e;
    throw new EndpointError(mapped[0], { code: mapped[1] });
  } finally {
    if (beat) clearInterval(beat);
  }
}
