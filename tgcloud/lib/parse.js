// Разбор команд и сроков (чистые функции).

// «/mute@bot 10m спам» → { prefix:'/', word:'mute', at:'bot', args:'10m спам' }
// «мут 10м» → { prefix:'', word:'мут', at:null, args:'10м' }
export function splitCommand(text) {
  const m = /^([/.!]?)([^\s@]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(text.trimStart());
  if (!m) return null;
  return {
    prefix: m[1],
    word: m[2].toLowerCase().replace(/[.,!?:;]+$/, ''),
    at: m[3] ? m[3].toLowerCase() : null,
    args: (m[4] ?? '').trim(),
  };
}

export const tokens = (s) => s.split(/\s+/).filter(Boolean);

const UNITS = {
  s: 1, sec: 1, с: 1, сек: 1,
  m: 60, min: 60, м: 60, мин: 60,
  h: 3600, hr: 3600, ч: 3600, час: 3600, часа: 3600, часов: 3600,
  d: 86400, д: 86400, дн: 86400, день: 86400, дня: 86400, дней: 86400,
  w: 604800, н: 604800, нед: 604800, неделя: 604800, недели: 604800, недель: 604800,
};

// «10m», «2ч», «1д» → секунды; иначе null.
export function parseDuration(token) {
  const m = /^(\d{1,6})\s*([a-zа-яё]+)$/i.exec(token);
  if (!m) return null;
  const mult = UNITS[m[2].toLowerCase()];
  return mult ? Number(m[1]) * mult : null;
}

export function formatDuration(sec) {
  if (!sec) return 'навсегда';
  const parts = [];
  let left = sec;
  for (const [size, unit] of [[604800, 'нед'], [86400, 'д'], [3600, 'ч'], [60, 'мин'], [1, 'сек']]) {
    const k = Math.floor(left / size);
    if (k) { parts.push(`${k} ${unit}`); left -= k * size; }
  }
  return parts.slice(0, 2).join(' ');
}

// «м» → 'm', «ж» → 'f', «-» → null (сбросить); непонятное → undefined.
export function parseGender(s) {
  return { м: 'm', m: 'm', ж: 'f', f: 'f', '-': null, нет: null }[s.trim().toLowerCase()];
}

const FOREVER = new Set(['навсегда', 'forever', 'perm', 'inf', 'вечно']);

// ['10m','спам','ссылки'] → { seconds: 600, reason: 'спам ссылки' }; без срока — defSec.
export function timeAndReason(toks, defSec) {
  const first = (toks[0] ?? '').toLowerCase();
  if (FOREVER.has(first)) return { seconds: 0, reason: toks.slice(1).join(' ') };
  const d = parseDuration(first);
  if (d !== null && d > 0) return { seconds: d, reason: toks.slice(1).join(' ') };
  return { seconds: defSec, reason: toks.join(' ') };
}
