// Отправить сообщение (или «Заново / Короче / Подробнее»). Ход работы пишется в kv — клиент читает его через poll.
import { EndpointError } from 'sdk';
import { askAi, checkQuota, getAiConfig, AiError, lastKey } from '../lib/ai.js';
import { generateImage, editImage, sendTextFile, b64ToBytes, toDataUrl } from '../lib/media.js';
import { AI_IMAGE_QUOTA_COST } from '../lib/config.js';
import { logAi } from '../lib/stats.js';
import { kvGetMany, kvSet } from '../lib/store.js';
import { appUser, loadRun, saveRun, publicRun, appError, attachments, withFiles, imgKey } from '../lib/webapp.js';

const MODES = new Set(['short', 'long']);
const SAVE_EVERY_MS = 450;     // не чаще — это запись в базу
const STALE_RUN_MS = 6 * 60 * 1000;

export default async function (input, ctx) {
  const { tg, user } = await appUser(ctx);
  const mode = MODES.has(input.mode) ? input.mode : null;
  const regen = input.regen === true || Boolean(mode);

  const { images, files } = regen ? { images: [], files: [] } : attachments(input);
  let text = String(input.text ?? '').trim().slice(0, 4000);
  if (!text && !regen && images.length) text = 'Посмотри на картинку и расскажи, что на ней.';
  if (!text && !regen && files.length) text = 'Посмотри файл и коротко расскажи, что в нём.';
  if (files.length) text = withFiles(text, files);
  if (regen) {
    try { text = JSON.parse((await kvGetMany([lastKey(user.tgId)]))[lastKey(user.tgId)] ?? 'null')?.q ?? ''; } catch { text = ''; }
    if (!text) throw new EndpointError('Не нашёл прошлый вопрос — задайте его заново', { code: 'NO_LAST' });
  }
  if (!text) throw new EndpointError('Пустое сообщение', { code: 'EMPTY' });

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

    // Картинка по просьбе модели: рисуем/правим и кладём для клиента (он заберёт отдельным запросом).
    if (out.image) {
      await checkQuota(user.tgId, Math.max(0, AI_IMAGE_QUOTA_COST - 1));
      const cfg = await getAiConfig();
      if (!cfg) throw new AiError('not_configured');
      const editing = out.image.kind === 'edit' && images[0];
      const step = { k: 'tool', id: 'img', name: editing ? 'edit_image' : 'generate_image', label: editing ? 'Правлю картинку…' : 'Рисую картинку…', args: { prompt: out.image.prompt }, state: 'run' };
      run.trace = [...out.trace, step];
      await save(true);
      const t0 = Date.now();
      const src = editing ? { bytes: b64ToBytes(images[0].split(',')[1]), mime: images[0].slice(5, images[0].indexOf(';')) } : null;
      const result = editing ? await editImage(cfg, src, out.image.prompt) : await generateImage(cfg, out.image.prompt, out.image.size);
      await kvSet(imgKey(user.tgId), JSON.stringify({ runId: run.id, dataUrl: toDataUrl(result.bytes, result.mime) }));
      Object.assign(step, { state: 'ok', ms: Date.now() - t0, out: `${Math.round(result.bytes.length / 1024)} КБ` });
      run.image = { id: run.id, mime: result.mime, kb: Math.round(result.bytes.length / 1024) };
      await logAi({ from: tg, kind: editing ? 'img-edit' : 'img-gen', input: out.image.prompt, model: cfg.imageModel });
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
  }
}
