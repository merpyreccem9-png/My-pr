// Доступ к базе: пользователи, чаты, kv.

import { db, api } from 'sdk';
import { eq, inArray } from 'sdk/db';
import { users, chats, kv } from '../schema.js';
import { fullName } from './fmt.js';

export const CHAT_DEFAULTS = Object.freeze({
  welcomeOn: true, welcome: null, rules: null, antilink: false, rpOn: true, warnLimit: 3, warnAction: 'mute',
});

// Запоминает/обновляет пользователя и возвращает его строку (одним запросом).
export async function touchUser(u) {
  const name = fullName(u);
  const username = u.username ? u.username.toLowerCase() : null;
  const [row] = await db.insert(users)
    .values({ tgId: u.id, name, username })
    .onConflictDoUpdate({ target: users.tgId, set: { name, username } })
    .returning()
    .run();
  return row;
}

export const getUser = (id) => db.select().from(users).where(eq(users.tgId, id)).get();

export const findByUsername = (name) =>
  db.select().from(users).where(eq(users.username, name.replace(/^@/, '').toLowerCase())).get();

export const patchUser = (id, patch) => db.update(users).set(patch).where(eq(users.tgId, id)).run();

export async function getChat(chatId) {
  const row = await db.select().from(chats).where(eq(chats.chatId, chatId)).get();
  return row ?? { chatId, title: null, ...CHAT_DEFAULTS };
}

export const setChat = (chatId, patch) =>
  db.insert(chats).values({ chatId, ...patch }).onConflictDoUpdate({ target: chats.chatId, set: patch }).run();

export async function kvGetMany(keys) {
  const rows = await db.select().from(kv).where(inArray(kv.key, keys)).all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export const kvSet = (key, value) =>
  db.insert(kv).values({ key, value }).onConflictDoUpdate({ target: kv.key, set: { value } }).run();

// Юзернейм бота (кэшируется в kv, getMe вызывается один раз).
export async function botUsername() {
  const cached = (await kvGetMany(['bot.username']))['bot.username'];
  if (cached) return cached;
  const me = await api.getMe();
  const name = me.username.toLowerCase();
  await kvSet('bot.username', name);
  return name;
}
