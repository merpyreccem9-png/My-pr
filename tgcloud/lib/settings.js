// Панель настроек группы (/settings) на inline-кнопках.

import { api } from 'sdk';
import { getChat, setChat } from './store.js';
import { isAdmin } from './admin.js';
import { say, notModified } from './tg.js';
import { esc } from './fmt.js';

const onoff = (v) => (v ? '✅' : '❌');
const ACTIONS = ['mute', 'ban', 'kick'];
const ACTION_LABEL = { mute: 'мут на 1 д', ban: 'бан', kick: 'исключение' };

export function settingsScreen(chat) {
  const b = (text, data) => ({ text, callback_data: data });
  return {
    text: `⚙️ <b>Настройки группы</b>${chat.title ? `\n${esc(chat.title)}` : ''}\n\n` +
      `При лимите предупреждений: <b>${ACTION_LABEL[chat.warnAction] ?? ACTION_LABEL.mute}</b>`,
    kb: {
      inline_keyboard: [
        [b(`${onoff(chat.welcomeOn)} Приветствие`, 'gs:welcome'), b(`${onoff(chat.antilink)} Антиссылки`, 'gs:antilink')],
        [b(`${onoff(chat.rpOn)} РП-команды`, 'gs:rp')],
        [b('➖', 'gs:lim-'), b(`⚠️ Лимит варнов: ${chat.warnLimit}`, 'gs:noop'), b('➕', 'gs:lim+')],
        [b('🔁 Действие при лимите', 'gs:act')],
        [b('✖ Закрыть', 'gs:close')],
      ],
    },
  };
}

export async function showSettings(msg) {
  const chat = await getChat(msg.chat.id);
  const s = settingsScreen({ ...chat, title: msg.chat.title });
  await say(msg, s.text, { reply_markup: s.kb, reply: false });
}

// → тост для answerCallbackQuery
export async function onSettingsCallback(cq) {
  const m = cq.message;
  if (!m || m.chat.type === 'private') return;
  const chatId = m.chat.id;

  if (!(await isAdmin(chatId, cq.from.id))) return { text: 'Только для администраторов', show_alert: true };

  const action = cq.data.slice(3);
  if (action === 'close') {
    await api.deleteMessage({ chat_id: chatId, message_id: m.message_id }).catch(() => {});
    return;
  }
  if (action === 'noop') return;

  const chat = await getChat(chatId);
  const patch = { title: m.chat.title ?? null, type: m.chat.type };
  switch (action) {
    case 'welcome': patch.welcomeOn = !chat.welcomeOn; break;
    case 'antilink': patch.antilink = !chat.antilink; break;
    case 'rp': patch.rpOn = !chat.rpOn; break;
    case 'lim-': patch.warnLimit = Math.max(1, chat.warnLimit - 1); break;
    case 'lim+': patch.warnLimit = Math.min(10, chat.warnLimit + 1); break;
    case 'act': patch.warnAction = ACTIONS[(ACTIONS.indexOf(chat.warnAction) + 1) % ACTIONS.length]; break;
    default: return;
  }
  await setChat(chatId, patch);

  const s = settingsScreen({ ...chat, ...patch });
  try {
    await api.editMessageText({
      chat_id: chatId, message_id: m.message_id, text: s.text, parse_mode: 'HTML', reply_markup: s.kb,
    });
  } catch (e) {
    if (!notModified(e)) throw e;
  }
}
