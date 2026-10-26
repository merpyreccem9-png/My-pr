// Определение «цели» команды: реплай, text_mention, ID или @username из базы.

import { findByUsername } from './store.js';
import { tokens } from './parse.js';

// Реплай, который реально что-то значит (в форумах «ответ» на сообщение о создании темы — это не реплай).
export function realReply(msg) {
  const r = msg.reply_to_message;
  return r && !r.forum_topic_created ? r : null;
}

// → { user, rest: string[] } либо { error: 'текст' }
export async function resolveTarget(msg, args) {
  const toks = tokens(args);
  const r = realReply(msg);

  if (r) {
    if (r.sender_chat || !r.from) return { error: 'Это сообщение от канала или анонимного админа — применить нельзя.' };
    return { user: r.from, rest: toks };
  }

  const text = msg.text ?? msg.caption ?? '';
  const ent = (msg.entities ?? msg.caption_entities ?? []).find((e) => e.type === 'text_mention' && e.user);
  if (ent) {
    return { user: ent.user, rest: tokens(text.slice(ent.offset + ent.length)) };
  }

  const first = toks[0];
  if (first && /^\d{5,}$/.test(first)) {
    return { user: { id: Number(first), first_name: first }, rest: toks.slice(1) };
  }
  if (first && first.startsWith('@')) {
    const row = await findByUsername(first);
    if (!row) return { error: 'Не знаю такого пользователя. Ответьте на его сообщение или укажите числовой ID.' };
    return { user: { id: row.tgId, first_name: row.name, username: row.username }, rest: toks.slice(1) };
  }

  return { error: 'Ответьте на сообщение пользователя или укажите @username / ID.' };
}
