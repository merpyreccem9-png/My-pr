// Нажатия кнопок меню в личке.

import { api } from 'sdk';
import { touchUser, patchUser, kvGetMany } from './store.js';
import { renderScreen, memClearConfirm, cancelKb } from './menu.js';
import { PERSONAS, DEPTHS, setDepth, lastKey, clearFacts, clearHistory } from './ai.js';
import { chat } from './private.js';
import { setGhToken } from './github.js';
import { notModified } from './tg.js';

async function edit(msg, screen) {
  try {
    await api.editMessageText({
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      text: screen.text,
      parse_mode: 'HTML',
      reply_markup: screen.kb,
      link_preview_options: { is_disabled: true },
    });
  } catch (e) {
    if (!notModified(e)) throw e;
  }
}

const REGEN = {
  again: [null, '🔄 Генерирую заново…'],
  short: ['short', '✂️ Сокращаю…'],
  long: ['long', '➕ Расписываю подробнее…'],
};

// Кнопки под ответом: тот же вопрос снова — как есть, короче (лёгкая модель/effort) или подробнее.
async function regenerate(cq, user, what) {
  const [mode, toast] = REGEN[what] ?? [];
  if (toast === undefined) return;
  const msg = cq.message;
  let q = null;
  try { q = JSON.parse((await kvGetMany([lastKey(user.tgId)]))[lastKey(user.tgId)] ?? 'null')?.q ?? null; } catch { /* нет вопроса */ }
  if (!q) return { text: 'Не нашёл прошлый вопрос — задайте его заново', show_alert: true };
  // Отвечаем сразу (иначе у кнопки «часики» на всё время генерации) и убираем кнопки у этого сообщения.
  await api.answerCallbackQuery({ callback_query_id: cq.id, text: toast }).catch(() => {});
  await api.editMessageReplyMarkup({ chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  await chat({ ...msg, from: cq.from }, user, q, { mode, replace: true });
}

// → тост для answerCallbackQuery ({ text, show_alert }) или undefined
export async function onMenuCallback(cq) {
  const msg = cq.message;
  if (!msg || msg.chat.type !== 'private') return;

  const user = await touchUser(cq.from);
  const data = cq.data ?? '';
  const show = async (name) => edit(msg, await renderScreen(name, user));

  if (data.startsWith('m:')) {
    const name = data.slice(2);
    if (name === 'cancel') {
      await patchUser(user.tgId, { awaiting: null });
      return show('home');
    }
    return show(name);
  }

  if (data.startsWith('r:')) return regenerate(cq, user, data.slice(2));
  if (data.startsWith('d:')) {
    const key = data.slice(2);
    if (!DEPTHS[key]) return;
    await setDepth(user.tgId, key);
    await show('depth');
    return { text: `${DEPTHS[key][0]} — выбрано` };
  }

  switch (data) {
    case 'gh:connect':
      await patchUser(user.tgId, { awaiting: 'ghtoken' });
      return edit(msg, { text: '🔑 Пришлите токен GitHub одним сообщением (оно будет удалено). Права — только чтение.', kb: cancelKb() });

    case 'gh:off':
      await setGhToken(user.tgId, '');
      await show('github');
      return { text: '🔌 GitHub отключён' };

    case 'ai:new':
      await clearHistory(user.tgId);
      await show('mem');
      return { text: '🆕 Диалог сброшен' };

    case 'ai:memtoggle':
      user.aiMemory = !user.aiMemory;
      await patchUser(user.tgId, { aiMemory: user.aiMemory });
      await show('mem');
      return { text: user.aiMemory ? '▶️ История включена' : '⏸ История выключена' };

    case 'mem:add':
      await patchUser(user.tgId, { awaiting: 'fact' });
      return edit(msg, { text: '🧠 Напишите факт, который нужно запомнить, одним сообщением.', kb: cancelKb() });

    case 'mem:clear':
      return edit(msg, memClearConfirm());

    case 'mem:clear:yes':
      await Promise.all([clearFacts(user.tgId), clearHistory(user.tgId)]);
      await show('mem');
      return { text: '🗑 Память очищена' };

    case 'per:custom':
      await patchUser(user.tgId, { awaiting: 'persona' });
      return edit(msg, { text: '🎭 Опишите, как мне отвечать (до 500 символов). Например: «Ты — повар, объясняй рецепты просто».', kb: cancelKb() });

    case 'per:reset':
      user.persona = null;
      await patchUser(user.tgId, { persona: null });
      await show('persona');
      return { text: '♻️ Персона сброшена' };

    case 'g:m':
    case 'g:f':
    case 'g:n':
      user.gender = data === 'g:n' ? null : data.slice(2);
      await patchUser(user.tgId, { gender: user.gender });
      await show('profile');
      return { text: '✅ Сохранено' };
  }

  if (data.startsWith('per:')) {
    const preset = PERSONAS[data.slice(4)];
    if (!preset) return;
    user.persona = preset[1];
    await patchUser(user.tgId, { persona: preset[1] });
    await show('persona');
    return { text: `${preset[0]} — выбрано` };
  }
}
