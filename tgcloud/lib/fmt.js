// Чистые функции форматирования (без SDK — можно тестировать локально).

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function fullName(u) {
  const n = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
  return n || u.username || String(u.id);
}

export function mention(u) {
  return `<a href="tg://user?id=${u.id}">${esc(fullName(u).slice(0, 40))}</a>`;
}

// Упрощённый markdown (ответы ИИ) → HTML Telegram.
export function mdToHtml(src) {
  const stash = [];
  const hold = (html) => `\u0000${stash.push(html) - 1}\u0000`;

  let s = src
    .replace(/```[\w+-]*\n?([\s\S]*?)```/g, (_, code) => hold(`<pre>${esc(code.replace(/\n$/, ''))}</pre>`))
    .replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`));

  s = esc(s)
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/^#{1,6}\s+(.+)$/gm, (_, t) => `<b>${t.replace(/<\/?b>/g, '')}</b>`)
    .replace(/^[ \t]*[-*]\s+/gm, '• ');

  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
}

// Режем длинный текст по абзацам/строкам/пробелам (лимит Telegram — 4096 символов, берём запас на HTML).
export function chunk(text, max = 3000) {
  const out = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function maskKey(key) {
  if (!key) return '—';
  return key.length <= 8 ? '••••' : `${key.slice(0, 4)}…${key.slice(-2)}`;
}
