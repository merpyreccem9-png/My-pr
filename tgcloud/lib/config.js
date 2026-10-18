// Настройки бота. Секреты (ключ ИИ) здесь НЕ хранятся — они задаются командой /setkey в личке.

// Telegram ID владельцев бота. Узнать свой ID: напишите боту /id, затем впишите число сюда.
export const OWNER_IDS = [];

export const isOwner = (id) => OWNER_IDS.includes(id);

// ИИ
export const AI_DAILY_LIMIT = 40;   // запросов в сутки на пользователя (владелец без лимита)
export const AI_MAX_TOKENS = 700;   // максимум токенов в ответе
export const AI_HISTORY = 16;       // сколько последних реплик уходит в модель
export const AI_MAX_FACTS = 30;     // долговременных фактов на пользователя
export const AI_MAX_INPUT = 4000;   // максимум символов во входящем сообщении

// Модерация
export const MUTE_DEFAULT_SECONDS = 3600;       // /mute без срока → 1 час
export const WARN_MUTE_SECONDS = 86400;         // мут при лимите предупреждений → 1 сутки
export const PURGE_MAX = 100;                   // максимум сообщений за /purge
