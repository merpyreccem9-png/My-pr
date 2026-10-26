import { table, integer, text, boolean, index, sql } from 'sdk/db';

const created = () => integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`);

// Пользователи, которых бот «видел» (команды, личка, вступление в чат).
export const users = table('users', {
  tgId:     integer('tg_id').primaryKey(),
  name:     text('name').notNull().default(''),
  username: text('username'),                    // в нижнем регистре, без @
  gender:   text('gender'),                      // 'm' | 'f' | null — для глаголов в РП
  persona:  text('persona'),                     // системный промпт-«стиль» ИИ
  aiMemory: boolean('ai_memory').default(true),  // писать ли историю диалога
  awaiting: text('awaiting'),                    // ждём ввод из меню: 'fact' | 'persona' | null
  created:  created(),
}, (t) => ({
  usernameIdx: index('idx_users_username').on(t.username),
}));

// Настройки групп.
export const chats = table('chats', {
  chatId:     integer('chat_id').primaryKey(),
  title:      text('title'),
  type:       text('type'),
  welcomeOn:  boolean('welcome_on').default(true),
  welcome:    text('welcome'),
  rules:      text('rules'),
  antilink:   boolean('antilink').default(false),
  rpOn:       boolean('rp_on').default(true),
  warnLimit:  integer('warn_limit').default(3),
  warnAction: text('warn_action').default('mute'),  // 'mute' | 'ban' | 'kick'
  created:    created(),
});

// Предупреждения (без внешних ключей — платформа их не поддерживает).
export const warns = table('warns', {
  id:     integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  userId: integer('user_id').notNull(),
  byId:   integer('by_id').notNull().default(0),
  reason: text('reason'),
  created: created(),
}, (t) => ({
  chatUserIdx: index('idx_warns_chat_user').on(t.chatId, t.userId),
}));

// Краткосрочная память ИИ: последние реплики диалога.
export const history = table('history', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  userId:  integer('user_id').notNull(),
  role:    text('role').notNull(),     // 'user' | 'assistant'
  content: text('content').notNull(),
  created: created(),
}, (t) => ({
  userIdx: index('idx_history_user').on(t.userId, t.id),
}));

// Долговременная память ИИ: факты о пользователе.
export const facts = table('facts', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  userId:  integer('user_id').notNull(),
  body:    text('body').notNull(),
  created: created(),
}, (t) => ({
  userIdx: index('idx_facts_user').on(t.userId, t.id),
}));

// Суточный счётчик ИИ-запросов (защита ключа владельца от слива).
export const usage = table('usage', {
  userId: integer('user_id').primaryKey(),
  day:    text('day').notNull(),
  n:      integer('n').notNull().default(0),
});

// Настройки бота: ai.base_url, ai.api_key, ai.model, ai.effort, ai.image_model, ai.stt_model, bot.username.
export const kv = table('kv', {
  key:   text('k').primaryKey(),
  value: text('v'),
});
