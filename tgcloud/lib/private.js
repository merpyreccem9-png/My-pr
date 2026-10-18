// Личные сообщения: команды, ввод из меню, ИИ-диалог.

import { api, db } from 'sdk';
import { users, chats, history } from '../schema.js';
import { esc, maskKey } from './fmt.js';
import { splitCommand, parseGender } from './parse.js';
import { say, sayMarkdown, typing } from './tg.js';
import { touchUser, patchUser, botUsername } from './store.js';
import {
  AiError, askAi, checkQuota, getAiConfig, setAiConfig, addFact, forgetFact, clearHistory,
} from './ai.js';
import { homeScreen, helpScreen, rpList, personaScreen, memScreen } from './menu.js';
import { isOwner } from './config.js';

export async function handlePrivate(msg) {
  if (!msg.from || msg.from.is_bot) return;
  const user = await touchUser(msg.from);
  const text = msg.text;

  if (!text) {
    return void (await say(msg, 'Пока я понимаю только текст. Напишите словами 🙂'));
  }

  const cmd = text.startsWith('/') ? splitCommand(text) : null;
  if (cmd) return runCommand(msg, user, cmd);

  if (user.awaiting) return handleAwaiting(msg, user, text);
  return chat(msg, user, text);
}

// ── ИИ-диалог ────────────────────────────────────────────────────────────

export async function chat(msg, user, input) {
  try {
    await checkQuota(user.tgId);
    typing(msg);
    const out = await askAi({
      userId: user.tgId, name: user.name, persona: user.persona, input, useMemory: user.aiMemory !== false,
    });
    await sayMarkdown(msg, out.text, { reply: false });
    await out.commit();
  } catch (e) {
    await aiFailure(msg, user, e);
  }
}

export async function aiFailure(msg, user, e) {
  if (!(e instanceof AiError)) throw e;
  if (e.code === 'not_configured') {
    return void (await say(msg, isOwner(user.tgId)
      ? '⚙️ ИИ не настроен. Выполните:\n<code>/setai https://api.openai.com/v1 gpt-4o-mini</code>\n<code>/setkey ВАШ_КЛЮЧ</code>'
      : '🤖 ИИ пока не подключён владельцем бота.'));
  }
  if (e.code === 'quota') {
    return void (await say(msg, `⏳ Дневной лимит ИИ-запросов (${e.detail}) исчерпан. Попробуйте завтра.`));
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
    case 'aistatus': {
      const cfg = await getAiConfig();
      await say(msg, cfg
        ? `🤖 ИИ подключён\nURL: <code>${esc(cfg.baseUrl)}</code>\nМодель: <code>${esc(cfg.model)}</code>\nКлюч: <code>${esc(maskKey(cfg.apiKey))}</code>`
        : '🤖 ИИ не настроен: нужны /setai и /setkey.');
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
