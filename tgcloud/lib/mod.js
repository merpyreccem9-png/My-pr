// Команды модерации. Каждая получает (msg, cmd) и сама отвечает в чат в РП-стиле.

import { api, db, BotApiError } from 'sdk';
import { eq, and, desc } from 'sdk/db';
import { warns } from '../schema.js';
import { esc, mention } from './fmt.js';
import { timeAndReason, formatDuration } from './parse.js';
import { vf } from './rp.js';
import { say, quiet } from './tg.js';
import { resolveTarget, realReply } from './target.js';
import { actorOf } from './actor.js';
import { getChat } from './store.js';
import { MUTE_DEFAULT_SECONDS, WARN_MUTE_SECONDS, PURGE_MAX } from './config.js';

const NO_PERMS = Object.fromEntries([
  'can_send_messages', 'can_send_audios', 'can_send_documents', 'can_send_photos', 'can_send_videos',
  'can_send_video_notes', 'can_send_voice_notes', 'can_send_polls', 'can_send_other_messages',
  'can_add_web_page_previews', 'can_change_info', 'can_invite_users', 'can_pin_messages', 'can_manage_topics',
].map((k) => [k, false]));

const ALL_PERMS = Object.fromEntries(Object.keys(NO_PERMS).map((k) => [k, true]));

const now = () => Math.floor(Date.now() / 1000);
const until = (sec) => (sec ? now() + Math.max(30, sec) : 0);
const forText = (sec) => (sec ? `на ${formatDuration(sec)}` : 'навсегда');
const reasonLine = (r) => (r ? `\n📝 <i>${esc(r)}</i>` : '');

// Общая подготовка: цель, защита от «админа/себя», актёр.
async function begin(msg, cmd, { needPresent = true } = {}) {
  const t = await resolveTarget(msg, cmd.args);
  if (t.error) { await say(msg, `ℹ️ ${t.error}`); return null; }

  if (t.user.id === msg.from.id) { await say(msg, '🙃 К себе это применять нельзя.'); return null; }

  let member;
  try {
    member = await api.getChatMember({ chat_id: msg.chat.id, user_id: t.user.id });
  } catch (e) {
    if (!(e instanceof BotApiError)) throw e;
    await say(msg, '🤷 Пользователь не найден в этом чате.');
    return null;
  }
  if (member.status === 'creator' || member.status === 'administrator') {
    await say(msg, '🛡 Это администратор — применять к нему нельзя.');
    return null;
  }
  if (needPresent && (member.status === 'left' || member.status === 'kicked')) {
    await say(msg, '🤷 Этого пользователя сейчас нет в чате.');
    return null;
  }
  return { user: { ...t.user, ...member.user }, rest: t.rest, actor: await actorOf(msg) };
}

const head = (a, emoji, verb, user, tail = '') =>
  `${emoji} ${a.html} ${vf(verb, a.gender)} 👤 ${mention(user)}${tail}`;

export async function mute(msg, cmd) {
  const c = await begin(msg, cmd);
  if (!c) return;
  const { seconds, reason } = timeAndReason(c.rest, MUTE_DEFAULT_SECONDS);
  await api.restrictChatMember({
    chat_id: msg.chat.id, user_id: c.user.id, permissions: NO_PERMS, until_date: until(seconds),
  });
  await say(msg, head(c.actor, '🤐', 'замутил', c.user, ` ${forText(seconds)}`) + reasonLine(reason));
}

export async function unmute(msg, cmd) {
  const c = await begin(msg, cmd);
  if (!c) return;
  await api.restrictChatMember({ chat_id: msg.chat.id, user_id: c.user.id, permissions: ALL_PERMS });
  await say(msg, head(c.actor, '🔊', 'размутил', c.user));
}

export async function ban(msg, cmd) {
  const c = await begin(msg, cmd, { needPresent: false });
  if (!c) return;
  const { seconds, reason } = timeAndReason(c.rest, 0);
  await api.banChatMember({ chat_id: msg.chat.id, user_id: c.user.id, until_date: until(seconds) });
  await say(msg, head(c.actor, '🔨', 'забанил', c.user, ` ${forText(seconds)}`) + reasonLine(reason));
}

export async function unban(msg, cmd) {
  const c = await begin(msg, cmd, { needPresent: false });
  if (!c) return;
  await api.unbanChatMember({ chat_id: msg.chat.id, user_id: c.user.id, only_if_banned: true });
  await say(msg, head(c.actor, '🕊', 'разбанил', c.user));
}

export async function kick(msg, cmd) {
  const c = await begin(msg, cmd);
  if (!c) return;
  await api.banChatMember({ chat_id: msg.chat.id, user_id: c.user.id });
  await api.unbanChatMember({ chat_id: msg.chat.id, user_id: c.user.id, only_if_banned: true });
  await say(msg, head(c.actor, '👢', 'выгнал', c.user) + reasonLine(c.rest.join(' ')));
}

const countWarns = (chatId, userId) =>
  db.$count(warns, and(eq(warns.chatId, chatId), eq(warns.userId, userId)));

const ACTION_TEXT = { mute: 'мут на 1 д', ban: 'бан', kick: 'исключение из чата' };

export async function warn(msg, cmd) {
  const c = await begin(msg, cmd);
  if (!c) return;
  const reason = c.rest.join(' ');
  const chatId = msg.chat.id;
  const chat = await getChat(chatId);

  await db.insert(warns).values({ chatId, userId: c.user.id, byId: c.actor.id, reason: reason || null }).run();
  const n = await countWarns(chatId, c.user.id);

  if (n < chat.warnLimit) {
    await say(msg, `⚠️ ${c.actor.html} ${vf('выдал', c.actor.gender)} предупреждение 👤 ${mention(c.user)} ` +
      `(${n}/${chat.warnLimit})` + reasonLine(reason));
    return;
  }

  const act = chat.warnAction;
  if (act === 'ban') {
    await api.banChatMember({ chat_id: chatId, user_id: c.user.id });
  } else if (act === 'kick') {
    await api.banChatMember({ chat_id: chatId, user_id: c.user.id });
    await api.unbanChatMember({ chat_id: chatId, user_id: c.user.id, only_if_banned: true });
  } else {
    await api.restrictChatMember({
      chat_id: chatId, user_id: c.user.id, permissions: NO_PERMS, until_date: until(WARN_MUTE_SECONDS),
    });
  }
  await db.delete(warns).where(and(eq(warns.chatId, chatId), eq(warns.userId, c.user.id))).run();
  await say(msg, `🚨 👤 ${mention(c.user)} набрал(а) лимит предупреждений (${n}/${chat.warnLimit}): ` +
    `${ACTION_TEXT[act] ?? ACTION_TEXT.mute}` + reasonLine(reason));
}

export async function unwarn(msg, cmd) {
  const c = await begin(msg, cmd);
  if (!c) return;
  const last = await db.select().from(warns)
    .where(and(eq(warns.chatId, msg.chat.id), eq(warns.userId, c.user.id)))
    .orderBy(desc(warns.id)).limit(1).get();
  if (!last) return void (await say(msg, 'ℹ️ У пользователя нет предупреждений.'));
  await db.delete(warns).where(eq(warns.id, last.id)).run();
  const left = await countWarns(msg.chat.id, c.user.id);
  await say(msg, `✅ ${c.actor.html} ${vf('снял', c.actor.gender)} предупреждение 👤 ${mention(c.user)} (осталось: ${left})`);
}

export async function resetWarns(msg, cmd) {
  const c = await begin(msg, cmd);
  if (!c) return;
  await db.delete(warns).where(and(eq(warns.chatId, msg.chat.id), eq(warns.userId, c.user.id))).run();
  await say(msg, `🧽 ${c.actor.html} ${vf('обнулил', c.actor.gender)} предупреждения 👤 ${mention(c.user)}`);
}

// Открытая команда: свои предупреждения или чужие (по реплаю).
export async function showWarns(msg, cmd) {
  const r = realReply(msg);
  const user = r?.from ?? msg.from;
  const chat = await getChat(msg.chat.id);
  const rows = await db.select().from(warns)
    .where(and(eq(warns.chatId, msg.chat.id), eq(warns.userId, user.id)))
    .orderBy(desc(warns.id)).limit(5).all();
  if (!rows.length) return void (await say(msg, `✅ У 👤 ${mention(user)} нет предупреждений.`));
  const total = await countWarns(msg.chat.id, user.id);
  const list = rows.map((w, i) => `${i + 1}. ${w.reason ? esc(w.reason) : '<i>без причины</i>'}`).join('\n');
  await say(msg, `⚠️ 👤 ${mention(user)}: ${total}/${chat.warnLimit}\n${list}`);
}

export async function del(msg) {
  const r = realReply(msg);
  if (!r) return void (await say(msg, 'ℹ️ Ответьте командой на сообщение, которое нужно удалить.'));
  await api.deleteMessage({ chat_id: msg.chat.id, message_id: r.message_id });
  await quiet(api.deleteMessage({ chat_id: msg.chat.id, message_id: msg.message_id }));
}

export async function purge(msg) {
  const r = realReply(msg);
  if (!r) return void (await say(msg, 'ℹ️ Ответьте командой на сообщение, с которого начать чистку.'));
  const from = r.message_id;
  const to = Math.min(msg.message_id, from + PURGE_MAX - 1);
  const ids = [];
  for (let id = from; id <= to; id++) ids.push(id);
  await api.deleteMessages({ chat_id: msg.chat.id, message_ids: ids });
  const a = await actorOf(msg);
  await say(msg, `🧹 ${a.html} ${vf('почистил', a.gender)} чат (до ${ids.length} сообщений)`, { reply: false });
}

export async function pin(msg) {
  const r = realReply(msg);
  if (!r) return void (await say(msg, 'ℹ️ Ответьте командой на сообщение, которое нужно закрепить.'));
  await api.pinChatMessage({ chat_id: msg.chat.id, message_id: r.message_id, disable_notification: true });
  const a = await actorOf(msg);
  await say(msg, `📌 ${a.html} ${vf('закрепил', a.gender)} сообщение`);
}

export async function unpin(msg) {
  const r = realReply(msg);
  await api.unpinChatMessage({ chat_id: msg.chat.id, message_id: r?.message_id });
  const a = await actorOf(msg);
  await say(msg, `📍 ${a.html} ${vf('открепил', a.gender)} сообщение`);
}
