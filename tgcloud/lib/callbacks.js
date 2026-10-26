// Нажатия кнопок меню в личке.

import { api } from 'sdk';
import { touchUser, patchUser } from './store.js';
import { renderScreen, memClearConfirm, cancelKb } from './menu.js';
import { PERSONAS, clearFacts, clearHistory } from './ai.js';
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

  switch (data) {
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
