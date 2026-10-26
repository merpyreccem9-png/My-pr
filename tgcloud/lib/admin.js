// Проверка прав: является ли пользователь админом чата (и есть ли у него нужное право).

import { api } from 'sdk';

export async function isAdmin(chatId, userId, perm) {
  const m = await api.getChatMember({ chat_id: chatId, user_id: userId });
  if (m.status === 'creator') return true;
  return m.status === 'administrator' && (!perm || m[perm] === true);
}

// Для сообщений: анонимный админ (sender_chat = сам чат) считается админом.
export async function isAdminMsg(msg, perm) {
  if (msg.sender_chat && msg.sender_chat.id === msg.chat.id) return true;
  return isAdmin(msg.chat.id, msg.from.id, perm);
}
