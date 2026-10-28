// Личные сообщения: команды, ввод из меню, ИИ-диалог.

import { api, db } from 'sdk';
import { users, chats, history } from '../schema.js';
import { esc, maskKey } from './fmt.js';
import { splitCommand, parseGender } from './parse.js';
import { say, sayMarkdown, typing, withStatus } from './tg.js';
import { touchUser, patchUser, botUsername, kvGetMany, kvSet } from './store.js';
import {
  AiError, askAi, checkQuota, getAiConfig, setAiConfig, normEffort, addFact, forgetFact, clearHistory,
} from './ai.js';
import { logAi, statsText, logText, userText } from './stats.js';
import {
  pickMedia, loadImage, downloadFile, toDataUrl, transcribe, generateImage, editImage, sendImage,
} from './media.js';
import { homeScreen, helpScreen, rpList, personaScreen, memScreen } from './menu.js';
import { isOwner, AI_IMAGE_QUOTA_COST, AI_IMAGE_TTL, AI_MAX_AUDIO_SEC } from './config.js';

export async function handlePrivate(msg) {
  if (!msg.from || msg.from.is_bot) return;
  const user = await touchUser(msg.from);
  const text = msg.text;

  if (!text) {
    const media = pickMedia(msg);
    if (!media) return void (await say(msg, 'Я понимаю текст, 📷 картинки и 🎤 голосовые. Остальное пока не умею 🙂'));
    return media.kind === 'image' ? handleImage(msg, user, media) : handleAudio(msg, user, media);
  }

  const cmd = text.startsWith('/') ? splitCommand(text) : null;
  if (cmd) return runCommand(msg, user, cmd);

  if (user.awaiting) return handleAwaiting(msg, user, text);
  return chat(msg, user, text);
}

// ── ИИ-диалог ────────────────────────────────────────────────────────────

const nowSec = () => Math.floor(Date.now() / 1000);

// Последняя картинка живёт в kv (`img.<id>` = "file_id|unix-секунды"), а не в таблице users —
// так деплой не требует миграции базы.
const imgKey = (userId) => `img.${userId}`;

// file_id последней картинки, если она ещё «свежая».
async function recentImage(user) {
  const raw = (await kvGetMany([imgKey(user.tgId)]))[imgKey(user.tgId)];
  if (!raw) return null;
  const [fileId, at] = raw.split('|');
  return fileId && nowSec() - Number(at) < AI_IMAGE_TTL ? fileId : null;
}

const rememberImage = (userId, fileId) => kvSet(imgKey(userId), fileId ? `${fileId}|${nowSec()}` : '');

// Статус «💭 Думаю…» на время работы: на xhigh модель думает долго, и без него кажется, что бот завис.
// Сообщение удаляется, когда ответ отправлен (или произошла ошибка). Голосовые передают свой статус дальше.
const inStatus = async (msg, existing, text, fn) => {
  if (!existing) return withStatus(msg, text, fn);
  await existing(text);
  return fn(existing);
};

// opts.imageId — картинка, присланная прямо сейчас; opts.skipQuota — лимит уже списан (голосовые);
// opts.status — уже показанный статус (setStatus из withStatus).
export async function chat(msg, user, input, { imageId = null, skipQuota = false, kind = 'text', status = null } = {}) {
  try {
    if (!skipQuota) await checkQuota(user.tgId);
    if (!(await getAiConfig())) throw new AiError('not_configured');   // не мигаем статусом перед ошибкой
    await inStatus(msg, status, '💭 Думаю…', async (setStatus) => {
      typing(msg);

      // Картинка: присланная сейчас или недавно (для «добавь шляпу» отдельным сообщением).
      let src = null;
      if (imageId) src = await loadImage(imageId);
      else {
        const recent = await recentImage(user);
        if (recent) src = await loadImage(recent).catch(() => null);   // file_id мог протухнуть — не страшно
      }

      const out = await askAi({
        userId: user.tgId, name: user.name, persona: user.persona, input, useMemory: user.aiMemory !== false,
        images: src ? [toDataUrl(src.bytes, src.mime)] : [], canImage: true,
      });
      await logAi({ from: msg.from, kind, input, model: out.model, usage: out.usage });   // токены уже потрачены
      if (out.image) {
        if (out.text) await sayMarkdown(msg, out.text, { reply: false });
        await produceImage(msg, user, out.image, src, { setStatus });
      } else {
        await sayMarkdown(msg, out.text, { reply: false });
      }
      await out.commit();
    });
  } catch (e) {
    await aiFailure(msg, user, e);
  }
}

// Рисует/правит картинку и отправляет её. Картинка стоит AI_IMAGE_QUOTA_COST запросов (1 уже списан за текст).
async function produceImage(msg, user, req, src, { charged = 1, setStatus = null } = {}) {
  await checkQuota(user.tgId, Math.max(0, AI_IMAGE_QUOTA_COST - charged));
  const cfg = await getAiConfig();
  if (!cfg) throw new AiError('not_configured');
  const editing = req.kind === 'edit' && src;
  await setStatus?.(editing ? '🖌 Правлю картинку…' : '🎨 Рисую картинку…');
  typing(msg, 'upload_photo');
  const result = editing
    ? await editImage(cfg, src, req.prompt)
    : await generateImage(cfg, req.prompt, req.size);
  const fileId = await sendImage(msg, result);
  await rememberImage(user.tgId, fileId);
  await logAi({ from: msg.from, kind: editing ? 'img-edit' : 'img-gen', input: req.prompt, model: cfg.imageModel });
}

// ── Картинка от пользователя ─────────────────────────────────────────────

async function handleImage(msg, user, media) {
  const caption = (msg.caption ?? '').trim();
  if (!caption) {
    // Без подписи ждём, что с ней сделать (следующее сообщение или /edit).
    await rememberImage(user.tgId, media.fileId);
    return void (await say(msg,
      '📷 Принял. Напишите, что сделать: спросить про неё, добавить или убрать что-то. ' +
      `Картинка доступна ${Math.round(AI_IMAGE_TTL / 60)} мин.`));
  }
  await rememberImage(user.tgId, media.fileId);
  return chat(msg, user, caption, { imageId: media.fileId, kind: 'photo' });
}

// ── Голосовые: распознаём и отвечаем как на текст ───────────────────────────

async function handleAudio(msg, user, media) {
  try {
    if (media.duration && media.duration > AI_MAX_AUDIO_SEC) throw new AiError('too_long');
    await checkQuota(user.tgId);
    const cfg = await getAiConfig();
    if (!cfg) throw new AiError('not_configured');
    await withStatus(msg, '🎤 Слушаю…', async (setStatus) => {
      typing(msg);
      const bytes = await downloadFile(media.fileId, media.size);
      const text = await transcribe(cfg, bytes, { filename: media.name, type: media.mime });
      if (!text) return void (await say(msg, '🎤 Не удалось разобрать речь. Попробуйте записать ещё раз.'));
      await say(msg, `🎤 <i>${esc(text.slice(0, 1000))}</i>`, { reply: false });
      await chat(msg, user, text, { skipQuota: true, kind: 'voice', status: setStatus });
    });
  } catch (e) {
    await aiFailure(msg, user, e);
  }
}

export async function aiFailure(msg, user, e) {
  if (!(e instanceof AiError)) throw e;
  if (e.code === 'not_configured') {
    return void (await say(msg, isOwner(user.tgId)
      ? '⚙️ ИИ не настроен. Достаточно ключа (модель gpt-6-luna, effort xhigh — по умолчанию):\n<code>/setkey ВАШ_КЛЮЧ</code>\nДругая модель: <code>/setai https://api.openai.com/v1 модель</code>'
      : '🤖 ИИ пока не подключён владельцем бота.'));
  }
  if (e.code === 'quota') {
    return void (await say(msg, `⏳ Дневной лимит ИИ-запросов (${e.detail}) исчерпан. Попробуйте завтра.`));
  }
  if (e.code === 'blocked') {
    return void (await say(msg, '🚫 Фильтр безопасности не пропустил этот запрос на картинку. Попробуйте описать иначе.'));
  }
  if (e.code === 'download') return void (await say(msg, '📥 Не получилось скачать файл из Telegram. Пришлите его ещё раз.'));
  if (e.code === 'too_big') return void (await say(msg, '📦 Файл слишком большой (лимит около 15 МБ).'));
  if (e.code === 'too_long') {
    return void (await say(msg, `⏱ Голосовое длиннее ${Math.round(AI_MAX_AUDIO_SEC / 60)} мин. Пришлите покороче.`));
  }
  console.error('ai failed', e.code, e.detail);
  await say(msg, isOwner(user.tgId)
    ? `⚠️ Ошибка ИИ (${esc(e.code)}): <code>${esc(e.detail.slice(0, 300))}</code>`
    : '⚠️ ИИ сейчас недоступен. Попробуйте позже.');
}

// ── Ввод, запрошенный из меню ────────────────────────────────────────────

async function handleAwaiting(msg, user, text) {
  await patchUser(user.tgId, { awaiting: null });
  if (user.awaiting === 'fact') {
    const ok = await addFact(user.tgId, text);
    return void (await say(msg, ok ? '🧠 Запомнил.' : 'ℹ️ Такой факт уже есть или он слишком короткий.'));
  }
  if (user.awaiting === 'persona') {
    await patchUser(user.tgId, { persona: text.slice(0, 500) });
    return void (await say(msg, '🎭 Персона обновлена. Новый диалог начнётся с этим стилем.'));
  }
}

// ── Команды ──────────────────────────────────────────────────────────────

const arg = (cmd) => cmd.args.trim();

async function runCommand(msg, user, cmd) {
  if (cmd.at && cmd.at !== (await botUsername())) return;

  switch (cmd.word) {
    case 'start': {
      if (cmd.args === 'rp') return void (await say(msg, rpList()));
      const s = await homeScreen(user);
      return void (await say(msg, s.text, { reply_markup: s.kb }));
    }
    case 'menu': {
      const s = await homeScreen(user);
      return void (await say(msg, s.text, { reply_markup: s.kb }));
    }
    case 'help': {
      const s = helpScreen();
      return void (await say(msg, s.text, { reply_markup: s.kb }));
    }
    case 'rp':
      return void (await say(msg, rpList()));
    case 'id':
      return void (await say(msg, `🆔 Ваш ID: <code>${user.tgId}</code>`));
    case 'new':
    case 'reset':
      await clearHistory(user.tgId);
      await rememberImage(user.tgId, null);
      return void (await say(msg, '🆕 Диалог сброшен. Факты о вас остались в памяти.'));
    case 'cancel':
      await patchUser(user.tgId, { awaiting: null });
      return void (await say(msg, 'Отменено.'));
    case 'memory': {
      const s = await memScreen(user);
      return void (await say(msg, s.text, { reply_markup: s.kb }));
    }
    case 'remember': {
      if (!arg(cmd)) return void (await say(msg, 'Использование: <code>/remember текст</code>'));
      const ok = await addFact(user.tgId, arg(cmd));
      return void (await say(msg, ok ? '🧠 Запомнил.' : 'ℹ️ Такой факт уже есть или он слишком короткий.'));
    }
    case 'forget': {
      const n = Number(arg(cmd));
      if (!Number.isInteger(n) || n < 1) return void (await say(msg, 'Использование: <code>/forget номер</code> (номера — в /memory)'));
      const gone = await forgetFact(user.tgId, n);
      return void (await say(msg, gone ? `🗑 Забыл: ${esc(gone)}` : 'ℹ️ Нет факта с таким номером.'));
    }
    case 'persona': {
      if (!arg(cmd)) {
        const s = await personaScreen(user);
        return void (await say(msg, s.text, { reply_markup: s.kb }));
      }
      const value = /^(reset|сброс)$/i.test(arg(cmd)) ? null : arg(cmd).slice(0, 500);
      await patchUser(user.tgId, { persona: value });
      return void (await say(msg, value ? '🎭 Персона обновлена.' : '♻️ Персона сброшена.'));
    }
    case 'gender':
    case 'пол': {
      const g = parseGender(arg(cmd));
      if (g === undefined) return void (await say(msg, 'Использование: <code>/gender м</code>, <code>/gender ж</code> или <code>/gender -</code>'));
      await patchUser(user.tgId, { gender: g });
      return void (await say(msg, '✅ Сохранено.'));
    }
    case 'img':
    case 'draw':
    case 'рисуй': {
      if (!arg(cmd)) return void (await say(msg, 'Использование: <code>/img описание картинки</code>'));
      return imageCommand(msg, user, { kind: 'generate', prompt: arg(cmd).slice(0, 4000), size: 'auto' });
    }
    case 'edit': {
      if (!arg(cmd)) return void (await say(msg, 'Использование: <code>/edit что изменить</code> — после того как пришлёте картинку.'));
      if (!(await recentImage(user))) return void (await say(msg, '📷 Сначала пришлите картинку (она хранится несколько минут).'));
      return imageCommand(msg, user, { kind: 'edit', prompt: arg(cmd).slice(0, 4000), size: 'auto' });
    }
    case 'ai':
    case 'ии': {
      if (!arg(cmd)) return void (await say(msg, 'Просто напишите вопрос обычным сообщением 🙂'));
      return chat(msg, user, arg(cmd));
    }
    default:
      if (isOwner(user.tgId)) {
        const handled = await ownerCommand(msg, user, cmd);
        if (handled) return;
      }
      return void (await say(msg, 'Не знаю такую команду. Откройте /menu или /help.'));
  }
}

// /img и /edit: напрямую, без раздумий модели (быстрее и дешевле).
async function imageCommand(msg, user, req) {
  try {
    await checkQuota(user.tgId, AI_IMAGE_QUOTA_COST);
    const src = req.kind === 'edit' ? await loadImage(await recentImage(user)) : null;
    await withStatus(msg, '🎨 Рисую картинку…', (setStatus) =>
      produceImage(msg, user, req, src, { charged: AI_IMAGE_QUOTA_COST, setStatus }));
  } catch (e) {
    await aiFailure(msg, user, e);
  }
}

// ── Команды владельца ────────────────────────────────────────────────────

async function ownerCommand(msg, user, cmd) {
  switch (cmd.word) {
    case 'setai': {
      const [url, model] = cmd.args.split(/\s+/);
      if (!/^https:\/\/\S+$/.test(url ?? '') || !model) {
        await say(msg, 'Использование: <code>/setai https://api.openai.com/v1 gpt-4o-mini</code>\n' +
          'Подойдёт любой OpenAI-совместимый API (путь до /chat/completions добавлю сам).');
        return true;
      }
      await setAiConfig({ baseUrl: url, model });
      await say(msg, '✅ Адрес и модель сохранены. Теперь ключ: <code>/setkey КЛЮЧ</code>');
      return true;
    }
    case 'setkey': {
      if (!cmd.args) { await say(msg, 'Использование: <code>/setkey КЛЮЧ</code>'); return true; }
      await setAiConfig({ apiKey: cmd.args.trim() });
      // Ключ не должен оставаться в истории чата.
      await api.deleteMessage({ chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => {});
      await say(msg, '🔑 Ключ сохранён, ваше сообщение с ключом удалено.');
      return true;
    }
    case 'stats':
    case 'log':
    case 'user': {
      const out = cmd.word === 'stats' ? await statsText()
        : cmd.word === 'log' ? await logText(Number(cmd.args) || 15)
          : await userText(cmd.args);
      await say(msg, out ?? '⚠️ Журнал ещё не создан. Выполните <code>npx tgcloud migrate</code> и повторите.');
      return true;
    }
    case 'seteffort': {
      const v = cmd.args.trim().toLowerCase();
      if (/^(off|выкл|сброс)$/.test(v)) {
        await setAiConfig({ effort: 'off' });
        await say(msg, '✅ Рассуждение выключено: параметр reasoning_effort не отправляется.');
        return true;
      }
      const e = normEffort(v);
      if (!e) {
        await say(msg, 'Использование: <code>/seteffort extra</code>\nЗначения: none, minimal, low, medium, high, <b>xhigh</b> (= extra), max, off.');
        return true;
      }
      await setAiConfig({ effort: e });
      await say(msg, `✅ Effort: <code>${e}</code>`);
      return true;
    }
    case 'setimage': {
      if (!cmd.args.trim()) { await say(msg, 'Использование: <code>/setimage gpt-image-2</code>'); return true; }
      await setAiConfig({ imageModel: cmd.args.trim() });
      await say(msg, '✅ Модель картинок сохранена.');
      return true;
    }
    case 'setstt': {
      if (!cmd.args.trim()) { await say(msg, 'Использование: <code>/setstt gpt-transcribe</code>'); return true; }
      await setAiConfig({ sttModel: cmd.args.trim() });
      await say(msg, '✅ Модель распознавания голоса сохранена.');
      return true;
    }
    case 'aistatus': {
      const cfg = await getAiConfig();
      await say(msg, cfg
        ? `🤖 ИИ подключён\nURL: <code>${esc(cfg.baseUrl)}</code>\nМодель: <code>${esc(cfg.model)}</code>\nEffort: <code>${cfg.effort ?? 'выкл'}</code>\n` +
          `Картинки: <code>${esc(cfg.imageModel)}</code>\nГолос: <code>${esc(cfg.sttModel)}</code>\nКлюч: <code>${esc(maskKey(cfg.apiKey))}</code>`
        : '🤖 ИИ не настроен: нужен /setkey.');
      return true;
    }
    case 'stats': {
      const [u, c, h] = await Promise.all([db.$count(users), db.$count(chats), db.$count(history)]);
      await say(msg, `📊 Пользователей: <b>${u}</b>\nГрупп: <b>${c}</b>\nСообщений в памяти ИИ: <b>${h}</b>`);
      return true;
    }
    default:
      return false;
  }
}
