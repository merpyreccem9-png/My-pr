// Журнал запросов к ИИ и отчёты для владельца. Запись журнала никогда не ломает ответ пользователю.

import { db } from 'sdk';
import { desc, lt } from 'sdk/db';
import { aiLog } from '../schema.js';
import { esc, fullName } from './fmt.js';

const RETENTION_DAYS = 30;
const now = () => Math.floor(Date.now() / 1000);

export async function logAi({ from, kind, input, model, usage }) {
  try {
    await db.insert(aiLog).values({
      userId: from.id,
      username: from.username ? from.username.toLowerCase() : null,
      name: fullName(from).slice(0, 60),
      kind,
      input: String(input ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
      model: model ?? null,
      tin: usage?.in ?? 0,
      tout: usage?.out ?? 0,
      tthink: usage?.think ?? 0,
      ts: now(),
    }).run();
    await db.delete(aiLog).where(lt(aiLog.ts, now() - RETENTION_DAYS * 86400)).run();
  } catch (e) {
    console.warn('ai_log write failed (нужен tgcloud migrate?)', e?.message ?? e);
  }
}

// null — журнала ещё нет (миграция не выполнена).
async function readRows() {
  try {
    return await db.select().from(aiLog).orderBy(desc(aiLog.id)).limit(20000).all();
  } catch (e) {
    console.warn('ai_log read failed', e?.message ?? e);
    return null;
  }
}

const fmtNum = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const isImg = (r) => r.kind.startsWith('img-');
const KIND = { text: 'текст', photo: 'фото', voice: 'голос', group: 'группа', 'img-gen': '🎨 рисунок', 'img-edit': '🖌 правка' };
const who = (r) => (r.username ? `@${esc(r.username)}` : esc(r.name || r.userId));
const when = (ts) => { const d = new Date(ts * 1000).toISOString(); return `${d.slice(8, 10)}.${d.slice(5, 7)} ${d.slice(11, 16)}`; };

function total(rows) {
  const t = { requests: 0, images: 0, tin: 0, tout: 0, think: 0 };
  for (const r of rows) {
    if (isImg(r)) t.images++; else t.requests++;
    t.tin += r.tin; t.tout += r.tout; t.think += r.tthink;
  }
  return t;
}

const summary = (t) =>
  `${t.requests} запр. · ${fmtNum(t.tin + t.tout)} ток. (вход ${fmtNum(t.tin)} / ответ ${fmtNum(t.tout)}, из них мысли ${fmtNum(t.think)})` +
  (t.images ? ` · 🖼 ${t.images}` : '');

const rowLine = (r, withUser = true) =>
  `<code>${when(r.ts)}</code> ${withUser ? `${who(r)} ` : ''}[${KIND[r.kind] ?? esc(r.kind)}] «${esc(r.input || '…')}»` +
  (isImg(r) ? '' : ` · ${fmtNum(r.tin + r.tout)} ток.`);

const cut = (s) => (s.length > 3900 ? `${s.slice(0, 3900)}…` : s);

export async function statsText() {
  const rows = await readRows();
  if (!rows) return null;
  if (!rows.length) return '📊 Журнал пока пуст: запросов к ИИ ещё не было.';
  const t = now();
  const since = (sec) => rows.filter((r) => r.ts >= t - sec);
  const week = since(7 * 86400);

  const byUser = new Map();
  for (const r of week) {
    const u = byUser.get(r.userId) ?? { last: r, rows: [] };
    u.rows.push(r);
    byUser.set(r.userId, u);
  }
  const top = [...byUser.values()]
    .map((u) => ({ last: u.last, t: total(u.rows) }))
    .sort((a, b) => (b.t.tin + b.t.tout) - (a.t.tin + a.t.tout))
    .slice(0, 5)
    .map((u, i) => `${i + 1}. ${who(u.last)} — ${summary(u.t)}`);

  return cut([
    '📊 <b>Статистика ИИ</b> (время UTC)',
    `24 часа: ${summary(total(since(86400)))}`,
    `7 дней: ${summary(total(week))}`,
    `30 дней: ${summary(total(rows))}`,
    top.length ? `\n<b>Топ за 7 дней</b>\n${top.join('\n')}` : '',
  ].filter(Boolean).join('\n'));
}

export async function logText(n = 15) {
  const rows = await readRows();
  if (!rows) return null;
  const list = rows.slice(0, Math.min(Math.max(n, 1), 40));
  if (!list.length) return '📜 Журнал пока пуст.';
  return cut(`📜 <b>Последние запросы</b> (время UTC)\n${list.map((r) => rowLine(r)).join('\n')}`);
}

export async function userText(arg) {
  const rows = await readRows();
  if (!rows) return null;
  const q = arg.trim().replace(/^@/, '').toLowerCase();
  if (!q) return 'Использование: <code>/user @username</code> или <code>/user 123456789</code>';
  const mine = rows.filter((r) => String(r.userId) === q || r.username === q);
  if (!mine.length) return `🔎 По «${esc(q)}» запросов за 30 дней нет.`;
  return cut([
    `👤 <b>${who(mine[0])}</b> (id <code>${mine[0].userId}</code>), 30 дней`,
    summary(total(mine)),
    '',
    ...mine.slice(0, 12).map((r) => rowLine(r, false)),
  ].join('\n'));
}
