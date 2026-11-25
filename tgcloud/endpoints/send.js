// Отправить сообщение (или «Заново / Короче / Подробнее»). Ход работы пишется в kv — клиент читает его через poll.
import { EndpointError } from 'sdk';
import { askAi, checkQuota, getAiConfig, AiError, lastKey } from '../lib/ai.js';
import { sendTextFile } from '../lib/media.js';
import { logAi } from '../lib/stats.js';
import { kvGetMany, kvSet } from '../lib/store.js';
import { appUser, loadRun, saveRun, publicRun, appError, attachments, withFiles, recentAppImage, rememberAppImage, isStale } from '../lib/webapp.js';

const MODES = new Set(['short', 'long']);
const SAVE_EVERY_MS = 450;     // не чаще — это запись в базу

export default async function (input, ctx) {
  const { tg, user } = await appUser(ctx);
  const mode = MODES.has(input.mode) ? input.mode : null;
  const regen = input.regen === true || Boolean(mode);

  const att = regen ? { images: [], files: [] } : attachments(input);
  const files = att.files;
  // Нет новой картинки — берём последнюю (прикреплённую или нарисованную): так работает «сделай ярче», «добавь шляпу».
  const recent = !regen && !att.images.length ? await recentAppImage(user.tgId) : null;
  const images = att.images.length ? att.images : recent ? [recent.dataUrl] : [];
  let text = String(input.text ?? '').trim().slice(0, 4000);
  if (!text && !regen && att.images.length) text = 'Посмотри на картинку и расскажи, что на ней.';
  if (!text && !regen && files.length) text = 'Посмотри файл и коротко расскажи, что в нём.';
  if (files.length) text = withFiles(text, files);
  if (regen) {
    try { text = JSON.parse((await kvGetMany([lastKey(user.tgId)]))[lastKey(user.tgId)] ?? 'null')?.q ?? ''; } catch { text = ''; }
    if (!text) throw new EndpointError('Не нашёл прошлый вопрос — задайте его заново', { code: 'NO_LAST' });
  }
  if (!text) throw new EndpointError('Пустое сообщение', { code: 'EMPTY' });

  // Один запрос за раз: параллельные писали бы в одну историю.
  const prev = await loadRun(user.tgId);
  if (prev && !prev.done && !isStale(prev) && input.force !== true) {   // force — «я остановил, пишу заново»
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

  // «Пульс»: пока модель думает молча, раз в 20 с отмечаем, что запрос жив (иначе его сочтут зависшим).
  const beat = typeof setInterval === 'function' ? setInterval(() => { save(true).catch(() => {}); }, 20_000) : null;

  try {
    await checkQuota(user.tgId);
    if (!(await getAiConfig())) throw new AiError('not_configured');
    await save(true);
    if (att.images.length) await rememberAppImage(user.tgId, 'att', att.images[0]);   // прикреплённое фото — тоже «текущая» картинка

    const out = await askAi({
      userId: user.tgId, name: user.name, persona: user.persona, input: text, useMemory: user.aiMemory !== false,
      canImage: true, canFile: true, images,
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
    Object.assign(run, { text: out.text, trace: out.trace, live: '', model: out.model });

    // Картинка по просьбе модели: здесь только решение «рисовать». Саму генерацию делает отдельный запрос makeImage
    // (у него свой запас времени), поэтому долгая картинка не обрывает ответ и не оставляет приложение «в процессе».
    if (out.image) {
      const editing = out.image.kind === 'edit' && images[0];
      Object.assign(run, {
        pending: { kind: editing ? 'edit' : 'generate', prompt: out.image.prompt, size: out.image.size ?? null },
        trace: [...out.trace, { k: 'tool', id: 'img', name: editing ? 'edit_image' : 'generate_image', label: editing ? 'Правлю картинку…' : 'Рисую картинку…', args: { prompt: out.image.prompt }, state: 'run' }],
      });
      await kvSet(lastKey(user.tgId), JSON.stringify({ q: text }));
      await out.commit();
      await save(true);
      return publicRun(run);   // done:false — клиент сразу вызовет makeImage и продолжит читать прогресс
    }

    // Файл-документ: отправляем в чат с ботом (оттуда его можно открыть/переслать), текст отдаём и приложению.
    if (out.file) {
      const step = { k: 'tool', id: 'file', name: 'create_file', label: `Файл ${out.file.name}`, args: { filename: out.file.name }, state: 'run' };
      run.trace = [...run.trace, step];
      const t0 = Date.now();
      let sent = true;
      let size = out.file.content.length;
      try { size = (await sendTextFile(user.tgId, out.file)).size; } catch (e) { sent = false; console.warn('sendDocument failed', e?.description ?? e); }
      Object.assign(step, { state: sent ? 'ok' : 'err', ms: Date.now() - t0, out: sent ? 'отправлен в чат' : 'не удалось отправить в чат' });
      run.files = [{ name: out.file.name, size, sent, text: out.file.content.length <= 40_000 ? out.file.content : null }];
      await logAi({ from: tg, kind: 'file', input: out.file.name, model: out.model });
    }

    Object.assign(run, { done: true, ms: Date.now() - run.t0 });
    if (out.text || out.image || out.file) await kvSet(lastKey(user.tgId), JSON.stringify({ q: text }));
    await out.commit();
    await save(true);
    return publicRun(run);
  } catch (e) {
    const mapped = appError(e, user.tgId);
    Object.assign(run, { done: true, live: '', ms: Date.now() - run.t0, error: mapped ? mapped[0] : 'Что-то пошло не так. Попробуйте ещё раз.' });
    await save(true).catch(() => {});
    if (!mapped) throw e;
    throw new EndpointError(mapped[0], { code: mapped[1] });
  } finally {
    if (beat) clearInterval(beat);
  }
}
