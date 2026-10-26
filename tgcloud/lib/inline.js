// Inline-режим: «@бот обнять Маша» в ЛЮБОМ чате (включая личные переписки с людьми).

import { api } from 'sdk';
import { getUser } from './store.js';
import { searchActions, renderRp, vf } from './rp.js';
import { esc, fullName, mention } from './fmt.js';

export async function answerInline(q) {
  const m = /^(\S*)\s*([\s\S]*)$/.exec(q.query.trim());
  const word = m[1];
  const rest = m[2].trim().slice(0, 100);

  const user = await getUser(q.from.id);
  const gender = user?.gender ?? null;
  const actorHtml = mention(q.from);
  const actorName = fullName(q.from);

  const results = searchActions(word).slice(0, 25).map((a) => ({
    type: 'article',
    id: a.id,
    title: `${a.emoji} ${a.words[0]}`,
    description: a.solo ? `${actorName} ${vf(a.m, gender)}` : `${actorName} ${vf(a.m, gender)} ${rest || 'всех'}`,
    input_message_content: {
      message_text: renderRp(a, actorHtml, gender, rest ? esc(rest) : null, ''),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    },
  }));

  const params = { inline_query_id: q.id, results, cache_time: 10, is_personal: true };
  if (!results.length) params.button = { text: '🎭 Список РП-действий', start_parameter: 'rp' };
  await api.answerInlineQuery(params);
}
