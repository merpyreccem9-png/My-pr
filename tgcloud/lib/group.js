// Сообщения в группах: диспетчер команд, РП, приветствие, антиссылки.
// Быстрый путь: обычная болтовня отсеивается строковыми проверками, без обращения к базе.

import { api } from 'sdk';
import { esc, mention } from './fmt.js';
import { splitCommand, parseGender } from './parse.js';
import { RP_BY_WORD, renderRp } from './rp.js';
import { say, sayMarkdown, typing, fail } from './tg.js';
import { touchUser, patchUser, getChat, setChat, botUsername } from './store.js';
import { isAdminMsg } from './admin.js';
import { actorOf } from './actor.js';
import { realReply } from './target.js';
import { showSettings } from './settings.js';
import { HELP_GROUP, rpList } from './menu.js';
import { AiError, askAi, checkQuota } from './ai.js';
import { aiFailure } from './private.js';
import * as mod from './mod.js';

const DEFAULT_WELCOME = '👋 Добро пожаловать, {name}!\nЗагляните в /rules и чувствуйте себя как дома.';

// admin: undefined — команда для всех · null — любой админ · 'can_…' — конкретное право
// plain: можно без «/» (только ответом на сообщение)
const COMMANDS = new Map();
const reg = (names, def) => names.forEach((n) => COMMANDS.set(n, def));

reg(['mute', 'мут', 'замутить'],        { fn: mod.mute,       admin: 'can_restrict_members', plain: true });
reg(['unmute', 'размут', 'размутить'],  { fn: mod.unmute,     admin: 'can_restrict_members', plain: true });
reg(['ban', 'бан', 'забанить'],         { fn: mod.ban,        admin: 'can_restrict_members', plain: true });
reg(['unban', 'разбан', 'разбанить'],   { fn: mod.unban,      admin: 'can_restrict_members', plain: true });
reg(['kick', 'кик', 'выгнать'],         { fn: mod.kick,       admin: 'can_restrict_members', plain: true });
reg(['warn', 'варн', 'пред'],           { fn: mod.warn,       admin: 'can_restrict_members', plain: true });
reg(['unwarn', 'анварн'],               { fn: mod.unwarn,     admin: 'can_restrict_members', plain: true });
reg(['resetwarns', 'сбросварнов'],      { fn: mod.resetWarns, admin: 'can_restrict_members' });
reg(['warns', 'варны', 'преды'],        { fn: mod.showWarns });
reg(['del', 'удалить'],                 { fn: mod.del,        admin: 'can_delete_messages', plain: true });
reg(['purge', 'чистка'],                { fn: mod.purge,      admin: 'can_delete_messages', plain: true });
reg(['pin', 'закрепить'],               { fn: mod.pin,        admin: 'can_pin_messages', plain: true });
reg(['unpin', 'открепить'],             { fn: mod.unpin,      admin: 'can_pin_messages', plain: true });

reg(['settings', 'настройки'], { fn: showSettings, admin: null });
reg(['setwelcome'],            { fn: setWelcome,   admin: null });
reg(['setrules'],              { fn: setRules,     admin: null });
reg(['rules', 'правила'],      { fn: showRules });
reg(['id', 'айди'],            { fn: showId });
reg(['gender', 'пол'],         { fn: setGender });
reg(['ai', 'ии'],              { fn: groupAi });
reg(['rp', 'рп'],              { fn: (msg) => say(msg, rpList()) });
reg(['help', 'помощь', 'команды'], { fn: (msg) => say(msg, HELP_GROUP) });
reg(['start'],                 { fn: (msg) => say(msg, '👋 Привет! Список команд — /help') });

export async function handleGroup(msg) {
  if (msg.new_chat_members) return onJoin(msg);
  const text = msg.text ?? msg.caption;
  if (!text || !msg.from) return;

  const cmd = splitCommand(text);
  if (cmd) {
    if (cmd.at && cmd.at !== (await botUsername())) return; // команда адресована другому боту

    const def = COMMANDS.get(cmd.word);
    if (def) {
      if (!cmd.prefix && !(def.plain && realReply(msg))) return; // обычная речь, не команда
      return run(def, msg, cmd);
    }

    const action = RP_BY_WORD.get(cmd.word);
    if (action) {
      const { targetHtml, comment } = rpTarget(msg, cmd);
      // Без «/» срабатываем только на действие, адресованное человеку (реплай/упоминание).
      if (!cmd.prefix && (action.solo || !targetHtml)) return;
      return runSafe(msg, () => doRp(msg, action, targetHtml, comment));
    }
  }

  if (hasLink(msg)) return runSafe(msg, () => antilink(msg));
}

const runSafe = (msg, fn) => fn().catch((e) => fail(msg, e));

async function run(def, msg, cmd) {
  return runSafe(msg, async () => {
    if (def.admin !== undefined) {
      if (!(await isAdminMsg(msg, def.admin))) {
        if (cmd.prefix) await say(msg, '🚫 Эта команда только для администраторов.');
        return;
      }
    }
    await def.fn(msg, cmd);
  });
}

// ── РП ───────────────────────────────────────────────────────────────────

const MENTION_RE = /(^|\s)(@[A-Za-z0-9_]{4,32})(?=\s|$)/;

// Цель РП-действия: реплай → text_mention → @ник. comment — текст без упоминания.
export function rpTarget(msg, cmd) {
  const r = realReply(msg);
  if (r?.from && !r.sender_chat) {
    return { targetHtml: r.from.id === msg.from.id ? 'себя' : mention(r.from), comment: cmd.args };
  }
  const text = msg.text ?? msg.caption ?? '';
  const ent = (msg.entities ?? msg.caption_entities ?? []).find((e) => e.type === 'text_mention' && e.user);
  if (ent) {
    return {
      targetHtml: ent.user.id === msg.from.id ? 'себя' : mention(ent.user),
      comment: text.slice(ent.offset + ent.length).trim(),
    };
  }
  const m = MENTION_RE.exec(cmd.args);
  if (m) {
    const comment = `${cmd.args.slice(0, m.index)} ${cmd.args.slice(m.index + m[0].length)}`.trim();
    return { targetHtml: esc(m[2]), comment };
  }
  return { targetHtml: null, comment: cmd.args };
}

async function doRp(msg, action, targetHtml, comment) {
  const chat = await getChat(msg.chat.id);
  if (!chat.rpOn) return;
  const actor = await actorOf(msg);
  await say(msg, renderRp(action, actor.html, actor.gender, targetHtml, comment.slice(0, 300)));
}

// ── Приветствие, правила ─────────────────────────────────────────────────

async function onJoin(msg) {
  const humans = msg.new_chat_members.filter((u) => !u.is_bot);
  if (!humans.length) return;
  const chat = await getChat(msg.chat.id);
  await Promise.all(humans.map((u) => touchUser(u)));
  if (!chat.welcomeOn) return;
  const text = esc(chat.welcome || DEFAULT_WELCOME)
    .replaceAll('{name}', humans.map(mention).join(', '))
    .replaceAll('{title}', esc(msg.chat.title ?? ''));
  await say(msg, text, { reply: false });
}

async function setWelcome(msg, cmd) {
  const value = !cmd.args || /^(reset|сброс)$/i.test(cmd.args) ? null : cmd.args.slice(0, 1000);
  await setChat(msg.chat.id, { welcome: value, title: msg.chat.title ?? null, type: msg.chat.type });
  await say(msg, value ? '✅ Приветствие сохранено. Подстановки: {name}, {title}.' : '♻️ Приветствие сброшено на стандартное.');
}

async function setRules(msg, cmd) {
  const value = !cmd.args || /^(reset|сброс)$/i.test(cmd.args) ? null : cmd.args.slice(0, 3000);
  await setChat(msg.chat.id, { rules: value, title: msg.chat.title ?? null, type: msg.chat.type });
  await say(msg, value ? '✅ Правила сохранены. Показать: /rules' : '♻️ Правила удалены.');
}

async function showRules(msg) {
  const chat = await getChat(msg.chat.id);
  await say(msg, chat.rules ? `📜 <b>Правила</b>\n\n${esc(chat.rules)}` : 'ℹ️ Правила пока не заданы. Админ может задать их командой /setrules.');
}

// ── Антиссылки ───────────────────────────────────────────────────────────

const hasLink = (msg) =>
  !msg.is_automatic_forward &&
  (msg.entities ?? msg.caption_entities ?? []).some((e) => e.type === 'url' || e.type === 'text_link');

async function antilink(msg) {
  const chat = await getChat(msg.chat.id);
  if (!chat.antilink) return;
  if (await isAdminMsg(msg)) return;
  await api.deleteMessage({ chat_id: msg.chat.id, message_id: msg.message_id });
  await say(msg, `🔗 ${mention(msg.from)}, ссылки в этом чате запрещены.`, { reply: false });
}

// ── Прочее ───────────────────────────────────────────────────────────────

async function showId(msg) {
  const r = realReply(msg);
  if (r?.from) return void (await say(msg, `🆔 ${mention(r.from)}: <code>${r.from.id}</code>`));
  await say(msg, `🆔 Ваш ID: <code>${msg.from.id}</code>\n💬 ID чата: <code>${msg.chat.id}</code>`);
}

async function setGender(msg, cmd) {
  const g = parseGender(cmd.args);
  if (g === undefined) return void (await say(msg, 'Использование: <code>/gender м</code>, <code>/gender ж</code> или <code>/gender -</code>'));
  await touchUser(msg.from);
  await patchUser(msg.from.id, { gender: g });
  await say(msg, '✅ Сохранено — глаголы в РП теперь подстроятся.');
}

// Быстрый вопрос ИИ в группе: без личной памяти, с суточным лимитом.
async function groupAi(msg, cmd) {
  const r = realReply(msg);
  const question = (cmd.args || r?.text || r?.caption || '').trim();
  if (!question) return void (await say(msg, 'ℹ️ Напишите вопрос после /ai или ответьте командой на сообщение.'));

  const user = await touchUser(msg.from);
  try {
    await checkQuota(msg.from.id);
    typing(msg);
    const out = await askAi({ userId: msg.from.id, name: user.name, persona: user.persona, input: question, useMemory: false });
    await sayMarkdown(msg, out.text);
  } catch (e) {
    if (e instanceof AiError) return void (await aiFailure(msg, user, e));
    throw e;
  }
}
