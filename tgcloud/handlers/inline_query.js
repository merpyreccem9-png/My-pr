// Inline-запросы: РП-действия в любом чате.

import { answerInline } from '../lib/inline.js';

export default async function (q) {
  try {
    await answerInline(q);
  } catch (e) {
    console.error('inline failed:', e);
  }
}
