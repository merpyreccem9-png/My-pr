// Кто выполняет действие: имя-ссылка + пол (для РП-глаголов).

import { touchUser } from './store.js';
import { mention } from './fmt.js';

export async function actorOf(msg) {
  // Анонимный админ: from — служебный бот, sender_chat — сама группа.
  if (msg.sender_chat && msg.sender_chat.id === msg.chat.id) {
    return { id: 0, html: '<b>Админ</b>', gender: null };
  }
  const row = await touchUser(msg.from);
  return { id: msg.from.id, html: mention(msg.from), gender: row?.gender ?? null };
}
