// Статус самого бота в чате изменился (добавили в группу, дали админку).

import { api } from 'sdk';
import { setChat } from '../lib/store.js';

const IN = new Set(['member', 'administrator']);
const OUT = new Set(['left', 'kicked']);

export default async function (upd) {
  try {
    const { chat, old_chat_member: before, new_chat_member: now } = upd;
    if (chat.type !== 'group' && chat.type !== 'supergroup') return;

    if (OUT.has(before.status) && IN.has(now.status)) {
      await setChat(chat.id, { title: chat.title ?? null, type: chat.type });
      await api.sendMessage({
        chat_id: chat.id,
        parse_mode: 'HTML',
        text: '👋 Всем привет! Я модератор с РП.\n\n' +
          'Сделайте меня <b>администратором</b> (удаление сообщений, блокировка участников, закрепление) — ' +
          'и я смогу модерировать и видеть команды без «/».\n\n/help — список команд, /settings — настройки.',
      });
    } else if (before.status === 'member' && now.status === 'administrator') {
      await api.sendMessage({ chat_id: chat.id, text: '🛡 Спасибо за права! Готов к работе. /help — команды.' });
    }
  } catch (e) {
    console.error('my_chat_member failed:', e);
  }
}
