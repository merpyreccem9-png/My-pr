// Экраны меню в личке: текст (HTML) + inline-клавиатура.

import { esc } from './fmt.js';
import { ACTIONS } from './rp.js';
import { PERSONAS, personaLabel, listFacts } from './ai.js';
import { botUsername } from './store.js';
import { AI_DAILY_LIMIT, AI_MAX_FACTS } from './config.js';

const b = (text, data) => ({ text, callback_data: data });
const kb = (rows) => ({ inline_keyboard: rows });
const BACK = [b('◀️ Меню', 'm:home')];

const GENDER_LABEL = { m: '👨 мужской', f: '👩 женский' };

export const HELP_GROUP = [
  '<b>🛡 Модерация</b> (ответом на сообщение, либо @ник / ID)',
  '/mute [срок] [причина] — мут (по умолчанию 1 ч), срок: 30m, 2h, 1d, навсегда',
  '/unmute · /ban [срок] · /unban · /kick',
  '/warn [причина] · /unwarn · /warns · /resetwarns',
  '/del — удалить сообщение · /purge — удалить всё от выбранного',
  '/pin · /unpin',
  '',
  '<b>⚙️ Настройки</b> (админам)',
  '/settings — панель: приветствие, антиссылки, РП, лимит варнов',
  '/setwelcome текст — приветствие ({name}, {title}) · /setrules текст · /rules',
  '',
  '<b>🎭 РП</b>',
  'Ответьте на сообщение словом: <i>обнять, ударить, поцеловать…</i> Без слэша работает только как ответ.',
  'Одиночные: /улыбнуться, /плакать… · Список: /rp',
  '',
  '<b>🤖 Прочее</b>',
  '/ai вопрос — быстрый ответ ИИ · /gender м|ж — ваш пол для РП · /id',
  'Админские команды работают и словами без слэша: «мут 10м», «бан», «варн» — ответом на сообщение.',
].join('\n');

export function rpList() {
  const targeted = ACTIONS.filter((a) => !a.solo).map((a) => `${a.emoji} ${a.words[0]}`).join(', ');
  const solo = ACTIONS.filter((a) => a.solo).map((a) => `${a.emoji} ${a.words[0]}`).join(', ');
  return [
    '<b>🎭 РП-действия</b>',
    '',
    `<b>На людей</b> (ответом на сообщение или с @ником):\n${targeted}`,
    '',
    `<b>Одиночные</b> (со слэшем, например /улыбнуться):\n${solo}`,
    '',
    'Можно добавить комментарий: <i>обнять крепко-крепко</i>.',
    'Глагол подстраивается под ваш пол — задайте его в профиле или командой /gender.',
  ].join('\n');
}

export async function homeScreen(user) {
  return {
    text: `👋 Привет, <b>${esc(user.name || 'друг')}</b>!\n\nЯ — модератор для групп с РП и личный ИИ-помощник с памятью. ` +
      'Просто напишите мне сообщение — отвечу. Или выберите раздел:',
    kb: kb([
      [b('🧠 Память', 'm:mem'), b('🎭 Персона', 'm:persona')],
      [b('🎬 РП', 'm:rp'), b('👤 Профиль', 'm:profile')],
      [b('🛡 Добавить в группу', 'm:groups'), b('❓ Помощь', 'm:help')],
    ]),
  };
}

export async function memScreen(user) {
  const rows = await listFacts(user.tgId);
  const list = rows.length
    ? rows.slice(-15).map((r, i) => `${rows.length - Math.min(rows.length, 15) + i + 1}. ${esc(r.body)}`).join('\n')
    : '<i>пока пусто</i>';
  return {
    text: `🧠 <b>Память</b> (${rows.length}/${AI_MAX_FACTS})\n\n${list}\n\n` +
      'Я запоминаю важное из разговоров сам, а ещё вы можете добавить факт вручную. ' +
      'Удалить один: <code>/forget номер</code>.\n' +
      `Запоминать диалоги: <b>${user.aiMemory ? 'вкл' : 'выкл'}</b>`,
    kb: kb([
      [b('➕ Запомнить', 'mem:add'), b('🆕 Новый диалог', 'ai:new')],
      [b(user.aiMemory ? '⏸ Не писать историю' : '▶️ Писать историю', 'ai:memtoggle')],
      [b('🗑 Очистить всё', 'mem:clear')],
      BACK,
    ]),
  };
}

export const memClearConfirm = () => ({
  text: '🗑 Удалить <b>все</b> факты и историю диалога? Это нельзя отменить.',
  kb: kb([[b('Да, удалить', 'mem:clear:yes'), b('Отмена', 'm:mem')]]),
});

export async function personaScreen(user) {
  const rows = Object.entries(PERSONAS).map(([key, [label]]) => b(label, `per:${key}`));
  return {
    text: `🎭 <b>Персона ИИ</b>\nСейчас: <b>${esc(personaLabel(user.persona))}</b>\n\n` +
      'Выберите стиль общения или задайте свой текстом (/persona ваш текст).',
    kb: kb([
      [rows[0], rows[1]],
      [rows[2], rows[3]],
      [rows[4]],
      [b('✍️ Своя', 'per:custom'), b('♻️ Сбросить', 'per:reset')],
      BACK,
    ]),
  };
}

export function profileScreen(user) {
  return {
    text: `👤 <b>Профиль</b>\n\nID: <code>${user.tgId}</code>\nПол для РП: <b>${GENDER_LABEL[user.gender] ?? 'не указан'}</b>\n` +
      `ИИ-запросов в сутки: ${AI_DAILY_LIMIT}`,
    kb: kb([
      [b(user.gender === 'm' ? '✅ 👨 М' : '👨 М', 'g:m'), b(user.gender === 'f' ? '✅ 👩 Ж' : '👩 Ж', 'g:f')],
      [b('🙈 Не указывать', 'g:n')],
      BACK,
    ]),
  };
}

export const rpScreen = () => ({
  text: `${rpList()}\n\n<b>В любом чате:</b> напишите <code>@бот действие имя</code> — например «обнять Маша» — и выберите вариант.`,
  kb: kb([BACK]),
});

export async function groupsScreen() {
  const name = await botUsername();
  const link = `https://t.me/${name}?startgroup=true&admin=delete_messages+restrict_members+pin_messages`;
  return {
    text: '🛡 <b>Добавление в группу</b>\n\n1. Добавьте бота в группу по кнопке ниже.\n' +
      '2. Выдайте права: удаление сообщений, блокировка участников, закрепление.\n' +
      '3. Админские команды и РП словами без «/» работают, если бот — админ (иначе Telegram не передаёт ему обычные сообщения).\n\n' +
      'Команды группы: /help в чате.',
    kb: kb([[{ text: '➕ Добавить в группу', url: link }], [b('📖 Команды', 'm:help')], BACK]),
  };
}

export const helpScreen = () => ({
  text: [
    '❓ <b>Помощь</b>',
    '',
    '<b>В личке:</b>',
    '• пишите — отвечает ИИ и запоминает важное',
    '• 🎤 голосовые — распознаю и отвечу · 📷 пришлите картинку с подписью («добавь шляпу», «убери человека») — поправлю',
    '• «нарисуй …» или /img описание — сгенерирую картинку · /edit — правка последней картинки',
    '• 🔒 Запросы к ИИ сохраняются для статистики владельца бота на 30 дней.',
    '• /new — новый диалог · /memory — память · /remember текст · /forget N',
    '• /persona — стиль ИИ · /gender м|ж · /id · /menu',
    '',
    HELP_GROUP,
  ].join('\n'),
  kb: kb([BACK]),
});

export async function renderScreen(name, user) {
  switch (name) {
    case 'home': return homeScreen(user);
    case 'mem': return memScreen(user);
    case 'persona': return personaScreen(user);
    case 'profile': return profileScreen(user);
    case 'rp': return rpScreen();
    case 'groups': return groupsScreen();
    case 'help': return helpScreen();
    default: return homeScreen(user);
  }
}

export const cancelKb = () => kb([[b('✖ Отмена', 'm:cancel')]]);
