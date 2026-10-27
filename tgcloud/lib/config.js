// Настройки бота. Секреты (ключ ИИ) здесь НЕ хранятся — они задаются командой /setkey в личке.

// Telegram ID владельцев бота. Узнать свой ID: напишите боту /id, затем впишите число сюда.
export const OWNER_IDS = [8875047670];

export const isOwner = (id) => OWNER_IDS.includes(id);

// ИИ
export const AI_DAILY_LIMIT = 40;   // запросов в сутки на пользователя (владелец без лимита)
export const AI_MAX_TOKENS = 700;   // максимум токенов в ответе
export const AI_HISTORY = 16;       // сколько последних реплик уходит в модель
export const AI_MAX_FACTS = 30;     // долговременных фактов на пользователя
// Главный выключатель лимитов: false — без суточной квоты, без потолка токенов на ответ и без обрезки ввода.
// Чтобы вернуть ограничения для всех (кроме владельцев), поставьте enabled: true.
export const LIMITS = { enabled: false };

export const AI_MAX_INPUT = 4000;   // максимум символов во входящем сообщении

// Модель по умолчанию: GPT-6 Luna с максимальным («extra high») рассуждением.
// Меняется командами владельца: /setai, /seteffort, /setimage, /setstt.
export const AI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const AI_DEFAULT_MODEL = 'gpt-6-luna';
export const AI_DEFAULT_EFFORT = 'xhigh';        // none | minimal | low | medium | high | xhigh | max
export const AI_REASONING_MAX_TOKENS = 25000;    // с рассуждением токены «мысли» тоже входят в лимит

// Картинки и голос
export const AI_IMAGE_MODEL = 'gpt-image-1';               // генерация и правка картинок
export const AI_STT_MODEL = 'gpt-4o-transcribe';           // распознавание голосовых
export const AI_IMAGE_QUOTA_COST = 5;                      // сколько «запросов» стоит одна картинка
export const AI_IMAGE_TTL = 600;                           // сек: последняя картинка доступна для «добавь/убери…»
export const AI_MAX_FILE_BYTES = 15 * 1024 * 1024;         // максимум размера входящего файла
export const AI_MAX_AUDIO_SEC = 600;                       // максимум длины голосового

// Модерация
export const MUTE_DEFAULT_SECONDS = 3600;       // /mute без срока → 1 час
export const WARN_MUTE_SECONDS = 86400;         // мут при лимите предупреждений → 1 сутки
export const PURGE_MAX = 100;                   // максимум сообщений за /purge
