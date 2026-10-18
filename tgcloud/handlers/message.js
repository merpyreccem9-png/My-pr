// Все входящие сообщения. Ошибки глотаем, чтобы Telegram не повторял доставку апдейта.

import { handlePrivate } from '../lib/private.js';
import { handleGroup } from '../lib/group.js';

export default async function (msg) {
  try {
    const type = msg.chat.type;
    if (type === 'private') return await handlePrivate(msg);
    if (type === 'group' || type === 'supergroup') return await handleGroup(msg);
  } catch (e) {
    console.error('message handler failed:', e);
  }
}
