// Нажатия inline-кнопок: gs:* — настройки группы, остальное — меню в личке.

import { api } from 'sdk';
import { onMenuCallback } from '../lib/callbacks.js';
import { onSettingsCallback } from '../lib/settings.js';

export default async function (cq) {
  let toast;
  try {
    toast = (cq.data ?? '').startsWith('gs:') ? await onSettingsCallback(cq) : await onMenuCallback(cq);
  } catch (e) {
    console.error('callback failed:', e);
  }
  // Ответ нужен всегда — иначе у кнопки крутится «часики».
  await api.answerCallbackQuery({ callback_query_id: cq.id, ...(toast && typeof toast === 'object' && 'text' in toast ? toast : {}) })
    .catch(() => {});
}
