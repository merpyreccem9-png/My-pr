import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import messageHandler from '../tgcloud/handlers/message.js';
import callbackHandler from '../tgcloud/handlers/callback_query.js';
import inlineHandler from '../tgcloud/handlers/inline_query.js';
import memberHandler from '../tgcloud/handlers/my_chat_member.js';
import { OWNER_IDS } from '../tgcloud/lib/config.js';
import { touchUser, setChat } from '../tgcloud/lib/store.js';
import { checkQuota, AiError } from '../tgcloud/lib/ai.js';
import {
  resetDb, resetApi, resetFetch, dump, db, apiCalls, members, apiFail, calls, lastText,
  mockFetch, fetchCalls, jsonResponse,
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
  await send({ ...pmsg(OLYA, undefined), photo: [{}] });
  assert.match(lastText(), /только текст/);
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
};
const aiReply = (content) => mockFetch(async () => jsonResponse({ choices: [{ message: { content } }] }));

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
  // первый sendMessage падает «can't parse entities», повтор проходит
  apiFail.set('sendMessage', { code: 400, description: "Bad Request: can't parse entities", times: 1 });
  await send(pmsg(OWNER, 'привет'));
  const sendCalls = calls('sendMessage');
  assert.equal(sendCalls.length, 2);
  assert.equal(sendCalls[0].parse_mode, 'HTML');
  assert.equal(sendCalls[1].parse_mode, undefined);
  assert.equal(sendCalls[1].text, 'Ответ');
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
