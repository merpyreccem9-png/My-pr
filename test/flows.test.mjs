import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import messageHandler from '../tgcloud/handlers/message.js';
import callbackHandler from '../tgcloud/handlers/callback_query.js';
import inlineHandler from '../tgcloud/handlers/inline_query.js';
import memberHandler from '../tgcloud/handlers/my_chat_member.js';
import { OWNER_IDS, LIMITS } from '../tgcloud/lib/config.js';
import { touchUser, setChat } from '../tgcloud/lib/store.js';
import { checkQuota, AiError, normEffort } from '../tgcloud/lib/ai.js';
import { bytesToB64, b64ToBytes, sniffMime, pickMedia } from '../tgcloud/lib/media.js';
import { deLatex } from '../tgcloud/lib/fmt.js';
import { tables } from './stub-sdk-db.mjs';
import {
  resetDb, resetApi, resetFetch, dump, db, apiCalls, members, apiFail, calls, lastText,
  mockFetch, fetchCalls, jsonResponse, fileBytes,
} from './stub-sdk.mjs';
import { history, usage } from '../tgcloud/schema.js';

const U = (id, name = 'User', extra = {}) => ({ id, first_name: `${name}`, is_bot: false, ...extra });
const ADMIN = U(1, 'Админ');
const VASYA = U(2, 'Вася');
const PETYA = U(3, 'Петя');
const GROUP = { id: -1001, type: 'supergroup', title: 'Тестовый чат' };

let mid = 100;
const gmsg = (text, from = ADMIN, extra = {}) => ({ message_id: ++mid, chat: GROUP, from, text, date: 0, ...extra });
const replyTo = (u) => ({ reply_to_message: { message_id: 50, from: u, chat: GROUP, text: 'старое' } });
const send = (m) => messageHandler(m);

const PRIV = (u) => ({ id: u.id, type: 'private' });
const pmsg = (u, text) => ({ message_id: ++mid, chat: PRIV(u), from: u, text, date: 0 });

const adminMember = (u) => ({
  status: 'administrator', user: u, can_restrict_members: true, can_delete_messages: true, can_pin_messages: true,
});

beforeEach(() => {
  resetDb(); resetApi(); resetFetch();
  OWNER_IDS.length = 0;
  LIMITS.enabled = true;   // тесты проверяют поведение с лимитами; без них — отдельный тест ниже
  members.set(`${GROUP.id}:${ADMIN.id}`, adminMember(ADMIN));
  // Telegram возвращает настоящие данные пользователя — повторяем это в заглушке.
  for (const u of [VASYA, PETYA]) members.set(`${GROUP.id}:${u.id}`, { status: 'member', user: u });
});

// ── Модерация ────────────────────────────────────────────────────────────

test('mute: ответом, срок и причина, РП-текст, права на всё выключены', async () => {
  const t0 = Math.floor(Date.now() / 1000);
  await send(gmsg('/mute 10m спам', ADMIN, replyTo(PETYA)));
  const [r] = calls('restrictChatMember');
  assert.equal(r.user_id, PETYA.id);
  assert.equal(r.chat_id, GROUP.id);
  assert.ok(Object.values(r.permissions).every((v) => v === false));
  assert.ok(Math.abs(r.until_date - (t0 + 600)) <= 5);
  assert.match(lastText(), /🤐 .*Админ.* замутил\(а\) 👤 .*Петя.* на 10 мин/);
  assert.match(lastText(), /спам/);
  assert.equal(calls('sendMessage').at(-1).parse_mode, 'HTML');
  assert.equal(calls('sendMessage').at(-1).reply_parameters.message_id, mid);
});

test('mute без срока — 1 час; «навсегда» — until_date 0', async () => {
  const t0 = Math.floor(Date.now() / 1000);
  await send(gmsg('/mute', ADMIN, replyTo(PETYA)));
  assert.ok(Math.abs(calls('restrictChatMember')[0].until_date - (t0 + 3600)) <= 5);
  await send(gmsg('/mute навсегда', ADMIN, replyTo(PETYA)));
  assert.equal(calls('restrictChatMember')[1].until_date, 0);
  assert.match(lastText(), /навсегда/);
});

test('пол админа меняет глагол: /gender ж → «замутила»', async () => {
  await send(gmsg('/gender ж', ADMIN));
  await send(gmsg('/mute 5m', ADMIN, replyTo(PETYA)));
  assert.match(lastText(), /замутила/);
});

test('слова без слэша: админ — работает, не админ — молча игнорируется', async () => {
  await send(gmsg('мут 1ч флуд', ADMIN, replyTo(PETYA)));
  assert.equal(calls('restrictChatMember').length, 1);

  const before = calls('sendMessage').length;
  await send(gmsg('мут', VASYA, replyTo(PETYA)));
  assert.equal(calls('restrictChatMember').length, 1);
  assert.equal(calls('sendMessage').length, before);

  // без реплая обычная фраза «бан за мат» вообще не трогает API
  apiCalls.length = 0;
  await send(gmsg('бан за мат это жестоко', VASYA));
  assert.equal(apiCalls.length, 0);
});

test('/mute от не-админа: вежливый отказ, действия нет', async () => {
  await send(gmsg('/mute', VASYA, replyTo(PETYA)));
  assert.equal(calls('restrictChatMember').length, 0);
  assert.match(lastText(), /только для администраторов/);
});

test('админ с правом can_restrict_members=false не может мутить', async () => {
  members.set(`${GROUP.id}:${VASYA.id}`, { status: 'administrator', user: VASYA, can_restrict_members: false });
  await send(gmsg('/mute', VASYA, replyTo(PETYA)));
  assert.equal(calls('restrictChatMember').length, 0);
});

test('админа и себя наказать нельзя', async () => {
  members.set(`${GROUP.id}:${PETYA.id}`, adminMember(PETYA));
  await send(gmsg('/ban', ADMIN, replyTo(PETYA)));
  assert.equal(calls('banChatMember').length, 0);
  assert.match(lastText(), /администратор/);

  await send(gmsg('/ban', ADMIN, replyTo(ADMIN)));
  assert.equal(calls('banChatMember').length, 0);
  assert.match(lastText(), /К себе/);
});

test('ban по @username из базы, по числовому ID, неизвестный @ник', async () => {
  await touchUser({ id: PETYA.id, first_name: 'Петя', username: 'PetyaX' });
  await send(gmsg('/ban @petyax хам', ADMIN));
  assert.equal(calls('banChatMember')[0].user_id, PETYA.id);
  assert.match(lastText(), /🔨.*забанил\(а\).*навсегда/s);

  await send(gmsg('/ban 777777 спам', ADMIN));
  assert.equal(calls('banChatMember')[1].user_id, 777777);

  await send(gmsg('/ban @nobody_here', ADMIN));
  assert.equal(calls('banChatMember').length, 2);
  assert.match(lastText(), /Не знаю такого пользователя/);

  await send(gmsg('/ban', ADMIN));
  assert.match(lastText(), /Ответьте на сообщение/);
});

test('unban использует only_if_banned, kick = ban + unban, unmute возвращает права', async () => {
  await send(gmsg('/unban 888888', ADMIN));
  assert.equal(calls('unbanChatMember')[0].only_if_banned, true);

  await send(gmsg('/kick', ADMIN, replyTo(PETYA)));
  assert.equal(calls('banChatMember').at(-1).user_id, PETYA.id);
  assert.equal(calls('unbanChatMember').at(-1).user_id, PETYA.id);
  assert.match(lastText(), /👢/);

  await send(gmsg('/unmute', ADMIN, replyTo(PETYA)));
  assert.ok(Object.values(calls('restrictChatMember').at(-1).permissions).every((v) => v === true));
});

test('warn ×3: предупреждения копятся, на лимите — мут на сутки и сброс', async () => {
  const t0 = Math.floor(Date.now() / 1000);
  await send(gmsg('/warn первый', ADMIN, replyTo(PETYA)));
  assert.match(lastText(), /\(1\/3\)/);
  await send(gmsg('/warn', ADMIN, replyTo(PETYA)));
  assert.match(lastText(), /\(2\/3\)/);
  assert.equal(calls('restrictChatMember').length, 0);

  await send(gmsg('/warn', ADMIN, replyTo(PETYA)));
  const r = calls('restrictChatMember')[0];
  assert.ok(Math.abs(r.until_date - (t0 + 86400)) <= 5);
  assert.match(lastText(), /🚨.*3\/3/);
  assert.equal(dump('warns').length, 0);
});

test('warn: лимит и действие из настроек (ban); unwarn / warns / resetwarns', async () => {
  await setChat(GROUP.id, { warnLimit: 2, warnAction: 'ban' });
  await send(gmsg('/warn а', ADMIN, replyTo(PETYA)));
  await send(gmsg('/warns', VASYA, replyTo(PETYA)));
  assert.match(lastText(), /1\/2/);
  assert.match(lastText(), /1\. а/);

  await send(gmsg('/unwarn', ADMIN, replyTo(PETYA)));
  assert.equal(dump('warns').length, 0);
  assert.match(lastText(), /осталось: 0/);

  await send(gmsg('/warn', ADMIN, replyTo(PETYA)));
  await send(gmsg('/warn', ADMIN, replyTo(PETYA)));
  assert.equal(calls('banChatMember')[0].user_id, PETYA.id);

  await send(gmsg('/warn', ADMIN, replyTo(PETYA)));
  await send(gmsg('/resetwarns', ADMIN, replyTo(PETYA)));
  assert.equal(dump('warns').length, 0);
});

test('del / purge / pin / unpin', async () => {
  await send(gmsg('/del', ADMIN, replyTo(PETYA)));
  assert.deepEqual(calls('deleteMessage')[0], { chat_id: GROUP.id, message_id: 50 });
  assert.equal(calls('deleteMessage')[1].message_id, mid); // и сама команда

  await send(gmsg('/del', ADMIN));
  assert.match(lastText(), /Ответьте командой/);

  const m = gmsg('/purge', ADMIN, replyTo(PETYA));
  m.message_id = 60;
  await send(m);
  assert.deepEqual(calls('deleteMessages')[0].message_ids, [50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60]);

  const big = gmsg('/purge', ADMIN, replyTo(PETYA));
  big.message_id = 5000;
  await send(big);
  assert.equal(calls('deleteMessages')[1].message_ids.length, 100);

  await send(gmsg('/pin', ADMIN, replyTo(PETYA)));
  assert.equal(calls('pinChatMessage')[0].message_id, 50);
  assert.equal(calls('pinChatMessage')[0].disable_notification, true);

  await send(gmsg('/unpin', ADMIN));
  assert.equal(calls('unpinChatMessage')[0].message_id, undefined);
});

test('ошибки Telegram превращаются в понятный текст, handler не падает', async () => {
  apiFail.set('restrictChatMember', { code: 400, description: 'Bad Request: not enough rights to restrict/unrestrict chat member' });
  await send(gmsg('/mute', ADMIN, replyTo(PETYA)));
  assert.match(lastText(), /нет нужных прав/);

  apiFail.clear();
  apiFail.set('getChatMember', { code: 400, description: 'Bad Request: user not found' });
  members.clear();
  await send(gmsg('/ban 999999', VASYA));   // проверка админа упадёт — молча/без исключения
});

test('команда другому боту игнорируется, своему — работает', async () => {
  await send(gmsg('/mute@someotherbot', ADMIN, replyTo(PETYA)));
  assert.equal(calls('restrictChatMember').length, 0);
  await send(gmsg('/mute@YoruxiiBot', ADMIN, replyTo(PETYA)));
  assert.equal(calls('restrictChatMember').length, 1);
});

test('форумы: «реплай» на сообщение о создании темы не считается целью', async () => {
  const m = gmsg('/ban', ADMIN, { reply_to_message: { message_id: 1, from: PETYA, forum_topic_created: { name: 'x' } } });
  await send(m);
  assert.equal(calls('banChatMember').length, 0);
  assert.match(lastText(), /Ответьте на сообщение/);
});

test('анонимный админ может модерировать; сообщение без message_thread для не-топиков', async () => {
  const m = gmsg('/mute 1h', { id: 1087968824, first_name: 'Group', is_bot: true }, { sender_chat: GROUP, ...replyTo(PETYA) });
  await send(m);
  assert.equal(calls('restrictChatMember').length, 1);
  assert.match(lastText(), /<b>Админ<\/b> замутил\(а\)/);
  assert.equal(calls('sendMessage').at(-1).message_thread_id, undefined);
});

test('темы форума: ответ уходит в ту же тему', async () => {
  await send(gmsg('/id', ADMIN, { is_topic_message: true, message_thread_id: 77 }));
  assert.equal(calls('sendMessage').at(-1).message_thread_id, 77);
});

// ── РП ───────────────────────────────────────────────────────────────────

test('РП: слово ответом на сообщение работает без слэша', async () => {
  await send(gmsg('обнять', VASYA, replyTo(PETYA)));
  assert.match(lastText(), /^🤗 <a href="tg:\/\/user\?id=2">Вася<\/a> обнял\(а\) 👤 <a href="tg:\/\/user\?id=3">Петя<\/a>$/);
});

test('РП: болтовня и «одиночные» слова без слэша молчат; со слэшем — работают', async () => {
  await send(gmsg('привет всем', VASYA));
  await send(gmsg('обнять и плакать', VASYA));        // без реплая
  await send(gmsg('улыбнуться', VASYA, replyTo(PETYA))); // solo без слэша
  assert.equal(apiCalls.length, 0);

  await send(gmsg('/улыбнуться', VASYA));
  assert.match(lastText(), /😊.*Вася.* улыбнулся\(ась\)$/);
});

test('РП: пол, комментарий, себя, @упоминание, text_mention', async () => {
  await send(gmsg('/gender ж', VASYA));
  await send(gmsg('ударить сильно', VASYA, replyTo(PETYA)));
  assert.match(lastText(), /👊.*ударила 👤 .*Петя.*\n💬 <i>сильно<\/i>$/s);

  await send(gmsg('обнять', VASYA, replyTo(VASYA)));
  assert.match(lastText(), /обняла 👤 себя/);

  await send(gmsg('/обнять @masha_x крепко', VASYA));
  assert.match(lastText(), /обняла 👤 @masha_x\n💬 <i>крепко<\/i>/);

  const text = '/поцеловать Маша нежно';
  await send(gmsg(text, VASYA, { entities: [{ type: 'text_mention', offset: 12, length: 4, user: U(9, 'Маша') }] }));
  assert.match(lastText(), /поцеловала 👤 <a href="tg:\/\/user\?id=9">Маша<\/a>\n💬 <i>нежно<\/i>/);
});

test('РП: HTML в комментарии экранируется; выключенный РП молчит', async () => {
  await send(gmsg('/обнять @masha_x <b>hack</b>', VASYA));
  assert.match(lastText(), /&lt;b&gt;hack&lt;\/b&gt;/);

  await setChat(GROUP.id, { rpOn: false });
  apiCalls.length = 0;
  await send(gmsg('обнять', VASYA, replyTo(PETYA)));
  assert.equal(calls('sendMessage').length, 0);
});

// ── Приветствие, правила, настройки, антиссылки ──────────────────────────

test('приветствие: упоминает новичков, игнорирует ботов, шаблон экранируется', async () => {
  await send(gmsg(undefined, ADMIN, { new_chat_members: [PETYA, { id: 99, is_bot: true, first_name: 'Bot' }] }));
  assert.match(lastText(), /Добро пожаловать, <a href="tg:\/\/user\?id=3">Петя<\/a>!/);
  assert.equal(dump('users').some((u) => u.tgId === PETYA.id), true);

  await send(gmsg('/setwelcome Привет, {name}! <b>Добро</b> пожаловать в {title}', ADMIN));
  await send(gmsg(undefined, ADMIN, { new_chat_members: [VASYA] }));
  assert.match(lastText(), /Привет, <a href="tg:\/\/user\?id=2">Вася<\/a>! &lt;b&gt;Добро&lt;\/b&gt; пожаловать в Тестовый чат/);

  await setChat(GROUP.id, { welcomeOn: false });
  apiCalls.length = 0;
  await send(gmsg(undefined, ADMIN, { new_chat_members: [PETYA] }));
  assert.equal(calls('sendMessage').length, 0);

  // только боты — тишина
  await setChat(GROUP.id, { welcomeOn: true });
  await send(gmsg(undefined, ADMIN, { new_chat_members: [{ id: 99, is_bot: true, first_name: 'Bot' }] }));
  assert.equal(calls('sendMessage').length, 0);
});

test('правила: setrules только админ; /rules всем', async () => {
  await send(gmsg('/rules', VASYA));
  assert.match(lastText(), /пока не заданы/);
  await send(gmsg('/setrules 1. Не спамить <3', VASYA));
  assert.match(lastText(), /только для администраторов/);
  await send(gmsg('/setrules 1. Не спамить <3', ADMIN));
  await send(gmsg('/rules', VASYA));
  assert.match(lastText(), /1\. Не спамить &lt;3/);
});

const gcb = (u, data) => ({ id: 'cb1', from: u, data, message: { message_id: 321, chat: GROUP } });

test('панель /settings: кнопки меняют настройки; не админ получает отказ', async () => {
  await send(gmsg('/settings', ADMIN));
  const sent = calls('sendMessage').at(-1);
  assert.ok(sent.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'gs:antilink'));

  await callbackHandler(gcb(ADMIN, 'gs:antilink'));
  assert.equal(dump('chats')[0].antilink, true);
  assert.equal(calls('editMessageText').length, 1);
  await callbackHandler(gcb(ADMIN, 'gs:lim+'));
  await callbackHandler(gcb(ADMIN, 'gs:act'));
  const row = dump('chats')[0];
  assert.equal(row.warnLimit, 4);
  assert.equal(row.warnAction, 'ban');

  await callbackHandler(gcb(VASYA, 'gs:rp'));
  assert.equal(dump('chats')[0].rpOn, true);
  const answer = calls('answerCallbackQuery').at(-1);
  assert.equal(answer.show_alert, true);
});

test('антиссылки: удаляет у обычных, не трогает админов, по умолчанию выключено', async () => {
  const link = { entities: [{ type: 'url', offset: 0, length: 10 }] };
  await send(gmsg('http://x.io', VASYA, link));
  assert.equal(calls('deleteMessage').length, 0);

  await callbackHandler(gcb(ADMIN, 'gs:antilink'));
  await send(gmsg('http://x.io', ADMIN, link));
  assert.equal(calls('deleteMessage').length, 0);

  await send(gmsg('http://x.io', VASYA, link));
  assert.equal(calls('deleteMessage').length, 1);
  assert.match(lastText(), /ссылки в этом чате запрещены/);

  await send(gmsg('http://x.io', VASYA, { ...link, is_automatic_forward: true }));
  assert.equal(calls('deleteMessage').length, 1);
});

test('/id, /help в группе', async () => {
  await send(gmsg('/id', VASYA));
  assert.match(lastText(), new RegExp(`${VASYA.id}.*${GROUP.id}`, 's'));
  await send(gmsg('/id', VASYA, replyTo(PETYA)));
  assert.match(lastText(), /Петя.*<code>3<\/code>/);
  await send(gmsg('/help', VASYA));
  assert.match(lastText(), /Модерация/);
});

// ── Бот добавлен в группу ────────────────────────────────────────────────

test('my_chat_member: приветствие при добавлении, спасибо за админку, личка игнорируется', async () => {
  const join = (before, now, chat = GROUP) => ({ chat, old_chat_member: { status: before }, new_chat_member: { status: now } });
  await memberHandler(join('left', 'member'));
  assert.match(lastText(), /администратором/);
  assert.equal(dump('chats')[0].title, 'Тестовый чат');

  await memberHandler(join('member', 'administrator'));
  assert.match(lastText(), /Спасибо за права/);

  apiCalls.length = 0;
  await memberHandler(join('left', 'member', { id: 5, type: 'private' }));
  await memberHandler(join('member', 'left'));
  assert.equal(apiCalls.length, 0);
});

// ── Личка: меню ──────────────────────────────────────────────────────────

const OLYA = U(7, 'Оля');
const pcb = (u, data) => ({ id: 'cb2', from: u, data, message: { message_id: 400, chat: PRIV(u) } });

test('/start: приветствие с меню, пользователь сохраняется', async () => {
  await send(pmsg(OLYA, '/start'));
  const m = calls('sendMessage').at(-1);
  assert.match(m.text, /Привет, <b>Оля<\/b>/);
  assert.ok(m.reply_markup.inline_keyboard.length >= 3);
  assert.equal(dump('users')[0].tgId, 7);
  assert.equal(m.reply_parameters, undefined); // в личке без реплая
});

test('меню: навигация, пол, память, персона, отмена', async () => {
  await send(pmsg(OLYA, '/start'));
  for (const s of ['home', 'mem', 'persona', 'profile', 'rp', 'groups', 'help']) {
    await callbackHandler(pcb(OLYA, `m:${s}`));
    assert.ok(calls('editMessageText').at(-1).text.length > 10, s);
  }
  assert.match(calls('editMessageText').find((c) => /Добавление в группу/.test(c.text)).reply_markup.inline_keyboard[0][0].url, /^https:\/\/t\.me\/yoruxiibot\?startgroup=true/);

  await callbackHandler(pcb(OLYA, 'g:f'));
  assert.equal(dump('users')[0].gender, 'f');
  await callbackHandler(pcb(OLYA, 'g:n'));
  assert.equal(dump('users')[0].gender, null);

  await callbackHandler(pcb(OLYA, 'per:dev'));
  assert.match(dump('users')[0].persona, /программист/);
  await callbackHandler(pcb(OLYA, 'per:reset'));
  assert.equal(dump('users')[0].persona, null);

  await callbackHandler(pcb(OLYA, 'mem:add'));
  assert.equal(dump('users')[0].awaiting, 'fact');
  await callbackHandler(pcb(OLYA, 'm:cancel'));
  assert.equal(dump('users')[0].awaiting, null);

  // каждое нажатие закрыто answerCallbackQuery
  assert.equal(calls('answerCallbackQuery').length, 7 + 2 + 2 + 1 + 1);
});

test('меню → «Запомнить» → текст сохраняется как факт; дубль не добавляется', async () => {
  await send(pmsg(OLYA, '/start'));
  await callbackHandler(pcb(OLYA, 'mem:add'));
  await send(pmsg(OLYA, 'Люблю чай без сахара'));
  assert.deepEqual(dump('facts').map((f) => f.body), ['Люблю чай без сахара']);
  assert.equal(dump('users')[0].awaiting, null);
  assert.equal(calls('sendMessage').at(-1).text, '🧠 Запомнил.');
  assert.equal(fetchCalls.length, 0);   // это не уходит в ИИ

  await send(pmsg(OLYA, '/remember люблю чай без сахара'));
  assert.equal(dump('facts').length, 1);
  assert.match(lastText(), /уже есть/);

  await send(pmsg(OLYA, '/memory'));
  assert.match(lastText(), /1\. Люблю чай без сахара/);
  await send(pmsg(OLYA, '/forget 1'));
  assert.equal(dump('facts').length, 0);
  await send(pmsg(OLYA, '/forget 5'));
  assert.match(lastText(), /Нет факта/);
});

test('персона текстом, /gender, неизвестная команда, не-текст', async () => {
  await send(pmsg(OLYA, '/persona ты капитан пиратов'));
  assert.equal(dump('users')[0].persona, 'ты капитан пиратов');
  await send(pmsg(OLYA, '/persona reset'));
  assert.equal(dump('users')[0].persona, null);
  await send(pmsg(OLYA, '/gender ж'));
  assert.equal(dump('users')[0].gender, 'f');
  await send(pmsg(OLYA, '/gender ???'));
  assert.match(lastText(), /Использование/);
  await send(pmsg(OLYA, '/абракадабра'));
  assert.match(lastText(), /Не знаю такую команду/);
  await send({ ...pmsg(OLYA, undefined), sticker: {} });
  assert.match(lastText(), /понимаю текст/);
});

test('команды владельца недоступны обычным пользователям', async () => {
  await send(pmsg(OLYA, '/setkey sk-evil'));
  assert.match(lastText(), /Не знаю такую команду/);
  assert.equal(dump('kv').length, 0);
});

// ── Личка: ИИ ────────────────────────────────────────────────────────────

const OWNER = U(7, 'Оля');
const setupAi = async () => {
  OWNER_IDS.push(OWNER.id);
  await send(pmsg(OWNER, '/setai https://api.example.com/v1/ gpt-test'));
  await send(pmsg(OWNER, '/setkey sk-secret-12345'));
  await send(pmsg(OWNER, '/seteffort off'));
};
const aiReply = (content) => mockFetch(async () => jsonResponse({
  choices: [{ message: { content } }],
  output: [{ type: 'message', content: [{ type: 'output_text', text: content }] }],
}));

test('ИИ не настроен: владельцу подсказка, остальным — вежливо', async () => {
  await send(pmsg(U(8, 'Гость'), 'привет'));
  assert.match(lastText(), /не подключён владельцем/);
  assert.equal(fetchCalls.length, 0);
  OWNER_IDS.push(OWNER.id);
  await send(pmsg(OWNER, 'привет'));
  assert.match(lastText(), /\/setai/);
});

test('настройка ИИ: ключ скрывается и удаляется из чата', async () => {
  await setupAi();
  const kv = Object.fromEntries(dump('kv').map((r) => [r.key, r.value]));
  assert.equal(kv['ai.base_url'], 'https://api.example.com/v1');
  assert.equal(kv['ai.model'], 'gpt-test');
  assert.equal(kv['ai.api_key'], 'sk-secret-12345');
  assert.equal(calls('deleteMessage').length, 1);
  assert.ok(!calls('sendMessage').some((c) => c.text.includes('sk-secret')));

  await send(pmsg(OWNER, '/aistatus'));
  assert.match(lastText(), /sk-s…45/);
  assert.ok(!lastText().includes('sk-secret-12345'));

  await send(pmsg(OWNER, '/setai http://plain.example.com m'));
  assert.match(lastText(), /Использование/);
});

test('ИИ-диалог: запрос к API, markdown→HTML, память [[remember]], история в следующем запросе', async () => {
  await setupAi();
  aiReply('Привет, **Оля**!\n[[remember: Зовут Оля, живёт в Туркестане]]');
  await send(pmsg(OWNER, 'привет, я Оля из Туркестана'));

  const call = fetchCalls[0];
  assert.equal(call.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer sk-secret-12345');
  const body = JSON.parse(call.init.body);
  assert.equal(body.model, 'gpt-test');
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages.at(-1).content, 'привет, я Оля из Туркестана');
  assert.equal(body.messages.length, 2);

  assert.equal(lastText(), 'Привет, <b>Оля</b>!');           // тег памяти вырезан
  assert.equal(calls('sendChatAction')[0].action, 'typing');
  assert.deepEqual(dump('history').map((h) => h.role), ['user', 'assistant']);
  assert.deepEqual(dump('facts').map((f) => f.body), ['Зовут Оля, живёт в Туркестане']);

  aiReply('Конечно!');
  await send(pmsg(OWNER, 'а как меня зовут?'));
  const body2 = JSON.parse(fetchCalls[1].init.body);
  assert.match(body2.messages[0].content, /Зовут Оля, живёт в Туркестане/);          // факты в системном промпте
  assert.deepEqual(body2.messages.slice(1, -1).map((m) => m.role), ['user', 'assistant']); // история диалога
  assert.equal(body2.messages.at(-1).content, 'а как меня зовут?');
});

test('персона и имя попадают в системный промпт; /new сбрасывает историю, но не факты', async () => {
  await setupAi();
  aiReply('ок');
  await send(pmsg(OWNER, '/persona ты капитан пиратов'));
  await send(pmsg(OWNER, '/remember люблю ром'));
  await send(pmsg(OWNER, 'привет'));
  const sys = JSON.parse(fetchCalls[0].init.body).messages[0].content;
  assert.match(sys, /капитан пиратов/);
  assert.match(sys, /зовут Оля/i);
  assert.match(sys, /люблю ром/);

  await send(pmsg(OWNER, '/new'));
  assert.equal(dump('history').length, 0);
  assert.equal(dump('facts').length, 1);
});

test('память выключена: история не пишется и не читается', async () => {
  await setupAi();
  aiReply('ок');
  await callbackHandler(pcb(OWNER, 'ai:memtoggle'));
  assert.equal(dump('users')[0].aiMemory, false);
  await send(pmsg(OWNER, 'раз'));
  await send(pmsg(OWNER, 'два'));
  assert.equal(dump('history').length, 0);
  assert.equal(JSON.parse(fetchCalls[1].init.body).messages.length, 2);
});

test('окно истории: старые реплики обрезаются, свежие остаются', async () => {
  await setupAi();
  aiReply('ок');
  await send(pmsg(OWNER, '/start'));
  for (let i = 1; i <= 20; i++) await db.insert(history).values({ userId: OWNER.id, role: i % 2 ? 'user' : 'assistant', content: `m${i}` });
  await send(pmsg(OWNER, 'новое'));
  const sent = JSON.parse(fetchCalls[0].init.body).messages;
  assert.equal(sent.length, 1 + 16 + 1);
  assert.equal(sent[1].content, 'm5');
  assert.equal(sent[16].content, 'm20');
  const rows = dump('history');
  assert.equal(rows.length, 18);
  assert.equal(Math.min(...rows.map((r) => r.id)), 5);
});

test('ошибка API ИИ: детали видит только владелец, ключ не светится', async () => {
  await setupAi();
  mockFetch(async () => jsonResponse({ error: { message: 'invalid key sk-secret-12345' } }, 401));
  await send(pmsg(OWNER, 'привет'));
  assert.match(lastText(), /Ошибка ИИ \(http\)/);
  assert.equal(dump('history').length, 0);   // неудачный обмен не пишется в память

  const guest = U(8, 'Гость');
  await send(pmsg(guest, 'привет'));
  assert.equal(lastText(), '⚠️ ИИ сейчас недоступен. Попробуйте позже.');

  mockFetch(async () => ({ ok: true, status: 200, text: async () => 'не json' }));
  await send(pmsg(guest, 'привет'));
  assert.match(lastText(), /недоступен/);
  mockFetch(async () => jsonResponse({ choices: [] }));
  await send(pmsg(guest, 'привет'));
  assert.match(lastText(), /недоступен/);
});

test('суточный лимит: на 41-м запросе отказ, на следующий день счётчик сбрасывается, владелец без лимита', async () => {
  for (let i = 0; i < 40; i++) await checkQuota(8);
  await assert.rejects(() => checkQuota(8), (e) => e instanceof AiError && e.code === 'quota');

  const row = dump('usage')[0];
  assert.equal(row.n, 41);
  await db.update(usage).set({ day: '2000-01-01' }).run();
  await checkQuota(8);
  assert.equal(dump('usage')[0].n, 1);

  OWNER_IDS.push(9);
  for (let i = 0; i < 100; i++) await checkQuota(9);
  assert.equal(dump('usage').some((r) => r.userId === 9), false);
});

test('лимит в диалоге: вежливое сообщение, запрос в API не уходит', async () => {
  await setupAi();
  aiReply('ок');
  const guest = U(8, 'Гость');
  for (let i = 0; i < 40; i++) await checkQuota(guest.id);
  await send(pmsg(guest, 'привет'));
  assert.match(lastText(), /лимит ИИ-запросов \(40\) исчерпан/);
  assert.equal(fetchCalls.length, 0);
});

test('длинный ответ ИИ режется на несколько сообщений', async () => {
  await setupAi();
  aiReply(Array.from({ length: 6 }, (_, i) => `Абзац ${i}: ${'текст '.repeat(150)}`).join('\n\n'));
  await send(pmsg(OWNER, 'много'));
  const parts = calls('sendMessage');
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => p.text.length <= 4096));
});

test('битая разметка → повтор обычным текстом', async () => {
  await setupAi();
  aiReply('Ответ');
  apiCalls.length = 0;
  // два sendMessage падают «can't parse entities»: первый — «Думаю…» (статус не критичен), второй — ответ в HTML
  apiFail.set('sendMessage', { code: 400, description: "Bad Request: can't parse entities", times: 2 });
  await send(pmsg(OWNER, 'привет'));
  const sendCalls = calls('sendMessage');
  assert.equal(sendCalls.length, 3);
  assert.equal(sendCalls[0].text, '💭 Думаю…');
  assert.equal(sendCalls[1].parse_mode, 'HTML');
  assert.equal(sendCalls[2].parse_mode, undefined);
  assert.equal(sendCalls[2].text, 'Ответ');
  assert.equal(dump('history').length, 2);   // обмен сохранён
});

test('/ai в группе: без личной памяти, с реплаем; пустой вопрос — подсказка', async () => {
  await setupAi();
  aiReply('Ответ **бота**');
  await send(gmsg('/ai сколько будет 2+2', VASYA));
  const body = JSON.parse(fetchCalls[0].init.body);
  assert.equal(body.messages.at(-1).content, 'сколько будет 2+2');
  assert.equal(lastText(), 'Ответ <b>бота</b>');
  assert.equal(calls('sendMessage').at(-1).reply_parameters.message_id, mid);
  assert.equal(dump('history').length, 0);

  await send(gmsg('/ai', VASYA, replyTo(PETYA)));          // берёт текст реплая
  assert.equal(JSON.parse(fetchCalls[1].init.body).messages.at(-1).content, 'старое');

  await send(gmsg('/ai', VASYA));
  assert.match(lastText(), /Напишите вопрос/);
});

// ── Inline ───────────────────────────────────────────────────────────────

test('inline: «обнять Маша» с учётом пола; пустой запрос — список; нет совпадений — кнопка', async () => {
  await touchUser({ id: 7, first_name: 'Оля' });
  await send(pmsg(OLYA, '/gender ж'));

  await inlineHandler({ id: 'q1', from: OLYA, query: 'обнять Маша' });
  const a = calls('answerInlineQuery')[0];
  assert.equal(a.is_personal, true);
  assert.equal(a.results.length, 1);
  assert.equal(a.results[0].type, 'article');
  assert.equal(a.results[0].id, 'hug');
  assert.match(a.results[0].input_message_content.message_text, /обняла 👤 Маша$/);
  assert.equal(a.results[0].input_message_content.parse_mode, 'HTML');
  assert.match(a.results[0].description, /Оля обняла Маша/);

  await inlineHandler({ id: 'q2', from: OLYA, query: '' });
  const all = calls('answerInlineQuery')[1].results;
  assert.ok(all.length > 5 && all.length <= 25);
  assert.equal(new Set(all.map((r) => r.id)).size, all.length);

  await inlineHandler({ id: 'q3', from: OLYA, query: 'абвгд' });
  const none = calls('answerInlineQuery')[2];
  assert.deepEqual(none.results, []);
  assert.equal(none.button.start_parameter, 'rp');

  await inlineHandler({ id: 'q4', from: U(55, 'Новичок'), query: 'обн <i>x</i>' });
  const anon = calls('answerInlineQuery')[3].results[0].input_message_content.message_text;
  assert.match(anon, /обнял\(а\) 👤 &lt;i&gt;x&lt;\/i&gt;/);
});

test('/start rp из inline-кнопки показывает список РП', async () => {
  await send(pmsg(OLYA, '/start rp'));
  assert.match(lastText(), /РП-действия/);
});

// ── Luna + effort extra, картинки, голос ───────────────────────────────────

const lastImg = () => dump('kv').find((r) => r.key.startsWith('img.'))?.value?.split('|')[0] || null;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6]);
const b64 = (u8) => Buffer.from(u8).toString('base64');
const toolCall = (name, args, content = null) => ({
  choices: [{ message: { content, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
});
// Простая «маршрутизация» ответов ИИ по адресу.
const respCall = (name, args, text = '') => ({
  output: [
    { type: 'reasoning', summary: [] },
    ...(text ? [{ type: 'message', content: [{ type: 'output_text', text }] }] : []),
    { type: 'function_call', call_id: 'c1', name, arguments: JSON.stringify(args) },
  ],
});
const route = (handlers) => mockFetch(async (url, init) => {
  const key = Object.keys(handlers).find((k) => url.endsWith(k));
  if (!key) throw new Error(`unexpected fetch ${url}`);
  return handlers[key](init);
});
const sendKeyOnly = async () => { OWNER_IDS.push(OWNER.id); await send(pmsg(OWNER, '/setkey sk-secret-12345')); };
const photoMsg = (u, caption, id = 'in-photo') => ({
  message_id: ++mid, chat: PRIV(u), from: u, date: 0, photo: [{ file_id: `${id}-s` }, { file_id: id, file_size: 1000 }], caption,
});
const voiceMsg = (u, extra = {}) => ({
  message_id: ++mid, chat: PRIV(u), from: u, date: 0, voice: { file_id: 'in-voice', duration: 5, file_size: 500, ...extra },
});

test('base64: кодек совпадает с Buffer, mime определяется по байтам', () => {
  for (const len of [0, 1, 2, 3, 4, 5, 100, 30000]) {
    const u8 = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 255);
    assert.equal(bytesToB64(u8), Buffer.from(u8).toString('base64'));
    assert.deepEqual(b64ToBytes(Buffer.from(u8).toString('base64')), u8);
  }
  assert.equal(sniffMime(PNG), 'image/png');
  assert.equal(sniffMime(JPG), 'image/jpeg');
});

test('normEffort: extra → xhigh, мусор и off → null', () => {
  assert.equal(normEffort('extra'), 'xhigh');
  assert.equal(normEffort('Extra High'), 'xhigh');
  assert.equal(normEffort('xhigh'), 'xhigh');
  assert.equal(normEffort('high'), 'high');
  assert.equal(normEffort('off'), null);
  assert.equal(normEffort('turbo'), null);
});

test('по умолчанию: gpt-6-luna, reasoning_effort xhigh, без temperature; хватает одного /setkey', async () => {
  await sendKeyOnly();
  aiReply('ок');
  await send(pmsg(OWNER, 'привет'));
  // С инструментами и рассуждением — только /responses (в chat/completions OpenAI это запрещает).
  assert.equal(fetchCalls[0].url, 'https://api.openai.com/v1/responses');
  const body = JSON.parse(fetchCalls[0].init.body);
  assert.equal(body.model, 'gpt-6-luna');
  assert.deepEqual(body.reasoning, { effort: 'xhigh' });
  assert.equal(body.max_output_tokens, undefined);   // владелец без лимита на ответ
  assert.equal(body.temperature, undefined);
  assert.equal(body.input[0].role, 'developer');
  assert.deepEqual(body.tools.map((t) => t.name), ['generate_image']);   // без картинки править нечего
  assert.equal(body.tools[0].type, 'function');
});

test('/seteffort и /aistatus; off возвращает обычные max_tokens и temperature', async () => {
  await sendKeyOnly();
  await send(pmsg(OWNER, '/seteffort extra'));
  await send(pmsg(OWNER, '/aistatus'));
  assert.match(lastText(), /Effort: <code>xhigh<\/code>/);
  await send(pmsg(OWNER, '/seteffort turbo'));
  assert.match(lastText(), /Использование/);
  await send(pmsg(OWNER, '/seteffort medium'));
  aiReply('ок');
  await send(pmsg(OWNER, 'привет'));
  assert.deepEqual(JSON.parse(fetchCalls[0].init.body).reasoning, { effort: 'medium' });
  await send(pmsg(OWNER, '/seteffort off'));
  aiReply('ок');
  await send(pmsg(OWNER, 'ещё'));
  assert.ok(fetchCalls[1].url.endsWith('/chat/completions'));   // без effort — обычный путь
  const b = JSON.parse(fetchCalls[1].init.body);
  assert.equal(b.reasoning_effort, undefined);
  assert.equal(b.max_tokens, undefined);                  // владелец без лимита на ответ
  assert.equal(b.temperature, 0.7);
});

test('/seteffort доступна только владельцу', async () => {
  await send(pmsg(OLYA, '/seteffort low'));
  assert.match(lastText(), /Не знаю такую команду/);
});

test('«нарисуй …»: модель вызывает generate_image → картинка уходит фото, память хранит пометку', async () => {
  await sendKeyOnly();
  route({
    '/responses': () => jsonResponse(respCall('generate_image', { prompt: 'a cat in a hat', size: '1024x1024' }, 'Держите!')),
    '/images/generations': () => jsonResponse({ data: [{ b64_json: b64(PNG) }] }),
  });
  await send(pmsg(OWNER, 'нарисуй кота в шляпе'));

  const gen = fetchCalls.find((c) => c.url.endsWith('/images/generations'));
  const gb = JSON.parse(gen.init.body);
  assert.equal(gb.model, 'gpt-image-2.5-sunburst');
  assert.equal(gb.prompt, 'a cat in a hat');
  assert.equal(gb.size, '1024x1024');
  assert.equal(gen.init.headers.Authorization, 'Bearer sk-secret-12345');

  assert.equal(lastText(), 'Держите!');
  const [photo] = calls('sendPhoto');
  assert.equal(photo.chat_id, OWNER.id);
  assert.deepEqual(photo.photo.bytes, PNG);
  assert.equal(photo.photo.type, 'image/png');
  assert.equal(calls('sendChatAction').at(-1).action, 'upload_photo');

  const h = dump('history');
  assert.match(h[1].content, /нарисовал картинку: a cat in a hat/);
  assert.match(lastImg(), /^out-photo-/);   // можно сразу править результат
});

test('фото с подписью: модель видит картинку, edit_image → /images/edits с файлом и инструкцией', async () => {
  await sendKeyOnly();
  fileBytes.set('in-photo', JPG);
  route({
    '/responses': () => jsonResponse(respCall('edit_image', { prompt: 'add a red hat on the man' })),
    '/images/edits': () => jsonResponse({ data: [{ b64_json: b64(PNG) }] }),
  });
  await send(photoMsg(OWNER, 'добавь ему красную шляпу'));

  const chatBody = JSON.parse(fetchCalls[0].init.body);
  const content = chatBody.input.at(-1).content;
  assert.deepEqual(content[0], { type: 'input_text', text: 'добавь ему красную шляпу' });
  assert.equal(content[1].type, 'input_image');
  assert.equal(content[1].image_url, `data:image/jpeg;base64,${b64(JPG)}`);
  assert.deepEqual(chatBody.tools.map((t) => t.name), ['generate_image', 'edit_image']);

  const edit = fetchCalls.find((c) => c.url.endsWith('/images/edits'));
  assert.equal(edit.init.headers['Content-Type'], undefined);          // boundary выставит платформа
  assert.equal(edit.init.body.get('prompt'), 'add a red hat on the man');
  assert.equal(edit.init.body.get('model'), 'gpt-image-2.5-sunburst');
  const file = edit.init.body.get('image');
  assert.deepEqual(file.bytes, JPG);
  assert.equal(file.type, 'image/jpeg');
  assert.equal(file.name, 'image.jpg');
  assert.equal(calls('sendPhoto').length, 1);
  assert.match(dump('history')[0].content, /^\[пользователь прислал картинку\] добавь ему красную шляпу/);
});

test('фото без подписи ждёт инструкцию; следующее текстовое сообщение работает с ней', async () => {
  await sendKeyOnly();
  fileBytes.set('in-photo', JPG);
  await send(photoMsg(OWNER, undefined));
  assert.match(lastText(), /Принял/);
  assert.equal(fetchCalls.length, 0);                                   // ИИ не дёргали
  assert.equal(lastImg(), 'in-photo');

  aiReply('На фото мужчина.');
  await send(pmsg(OWNER, 'что на фото?'));
  const content = JSON.parse(fetchCalls[0].init.body).input.at(-1).content;
  assert.equal(content[1].image_url, `data:image/jpeg;base64,${b64(JPG)}`);
  assert.equal(lastText(), 'На фото мужчина.');
  assert.equal(calls('sendPhoto').length, 0);                            // просто описание — без картинки
});

test('/edit правит последнюю картинку напрямую, /new её забывает', async () => {
  await sendKeyOnly();
  fileBytes.set('in-photo', PNG);
  await send(photoMsg(OWNER, undefined));
  route({ '/images/edits': () => jsonResponse({ data: [{ b64_json: b64(JPG) }] }) });
  await send(pmsg(OWNER, '/edit убери фон'));
  assert.equal(fetchCalls.length, 1);                                    // только edits, без чата
  assert.equal(fetchCalls[0].init.body.get('prompt'), 'убери фон');
  assert.equal(calls('sendPhoto')[0].photo.type, 'image/jpeg');

  await send(pmsg(OWNER, '/new'));
  assert.equal(lastImg(), null);
  await send(pmsg(OWNER, '/edit ещё'));
  assert.match(lastText(), /Сначала пришлите картинку/);
});

test('/img без раздумий модели; результат-URL тоже поддержан', async () => {
  await sendKeyOnly();
  route({
    '/images/generations': () => jsonResponse({ data: [{ url: 'https://cdn.example.com/x.png' }] }),
    '/x.png': () => ({ ok: true, status: 200, body: (async function* () { yield PNG.slice(0, 5); yield PNG.slice(5); })() }),
  });
  await send(pmsg(OWNER, '/img закат над морем'));
  assert.equal(JSON.parse(fetchCalls[0].init.body).prompt, 'закат над морем');
  assert.deepEqual(calls('sendPhoto')[0].photo.bytes, PNG);
  await send(pmsg(OWNER, '/img'));
  assert.match(lastText(), /Использование/);
});

test('голосовое: распознаётся, эхо в чат, дальше как обычный вопрос; лимит списывается один раз', async () => {
  await sendKeyOnly();
  fileBytes.set('in-voice', new Uint8Array([79, 103, 103, 83]));
  route({
    '/audio/transcriptions': () => jsonResponse({ text: 'Привет, как дела?' }),
    '/responses': () => jsonResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Отлично!' }] }] }),
  });
  await send(voiceMsg(OWNER));

  const stt = fetchCalls[0];
  assert.ok(stt.url.endsWith('/audio/transcriptions'));
  assert.equal(stt.init.body.get('model'), 'gpt-transcribe');
  assert.equal(stt.init.body.get('file').name, 'voice.ogg');
  assert.equal(stt.init.headers['Content-Type'], undefined);
  const texts = calls('sendMessage').map((m) => m.text).slice(-2);
  assert.equal(texts[0], '🎤 <i>Привет, как дела?</i>');
  assert.equal(texts[1], 'Отлично!');
  assert.equal(JSON.parse(fetchCalls[1].init.body).input.at(-1).content, 'Привет, как дела?');
});

test('голосовое от обычного пользователя: квота списывается 1 раз, не 2', async () => {
  OWNER_IDS.push(99);
  await send(pmsg(U(99), '/setkey sk-secret-12345'));
  fileBytes.set('in-voice', new Uint8Array([1, 2]));
  route({
    '/audio/transcriptions': () => jsonResponse({ text: 'привет' }),
    '/responses': () => jsonResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ок' }] }] }),
  });
  OWNER_IDS.length = 0;
  await send(voiceMsg(U(99)));
  assert.equal(dump('usage')[0].n, 1);
});

test('голосовое: пустая речь, слишком длинное, слишком большое', async () => {
  await sendKeyOnly();
  fileBytes.set('in-voice', new Uint8Array([1]));
  route({ '/audio/transcriptions': () => jsonResponse({ text: '  ' }) });
  await send(voiceMsg(OWNER));
  assert.match(lastText(), /Не удалось разобрать/);

  await send(voiceMsg(OWNER, { duration: 3600 }));
  assert.match(lastText(), /длиннее 10 мин/);
  await send(voiceMsg(OWNER, { file_size: 50 * 1024 * 1024 }));
  assert.match(lastText(), /слишком большой/);
});

test('картинка стоит 5 запросов; при исчерпании лимита — вежливый отказ', async () => {
  OWNER_IDS.push(1000);
  await send(pmsg(U(1000), '/setkey sk-secret-12345'));
  OWNER_IDS.length = 0;
  route({ '/images/generations': () => jsonResponse({ data: [{ b64_json: b64(PNG) }] }) });
  const u = U(55, 'Гость');
  for (let i = 0; i < 8; i++) await send(pmsg(u, '/img кот'));          // 8 × 5 = 40 — ровно лимит
  assert.equal(calls('sendPhoto').length, 8);
  await send(pmsg(u, '/img ещё кот'));
  assert.match(lastText(), /Дневной лимит/);
  assert.equal(calls('sendPhoto').length, 8);
});

test('фильтр безопасности и ошибки API: понятные сообщения, ключ не светится', async () => {
  await sendKeyOnly();
  route({ '/images/generations': () => jsonResponse({ error: { code: 'moderation_blocked' } }, 400) });
  await send(pmsg(OWNER, '/img что-то'));
  assert.match(lastText(), /Фильтр безопасности/);

  route({ '/images/generations': () => jsonResponse({ error: 'boom' }, 500) });
  await send(pmsg(OWNER, '/img что-то'));
  assert.match(lastText(), /Ошибка ИИ \(http\)/);
  assert.doesNotMatch(lastText(), /sk-secret/);
});

test('документ-картинка (без сжатия) принимается как картинка; pickMedia', async () => {
  assert.deepEqual(pickMedia({ document: { file_id: 'd', mime_type: 'image/png', file_size: 5 } }), { kind: 'image', fileId: 'd', size: 5 });
  assert.equal(pickMedia({ document: { file_id: 'd', mime_type: 'application/pdf' } }), null);
  assert.equal(pickMedia({ audio: { file_id: 'a', file_name: 'song.M4A', duration: 3 } }).name, 'audio.m4a');
  assert.equal(pickMedia({ video_note: { file_id: 'v', duration: 3 } }).name, 'note.mp4');
  assert.equal(pickMedia({ text: 'x' }), null);
});

test('группа: /ai по-прежнему без инструментов и без effort-ломки', async () => {
  await sendKeyOnly();
  aiReply('ок');
  await send(gmsg('/ai привет'));
  const b = JSON.parse(fetchCalls[0].init.body);
  assert.equal(b.tools, undefined);
  assert.equal(b.reasoning_effort, 'xhigh');
});

test('владелец: лимит токенов на ответ не отправляется, у обычных пользователей он есть', async () => {
  await sendKeyOnly();
  aiReply('ок');
  await send(pmsg(OWNER, 'привет'));
  const o = JSON.parse(fetchCalls[0].init.body);
  assert.equal(o.max_output_tokens, undefined);
  assert.deepEqual(o.reasoning, { effort: 'xhigh' });

  OWNER_IDS.length = 0;
  aiReply('ок');
  await send(pmsg(U(77, 'Гость'), 'привет'));
  assert.equal(JSON.parse(fetchCalls[1].init.body).max_output_tokens, 25000);
});

test('chat/completions: модель без рассуждения отвергла reasoning_effort → тихий повтор без него', async () => {
  await sendKeyOnly();
  let n = 0;
  mockFetch(async () => (++n === 1
    ? jsonResponse({ error: { message: 'Unrecognized request argument supplied: reasoning_effort' } }, 400)
    : jsonResponse({ choices: [{ message: { content: 'Привет!' } }] })));
  await send(gmsg('/ai alo'));                       // в группе инструментов нет → /chat/completions
  assert.equal(fetchCalls.length, 2);
  assert.equal(JSON.parse(fetchCalls[0].init.body).reasoning_effort, 'xhigh');
  const retry = JSON.parse(fetchCalls[1].init.body);
  assert.equal(retry.reasoning_effort, undefined);
  assert.equal(retry.temperature, 0.7);
  assert.equal(lastText(), 'Привет!');
});

test('/responses недоступен или не знает reasoning → запасной chat/completions с effort=none и функциями', async () => {
  await sendKeyOnly();
  for (const [status, msg] of [[404, 'not found'], [400, 'Unsupported parameter: reasoning.effort']]) {
    resetFetch();
    route({
      '/responses': () => jsonResponse({ error: { message: msg } }, status),
      '/chat/completions': () => jsonResponse({ choices: [{ message: { content: 'Привет!' } }] }),
    });
    await send(pmsg(OWNER, 'alo'));
    const b = JSON.parse(fetchCalls[1].init.body);
    assert.equal(b.reasoning_effort, 'none');
    assert.deepEqual(b.tools.map((t) => t.function.name), ['generate_image']);
    assert.equal(lastText(), 'Привет!');
  }
});

test('/responses: пустой ответ и «incomplete» дают понятную ошибку, а не тишину', async () => {
  await sendKeyOnly();
  mockFetch(async () => jsonResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'reasoning', summary: [] }] }));
  await send(pmsg(OWNER, 'alo'));
  assert.match(lastText(), /Ошибка ИИ \(empty\)/);
});

test('лимиты выключены для всех: нет квоты, нет потолка токенов, ввод не режется', async () => {
  LIMITS.enabled = false;
  const guest = U(500, 'Гость');
  for (let i = 0; i < 100; i++) await checkQuota(guest.id);                // не бросает
  assert.equal(dump('usage').length, 0);

  OWNER_IDS.push(OWNER.id);
  await send(pmsg(OWNER, '/setkey sk-secret-12345'));
  OWNER_IDS.length = 0;
  aiReply('ок');
  await send(pmsg(guest, 'я'.repeat(6000)));
  const b = JSON.parse(fetchCalls[0].init.body);
  assert.equal(b.max_output_tokens, undefined);
  assert.equal(b.input.at(-1).content.length, 6000);
  assert.equal(lastText(), 'ок');

  route({ '/images/generations': () => jsonResponse({ data: [{ b64_json: b64(PNG) }] }) });
  for (let i = 0; i < 20; i++) await send(pmsg(guest, '/img кот'));        // 20 картинок подряд
  assert.equal(calls('sendPhoto').length, 20);
});

test('/img: size=auto не отправляется; конкретный размер — отправляется', async () => {
  await sendKeyOnly();
  route({ '/images/generations': () => jsonResponse({ data: [{ b64_json: b64(PNG) }] }) });
  await send(pmsg(OWNER, '/img кот'));
  assert.equal('size' in JSON.parse(fetchCalls[0].init.body), false);
});

test('модель картинок отключена (gpt-image-1 shut down) → перебор запасных и запоминание рабочей', async () => {
  await sendKeyOnly();
  const seen = [];
  mockFetch(async (url, init) => {
    const model = JSON.parse(init.body).model;
    seen.push(model);
    return model === 'gpt-image-2'
      ? jsonResponse({ data: [{ b64_json: b64(PNG) }] })
      : jsonResponse({ error: { message: `The model '${model}' does not exist.`, code: 'invalid_value', param: 'model' } }, 400);
  });
  await send(pmsg(OWNER, '/img кот'));
  assert.deepEqual(seen, ['gpt-image-2.5-sunburst', 'gpt-image-2']);
  assert.equal(calls('sendPhoto').length, 1);
  await send(pmsg(OWNER, '/aistatus'));
  assert.match(lastText(), /Картинки: <code>gpt-image-2<\/code>/);
  await send(pmsg(OWNER, '/img ещё кот'));
  assert.deepEqual(seen, ['gpt-image-2.5-sunburst', 'gpt-image-2', 'gpt-image-2']);   // без повторных промахов
});

test('голос: gpt-transcribe недоступна → gpt-4o-mini-transcribe; ошибка не про модель сразу пробрасывается', async () => {
  await sendKeyOnly();
  fileBytes.set('in-voice', new Uint8Array([1, 2]));
  const seen = [];
  mockFetch(async (url, init) => {
    if (url.endsWith('/audio/transcriptions')) {
      const model = init.body.get('model');
      seen.push(model);
      return model === 'gpt-4o-mini-transcribe'
        ? jsonResponse({ text: 'привет' })
        : jsonResponse({ error: { message: `The model \`${model}\` does not exist or you do not have access to it.` } }, 404);
    }
    return jsonResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ок' }] }] });
  });
  await send(voiceMsg(OWNER));
  assert.deepEqual(seen, ['gpt-transcribe', 'gpt-4o-mini-transcribe']);
  assert.equal(lastText(), 'ок');

  seen.length = 0;
  mockFetch(async (url, init) => { seen.push(init.body.get('model')); return jsonResponse({ error: { message: 'Invalid file format' } }, 400); });
  await send(voiceMsg(OWNER));
  assert.equal(seen.length, 1);                                   // про формат файла — не перебираем модели
});

// ── Математика без LaTeX ───────────────────────────────────────────────────

test('deLatex: примеры из скриншота превращаются в читаемый текст', () => {
  assert.equal(deLatex(String.raw`\(\log_2(\log_3 81)=\log_2 4=\boxed{2}\)`), 'log₂(log₃ 81)=log₂ 4=**2**');
  assert.equal(deLatex(String.raw`\(\log_{10}(0{,}01)=\log_{10}10^{-2}=\boxed{-2}\)`), 'log₁₀(0,01)=log₁₀10⁻²=**-2**');
  assert.equal(deLatex(String.raw`\(\frac12+\frac14=\boxed{\frac34}\)`), '½+¼=**¾**');
  assert.equal(deLatex(String.raw`\(\log_{\sqrt3}\frac1{3\sqrt[3]3}\)`), 'log_(√3)1/(3∛3)');
  assert.equal(deLatex(String.raw`\(\boxed{-\frac{22}{5}}\)`), '**-22/5**');
  assert.equal(deLatex(String.raw`\(\log_{5^{-1/2}}5^{11/5}\)`), 'log_(5^(-1/2))5^(11/5)');
  assert.equal(deLatex(String.raw`\[ x^2+1 \le 5 \cdot \pi \]`), '\nx²+1 ≤ 5 · π\n');
  assert.equal(deLatex(String.raw`\(\sqrt{x+1}\) и \(\sqrt[4]{16}\)`), '√(x+1) и ∜16');
});

test('deLatex: обычный текст, пути, цены и код не трогает', () => {
  const plain = ['Привет, как дела?', String.raw`Путь C:\Users\tom и перенос \n`, 'Цена $5 и $10', 'snake_case и a^b в тексте'];
  for (const t of plain) assert.equal(deLatex(t), t);
  const code = 'Вот код:\n```js\nconst s = "\\frac{1}{2}"; // a_b\n```\nи `\\sqrt{x}`';
  assert.equal(deLatex(code), code);
});

test('ответ модели с LaTeX уходит в Telegram чистым текстом (и в историю тоже)', async () => {
  await setupAi();
  aiReply(String.raw`**291**
1) \(\log_{10}(0{,}01)=\boxed{-2}\).
5) \(\frac12+\frac14=\boxed{\frac34}\).`);
  await send(pmsg(OWNER, 'реши'));
  const t = lastText();
  assert.doesNotMatch(t, /\\|boxed|frac/);
  assert.match(t, /log₁₀\(0,01\)=<b>-2<\/b>/);
  assert.match(t, /½\+¼=<b>¾<\/b>/);
  assert.doesNotMatch(dump('history')[1].content, /\\/);
});

test('системный промпт: «ты в Telegram, а не в ChatGPT», LaTeX запрещён', async () => {
  await setupAi();
  aiReply('ок');
  await send(pmsg(OWNER, 'привет'));
  const sys = JSON.parse(fetchCalls[0].init.body).messages[0].content;
  assert.match(sys, /НЕ в приложении ChatGPT/);
  assert.match(sys, /ЗАПРЕЩЕНО/);
  assert.match(sys, /Юникода/);
});

// ── Журнал запросов для владельца ───────────────────────────────────────────

const VASYA2 = U(600, 'Вася', { username: 'Vasya' });
const chatUsage = { prompt_tokens: 100, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 250 } };
const aiReplyUsage = (content, usage = chatUsage) => mockFetch(async () => jsonResponse({ choices: [{ message: { content } }], usage }));

test('журнал: запрос, юзернейм и токены (вход / ответ / мысли) записываются', async () => {
  await setupAi();
  aiReplyUsage('Привет!');
  await send(pmsg(VASYA2, 'расскажи про котов'));
  const [row] = dump('ai_log');
  assert.equal(row.userId, 600);
  assert.equal(row.username, 'vasya');
  assert.equal(row.kind, 'text');
  assert.equal(row.input, 'расскажи про котов');
  assert.equal(row.model, 'gpt-test');
  assert.deepEqual([row.tin, row.tout, row.tthink], [100, 300, 250]);
  assert.ok(row.ts > 1_700_000_000);
});

test('журнал: /responses считает input_tokens / output_tokens / reasoning_tokens', async () => {
  await sendKeyOnly();
  mockFetch(async () => jsonResponse({
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'ок' }] }],
    usage: { input_tokens: 1200, output_tokens: 8800, output_tokens_details: { reasoning_tokens: 8000 } },
  }));
  await send(pmsg(VASYA2, 'сложный вопрос'));
  const [row] = dump('ai_log');
  assert.deepEqual([row.tin, row.tout, row.tthink], [1200, 8800, 8000]);
  assert.equal(row.model, 'gpt-6-luna');
});

test('/stats, /log, /user — только владельцу, с юзернеймами и токенами', async () => {
  await setupAi();
  aiReplyUsage('Привет!');
  await send(pmsg(VASYA2, 'расскажи про котов'));
  aiReplyUsage('Ещё!', { prompt_tokens: 50, completion_tokens: 150, completion_tokens_details: { reasoning_tokens: 100 } });
  await send(pmsg(VASYA2, 'и про собак'));

  await send(pmsg(OWNER, '/stats'));
  assert.match(lastText(), /Статистика ИИ/);
  assert.match(lastText(), /24 часа: 2 запр\. · 600 ток\. \(вход 150 \/ ответ 450, из них мысли 350\)/);
  assert.match(lastText(), /1\. @vasya — 2 запр\./);

  await send(pmsg(OWNER, '/log'));
  assert.match(lastText(), /@vasya \[текст\] «и про собак» · 200 ток\./);
  assert.match(lastText(), /@vasya \[текст\] «расскажи про котов» · 400 ток\./);

  for (const q of ['/user @Vasya', '/user 600']) {
    await send(pmsg(OWNER, q));
    assert.match(lastText(), /@vasya.*id <code>600<\/code>/);
    assert.match(lastText(), /2 запр\. · 600 ток\./);
    assert.match(lastText(), /«и про собак»/);
  }
  await send(pmsg(OWNER, '/user @nobody'));
  assert.match(lastText(), /запросов за 30 дней нет/);
  await send(pmsg(OWNER, '/user'));
  assert.match(lastText(), /Использование/);

  for (const c of ['/stats', '/log', '/user @vasya']) {
    await send(pmsg(VASYA2, c));
    assert.match(lastText(), /Не знаю такую команду/);
  }
});

test('журнал: картинки, голос и группа попадают в журнал с нужным видом', async () => {
  await sendKeyOnly();
  route({
    '/images/generations': () => jsonResponse({ data: [{ b64_json: b64(PNG) }] }),
    '/audio/transcriptions': () => jsonResponse({ text: 'привет из голосового' }),
    '/responses': () => jsonResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ок' }] }], usage: { input_tokens: 10, output_tokens: 20 } }),
    '/chat/completions': () => jsonResponse({ choices: [{ message: { content: 'ок' } }], usage: { prompt_tokens: 5, completion_tokens: 6 } }),
  });
  fileBytes.set('in-voice', new Uint8Array([1, 2]));
  await send(pmsg(VASYA2, '/img закат'));
  await send(voiceMsg(VASYA2));
  await send(gmsg('/ai привет'));
  const kinds = dump('ai_log').map((r) => [r.kind, r.input]);
  assert.deepEqual(kinds, [['img-gen', 'закат'], ['voice', 'привет из голосового'], ['group', 'привет']]);

  await send(pmsg(OWNER, '/stats'));
  assert.match(lastText(), /🖼 1/);                                      // картинки считаются отдельно
  assert.match(lastText(), /24 часа: 2 запр\./);
});

test('журнал: нет таблицы (не сделан migrate) — ответы живы, /stats подсказывает migrate', async () => {
  await setupAi();
  const saved = tables.get('ai_log');
  tables.delete('ai_log');
  try {
    aiReplyUsage('Всё работает');
    await send(pmsg(VASYA2, 'привет'));
    assert.equal(lastText(), 'Всё работает');
    await send(pmsg(OWNER, '/stats'));
    assert.match(lastText(), /npx tgcloud migrate/);
    await send(pmsg(OWNER, '/log'));
    assert.match(lastText(), /npx tgcloud migrate/);
  } finally {
    tables.set('ai_log', saved);
  }
});

test('журнал: записи старше 30 дней стираются при новой записи; текст запроса режется до 200 символов', async () => {
  await setupAi();
  const t = tables.get('ai_log');
  t.rows.push({ id: 900, userId: 1, username: 'old', name: 'Old', kind: 'text', input: 'давно', model: 'x', tin: 1, tout: 1, tthink: 0, ts: Math.floor(Date.now() / 1000) - 31 * 86400 });
  t.rows.push({ id: 901, userId: 2, username: 'new', name: 'New', kind: 'text', input: 'недавно', model: 'x', tin: 1, tout: 1, tthink: 0, ts: Math.floor(Date.now() / 1000) - 29 * 86400 });
  aiReplyUsage('ок');
  await send(pmsg(VASYA2, 'я'.repeat(500)));
  const rows = dump('ai_log');
  assert.deepEqual(rows.map((r) => r.username).sort(), ['new', 'vasya']);
  assert.equal(rows.find((r) => r.username === 'vasya').input.length, 200);
});

test('/start и /help предупреждают, что запросы сохраняются', async () => {
  await send(pmsg(OLYA, '/help'));
  assert.match(lastText(), /Запросы к ИИ сохраняются/);
});

// ── Статус «Думаю…» ────────────────────────────────────────────────────────

const idxOf = (pred) => apiCalls.findIndex(pred);
const statusSent = () => apiCalls.filter((c) => c.method === 'sendMessage' && /^(💭|🎨|🎤|🖌).*…$/.test(c.params.text));

test('«💭 Думаю…» появляется до ответа и удаляется после него', async () => {
  await setupAi();
  aiReply('Готово');
  apiCalls.length = 0;
  await send(pmsg(OWNER, 'привет'));
  const [status] = statusSent();
  assert.equal(status.params.text, '💭 Думаю…');
  const statusId = 5000 + apiCalls.indexOf(status) + 1;           // message_id из заглушки sendMessage
  const del = apiCalls.find((c) => c.method === 'deleteMessage');
  assert.equal(del.params.message_id, statusId);
  assert.equal(del.params.chat_id, OWNER.id);
  const answerAt = idxOf((c) => c.method === 'sendMessage' && c.params.text === 'Готово');
  assert.ok(answerAt > apiCalls.indexOf(status) && apiCalls.indexOf(del) > answerAt);   // статус → ответ → удаление
});

test('ошибка ИИ: статус тоже удаляется, пользователь видит ошибку', async () => {
  await setupAi();
  mockFetch(async () => jsonResponse({ error: 'boom' }, 500));
  apiCalls.length = 0;
  await send(pmsg(OWNER, 'привет'));
  assert.equal(calls('deleteMessage').length, 1);
  assert.match(lastText(), /Ошибка ИИ/);
  assert.ok(idxOf((c) => c.method === 'deleteMessage') < idxOf((c) => c.method === 'sendMessage' && /Ошибка ИИ/.test(c.params.text)));
});

test('нет настройки ИИ или исчерпан лимит: статус даже не показывается', async () => {
  apiCalls.length = 0;
  await send(pmsg(U(8, 'Гость'), 'привет'));
  assert.equal(statusSent().length, 0);
  assert.equal(calls('deleteMessage').length, 0);
});

test('рисование: статус меняется на «Рисую…» и удаляется после картинки', async () => {
  await sendKeyOnly();
  route({
    '/responses': () => jsonResponse(respCall('generate_image', { prompt: 'cat' })),
    '/images/generations': () => jsonResponse({ data: [{ b64_json: b64(PNG) }] }),
  });
  apiCalls.length = 0;
  await send(pmsg(OWNER, 'нарисуй кота'));
  assert.equal(statusSent().length, 1);                              // одно сообщение-статус, а не по одному на этап
  assert.equal(calls('editMessageText').at(-1).text, '🎨 Рисую картинку…');
  assert.equal(calls('deleteMessage').length, 1);
  assert.ok(idxOf((c) => c.method === 'deleteMessage') > idxOf((c) => c.method === 'sendPhoto'));
});

test('/img: «Рисую…» и удаление; правка: «Правлю…»', async () => {
  await sendKeyOnly();
  fileBytes.set('in-photo', PNG);
  route({
    '/images/generations': () => jsonResponse({ data: [{ b64_json: b64(PNG) }] }),
    '/images/edits': () => jsonResponse({ data: [{ b64_json: b64(JPG) }] }),
  });
  apiCalls.length = 0;
  await send(pmsg(OWNER, '/img закат'));
  assert.equal(statusSent()[0].params.text, '🎨 Рисую картинку…');
  assert.equal(calls('deleteMessage').length, 1);

  await send(photoMsg(OWNER, undefined));
  apiCalls.length = 0;
  await send(pmsg(OWNER, '/edit убери фон'));
  assert.equal(calls('editMessageText').at(-1).text, '🖌 Правлю картинку…');
  assert.equal(calls('deleteMessage').length, 1);
});

test('голосовое: один статус «Слушаю…» → «Думаю…», расшифровка и ответ остаются, статус удалён', async () => {
  await sendKeyOnly();
  fileBytes.set('in-voice', new Uint8Array([1, 2]));
  route({
    '/audio/transcriptions': () => jsonResponse({ text: 'привет' }),
    '/responses': () => jsonResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Отлично!' }] }] }),
  });
  apiCalls.length = 0;
  await send(voiceMsg(OWNER));
  assert.deepEqual(statusSent().map((c) => c.params.text), ['🎤 Слушаю…']);
  assert.equal(calls('editMessageText').at(-1).text, '💭 Думаю…');
  assert.equal(calls('deleteMessage').length, 1);
  assert.deepEqual(calls('sendMessage').map((m) => m.text).slice(-2), ['🎤 <i>привет</i>', 'Отлично!']);
});

test('группа: /ai показывает «Думаю…» реплаем и удаляет после ответа', async () => {
  await sendKeyOnly();
  aiReply('Ответ в группе');
  apiCalls.length = 0;
  await send(gmsg('/ai привет'));
  const [status] = statusSent();
  assert.equal(status.params.text, '💭 Думаю…');
  assert.ok(status.params.reply_parameters);
  assert.equal(calls('deleteMessage').length, 1);
  assert.equal(lastText(), 'Ответ в группе');
});

test('статус не критичен: удалить не вышло — ответ всё равно доставлен', async () => {
  await setupAi();
  aiReply('Ответ дошёл');
  apiFail.set('deleteMessage', { code: 400, description: 'Bad Request: message to delete not found' });
  await send(pmsg(OWNER, 'привет'));
  assert.equal(lastText(), 'Ответ дошёл');
});
