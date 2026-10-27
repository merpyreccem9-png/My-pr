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

// ── LaTeX → читаемый текст (Telegram формулы не рисует) ──────────────────────

const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ' };
const SUB = {
  0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎',
  a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
};
const VULGAR = {
  '1/2': '½', '1/3': '⅓', '2/3': '⅔', '1/4': '¼', '3/4': '¾', '1/5': '⅕', '2/5': '⅖', '3/5': '⅗', '4/5': '⅘',
  '1/6': '⅙', '5/6': '⅚', '1/8': '⅛', '3/8': '⅜', '5/8': '⅝', '7/8': '⅞',
};
const SYMBOLS = {
  cdot: '·', times: '×', div: '÷', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', equiv: '≡',
  infty: '∞', pi: 'π', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ',
  sigma: 'σ', phi: 'φ', varphi: 'φ', omega: 'ω', rho: 'ρ', tau: 'τ', Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω', Pi: 'Π',
  sum: '∑', prod: '∏', int: '∫', to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔',
  leftrightarrow: '↔', implies: '⇒', iff: '⇔', in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', cup: '∪', cap: '∩', forall: '∀',
  exists: '∃', emptyset: '∅', circ: '°', degree: '°', ldots: '…', cdots: '⋯', dots: '…', angle: '∠', perp: '⊥', parallel: '∥',
  triangle: '△', neg: '¬', land: '∧', lor: '∨', nabla: '∇', partial: '∂', quad: ' ', qquad: ' ',
};
const FUNCS = new Set(['log', 'ln', 'lg', 'sin', 'cos', 'tan', 'tg', 'ctg', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'lim', 'max', 'min', 'sup', 'inf', 'exp', 'det', 'gcd', 'lcm', 'mod', 'deg', 'sgn']);
const PASS = new Set(['text', 'mathrm', 'mathbf', 'mathit', 'textbf', 'textit', 'operatorname', 'mbox', 'vec', 'overline', 'bar', 'hat', 'underline']);

const mapAll = (str, map) => {
  let out = '';
  for (const ch of str) { if (!(ch in map)) return null; out += map[ch]; }
  return out;
};
const sup = (str) => {
  const t = str.replace(/\s+/g, '');
  if (!t) return '';
  if (t === '°') return '°';
  return mapAll(t, SUP) ?? (t.length === 1 ? `^${t}` : `^(${t})`);
};
const sub = (str) => {
  const t = str.replace(/\s+/g, '');
  if (!t) return '';
  return mapAll(t, SUB) ?? (t.length === 1 ? `_${t}` : `_(${t})`);
};
const simple = (x) => /^-?[\p{L}\p{N}.,²³⁴⁵ⁿ]+$/u.test(x) || /^[√∛∜][\p{L}\p{N}]+$/u.test(x);
const frac = (a, b) => {
  const x = a.trim(); const y = b.trim();
  return VULGAR[`${x}/${y}`] ?? `${simple(x) ? x : `(${x})`}/${simple(y) ? y : `(${y})`}`;
};
const root = (n, r) => {
  const sign = n === '' ? '√' : n === '3' ? '∛' : n === '4' ? '∜' : `${sup(n).replace('^', '')}√`;
  return `${sign}${simple(r) ? r : `(${r})`}`;
};

// Аргумент команды: {…} с вложенностью, \команда или один символ (\frac34, \sqrt[3]3).
function readArg(s, i) {
  while (s[i] === ' ') i++;
  if (s[i] === '{') {
    let d = 0; let j = i;
    for (; j < s.length; j++) {
      if (s[j] === '{') d++;
      else if (s[j] === '}' && --d === 0) break;
    }
    return [s.slice(i + 1, j), j + 1];
  }
  if (s[i] === '\\') {
    const m = /^\\[A-Za-z]+/.exec(s.slice(i, i + 24));
    if (m) return [m[0], i + m[0].length];
  }
  return [s[i] ?? '', i + 1];
}

function readOpt(s, i) {
  let j = i;
  while (s[j] === ' ') j++;
  if (s[j] !== '[') return [null, i];
  const k = s.indexOf(']', j);
  return k < 0 ? [null, i] : [s.slice(j + 1, k), k + 1];
}

function conv(s, math) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const m = /^\\([A-Za-z]+)/.exec(s.slice(i, i + 24));
      if (m) {
        const start = i;
        const cmd = m[1];
        i += m[0].length;
        if (cmd === 'frac' || cmd === 'dfrac' || cmd === 'tfrac') {
          const [a, i1] = readArg(s, i); const [b, i2] = readArg(s, i1); i = i2;
          out += frac(conv(a, true), conv(b, true));
        } else if (cmd === 'sqrt') {
          const [n, i1] = readOpt(s, i); const [r, i2] = readArg(s, i1); i = i2;
          out += root(n === null ? '' : conv(n, true).trim(), conv(r, true).trim());
        } else if (cmd === 'boxed') {
          const [a, i1] = readArg(s, i); i = i1;
          out += `**${conv(a, true).replace(/\*\*/g, '').trim()}**`;
        } else if (PASS.has(cmd)) {
          const [a, i1] = readArg(s, i); i = i1;
          out += conv(a, math);
        } else if (cmd === 'left' || cmd === 'right') {
          if (s[i] === '.') i++;
        } else if (cmd === 'begin' || cmd === 'end') {
          [, i] = readArg(s, i);
        } else if (Object.hasOwn(SYMBOLS, cmd)) {
          out += SYMBOLS[cmd];
        } else if (FUNCS.has(cmd)) {
          out += cmd;
        } else {
          out += s.slice(start, i);            // незнакомая команда (\n, C:\Users…) — не трогаем
        }
        continue;
      }
      const ch = s[i + 1];
      if (math && ch !== undefined) {         // \% \{ \} \_ \, \; \\ — только внутри формул
        i += 2;
        if (ch === '\\') out += '\n';
        else if (',;: '.includes(ch)) out += ' ';
        else if (ch !== '!') out += ch;
        continue;
      }
    } else if (math) {
      if (c === '^' || c === '_') {
        const [a, next] = readArg(s, i + 1);
        i = next;
        const inner = conv(a, true);
        out += c === '^' ? sup(inner) : sub(inner);
        continue;
      }
      if (c === '{' || c === '}') { i++; continue; }
      if (c === '&' || c === '~') { out += ' '; i++; continue; }
    }
    out += c;
    i++;
  }
  return out;
}

// Ответ модели: \( … \), \[ … \], $$ … $$, \frac, \sqrt, \boxed… → обычный текст с Unicode. Код не трогаем.
export function deLatex(src) {
  if (!/\\[A-Za-z(\[]|\$\$/.test(src)) return src;
  const stash = [];
  const hold = (m) => `\u0000${stash.push(m) - 1}\u0000`;
  let s = src.replace(/```[\s\S]*?```/g, hold).replace(/`[^`\n]*`/g, hold);
  s = s.replace(/\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$/g, (m, a, b, c) => {
    const body = conv(a ?? b ?? c, true).replace(/[ \t]+/g, ' ').trim();
    return a !== undefined ? body : `\n${body}\n`;
  });
  s = conv(s, false).replace(/\n{3,}/g, '\n\n');
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => stash[Number(n)]);
}
