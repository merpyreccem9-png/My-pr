// Luna — Mini App: чат в стиле ChatGPT. Без зависимостей и сборки.
// Сервер (endpoints/send) пишет ход работы в kv, а мы читаем его через poll: плавный текст, «мысли» и команды вживую.
(() => {
  'use strict';

  const VERSION = '7';   // показывается в меню: сразу видно, что открыта свежая версия
  const tg = window.Telegram && window.Telegram.WebApp;
  const $ = (s) => document.querySelector(s);
  const listEl = $('#list'), chatEl = $('#chat'), inputEl = $('#input'), sendEl = $('#send');
  const trayEl = $('#tray'), fileEl = $('#file'), attachEl = $('#attach');
  const effortEl = $('#effort'), statusEl = $('#status'), menuBtn = $('#menuBtn');
  const sheetEl = $('#sheet'), overlayEl = $('#overlay'), toastEl = $('#toast');

  const S = {
    name: '', owner: false, configured: true, model: '', models: null, depth: 'auto',
    github: { connected: false, login: null }, facts: [],
    messages: [], busy: false, hasLast: false,
    pending: { image: null, files: [] },   // вложения, ещё не отправленные
    run: null, forceNext: false,
  };
  let seq = 0;
  const nid = () => `m${++seq}`;
  const els = new Map();   // id → { root, body, think, actions, cache }

  // ── Иконки (единый набор, контурные) ───────────────────────────────────────
  const ICONS = {
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>',
    shrink: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
    expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    chev: '<path d="m9 6 6 6-6 6"/>',
    terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
    branch: '<circle cx="6" cy="5" r="2.5"/><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="9" r="2.5"/><path d="M6 7.5v9M18 11.5v.5a4 4 0 0 1-4 4h-3.5"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"/><path d="M14 3v5h5"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="1.6"/><path d="m21 15-5-5L5 21"/>',
    download: '<path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/>',
    spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z"/>',
    brain: '<path d="M9.5 2A2.5 2.5 0 0 0 7 4.5V5a3 3 0 0 0-2 5 3 3 0 0 0 1 5.4V17a3 3 0 0 0 3 3h.5V2zM14.5 2A2.5 2.5 0 0 1 17 4.5V5a3 3 0 0 1 2 5 3 3 0 0 1-1 5.4V17a3 3 0 0 1-3 3h-.5V2z"/>',
    cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
    bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
    pen: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
    paperclip: '<path d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.7 8.7a1.8 1.8 0 0 1-2.6-2.6l8-8"/>',
    edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    palette: '<circle cx="13.5" cy="6.5" r=".8"/><circle cx="17.5" cy="10.5" r=".8"/><circle cx="8.5" cy="7.5" r=".8"/><circle cx="6.5" cy="12.5" r=".8"/><path d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.3-.5-.8-.5-1.2 0-1.1.9-2 2-2h2.3A3.9 3.9 0 0 0 21 10.5C21 6.4 16.9 3 12 3z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2.5"/>',
  };
  const ic = (name, size) => `<svg class="ic" viewBox="0 0 24 24" ${size ? `width="${size}" height="${size}" ` : ''}fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;

  // ── Утилиты ──────────────────────────────────────────────────────────────
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 10 || h >= 20) ? b : c; };
  const hhmm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const haptic = (k = 'light') => { try { tg.HapticFeedback.impactOccurred(k); } catch (e) { /* не в Telegram */ } };

  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.remove('hidden');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => toastEl.classList.add('hidden'), 2600);
  }

  function rpc(name, input) {
    return new Promise((resolve, reject) => {
      if (!tg || !tg.Serverless) return reject(Object.assign(new Error('Откройте приложение из Telegram'), { type: 'NO_TG' }));
      tg.Serverless.call(name, input || {}, (err, res) => (err ? reject(err) : resolve(res)));
    });
  }
  const isEndpointErr = (e) => e && e.type === 'ENDPOINT_ERROR';

  // ── Подсветка кода (без библиотек) ────────────────────────────────────────
  const KW = {
    js: 'break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|function|if|import|in|instanceof|let|new|of|return|super|switch|throw|try|typeof|var|void|while|with|yield|async|await|static|get|set|from|as|interface|type|enum|implements|public|private|protected|readonly|declare|namespace',
    py: 'and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|match|case',
    c: 'if|else|for|while|do|switch|case|break|continue|return|goto|struct|union|enum|typedef|static|const|volatile|extern|inline|sizeof|class|public|private|protected|virtual|override|namespace|using|template|typename|new|delete|try|catch|throw|import|package|interface|extends|implements|final|abstract|void|int|long|short|char|float|double|bool|boolean|unsigned|signed|string|var|val|fun|func|fn|let|mut|impl|trait|pub|mod|use|match|go|defer|chan|select|range|map|async|await|where|in|is|as|object|when|echo|function',
    sh: 'if|then|else|elif|fi|for|while|until|do|done|case|esac|function|in|return|export|local|source|alias|unset|set|echo|cd|ls|cat|grep|sed|awk|npm|npx|git|pip|python|python3|node|sudo|apt|pkg|curl|wget|mkdir|rm|cp|mv|chmod|tar|cargo|docker',
    sql: 'select|from|where|and|or|not|insert|into|values|update|set|delete|create|table|drop|alter|add|column|index|join|left|right|inner|outer|on|as|group|by|order|having|limit|offset|union|distinct|null|is|in|like|between|primary|key|foreign|references|default|unique|count|sum|avg|min|max|case|when|then|else|end|exists|desc|asc',
  };
  const LIT = 'true|false|null|undefined|NaN|Infinity|None|True|False|nil|this|self|NULL';
  const STR = String.raw`"(?:\\[\s\S]|[^"\\\n])*"?|'(?:\\[\s\S]|[^'\\\n])*'?`;
  const NUM = String.raw`\b(?:0x[\da-f]+|0b[01]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)\b`;
  const TRIPLE = String.raw`"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)`;
  const BACKTICK = '`(?:\\\\[\\s\\S]|[^`\\\\])*`?';
  const sticky = (src, flags = '') => new RegExp(src, `y${flags}`);
  const kw = (k, flags = '') => sticky(String.raw`\b(?:${KW[k]})\b`, flags);
  const COMMON_TAIL = [
    ['l', sticky(String.raw`\b(?:${LIT})\b`)],
    ['f', sticky(String.raw`[A-Za-z_$][\w$]*(?=\s*\()`)],
    ['t', sticky(String.raw`\b[A-Z][\w$]*\b`)],
    ['', sticky(String.raw`[A-Za-z_$][\w$]*`)],
  ];
  const SLASH_COMMENT = String.raw`//[^\n]*|/\*[\s\S]*?(?:\*/|$)`;
  const RULES = {
    js: [['c', sticky(SLASH_COMMENT)], ['s', sticky(`${STR}|${BACKTICK}`)], ['n', sticky(NUM, 'i')], ['k', kw('js')], ...COMMON_TAIL],
    c: [['c', sticky(`${SLASH_COMMENT}|#[^\\n]*`)], ['s', sticky(STR)], ['n', sticky(NUM, 'i')], ['k', kw('c')], ...COMMON_TAIL],
    py: [['c', sticky(String.raw`#[^\n]*`)], ['s', sticky(`${TRIPLE}|${STR}`)], ['f', sticky(String.raw`@[\w.]+`)], ['n', sticky(NUM, 'i')], ['k', kw('py')], ...COMMON_TAIL],
    sh: [['c', sticky(String.raw`#[^\n]*`)], ['s', sticky(STR)], ['v', sticky(String.raw`\$\{[^}\n]*\}?|\$[\w@#?*!-]+`)], ['p', sticky(String.raw`--?[A-Za-z][\w-]*`)], ['n', sticky(NUM, 'i')], ['k', kw('sh')], ['', sticky(String.raw`[\w./~-]+`)]],
    sql: [['c', sticky(String.raw`--[^\n]*|/\*[\s\S]*?(?:\*/|$)`)], ['s', sticky(STR)], ['n', sticky(NUM, 'i')], ['k', kw('sql', 'i')], ['f', sticky(String.raw`[A-Za-z_]\w*(?=\s*\()`)], ['', sticky(String.raw`[A-Za-z_]\w*`)]],
    json: [['p', sticky(String.raw`"(?:\\.|[^"\\\n])*"(?=\s*:)`)], ['s', sticky(STR)], ['n', sticky(NUM, 'i')], ['l', sticky(String.raw`\b(?:true|false|null)\b`)]],
    html: [['c', sticky(String.raw`<!--[\s\S]*?(?:-->|$)`)], ['g', sticky(String.raw`</?[A-Za-z][\w:-]*|/?>`)], ['p', sticky(String.raw`[A-Za-z_:@][\w:.-]*(?==)`)], ['s', sticky(STR)]],
    css: [['c', sticky(String.raw`/\*[\s\S]*?(?:\*/|$)`)], ['s', sticky(STR)], ['k', sticky(String.raw`@[\w-]+`)], ['p', sticky(String.raw`[A-Za-z-]+(?=\s*:)`)], ['n', sticky(String.raw`#[\da-f]{3,8}\b|-?\d*\.?\d+(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?`, 'i')], ['t', sticky(String.raw`[.#][A-Za-z_][\w-]*`)], ['', sticky(String.raw`[A-Za-z_-][\w-]*`)]],
    yaml: [['c', sticky(String.raw`#[^\n]*`)], ['s', sticky(STR)], ['p', sticky(String.raw`[\w./-]+(?=:(?:\s|$))`)], ['n', sticky(NUM, 'i')], ['l', sticky(String.raw`\b(?:true|false|null|yes|no)\b`)], ['', sticky(String.raw`[\w./-]+`)]],
  };
  const FAMILY = {
    js: 'js', javascript: 'js', jsx: 'js', ts: 'js', typescript: 'js', tsx: 'js', mjs: 'js', cjs: 'js', node: 'js', vue: 'js',
    py: 'py', python: 'py', python3: 'py',
    sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', termux: 'sh',
    sql: 'sql', json: 'json', jsonc: 'json', html: 'html', xml: 'html', svg: 'html', css: 'css', scss: 'css', yaml: 'yaml', yml: 'yaml', toml: 'yaml',
    c: 'c', h: 'c', cpp: 'c', 'c++': 'c', cs: 'c', csharp: 'c', java: 'c', kotlin: 'c', kt: 'c', go: 'c', golang: 'c', rust: 'c', rs: 'c', swift: 'c', php: 'c', rb: 'c', ruby: 'c', dart: 'c', lua: 'c', scala: 'c',
    diff: 'diff', patch: 'diff',
  };

  function highlight(code, lang) {
    const fam = FAMILY[String(lang || '').toLowerCase()];
    if (!fam || code.length > 30000) return esc(code);
    if (fam === 'diff') {
      return code.split('\n').map((l) => {
        const cls = l.startsWith('@@') ? 'tk-hunk' : l.startsWith('+') ? 'tk-add' : l.startsWith('-') ? 'tk-del' : '';
        return cls ? `<span class="${cls}">${esc(l)}</span>` : esc(l);
      }).join('\n');
    }
    const rules = RULES[fam];
    let i = 0, out = '';
    while (i < code.length) {
      let hit = null;
      for (const [cls, re] of rules) {
        re.lastIndex = i;
        const m = re.exec(code);
        if (m && m[0]) { hit = [cls, m[0]]; break; }
      }
      if (hit) { out += hit[0] ? `<span class="tk-${hit[0]}">${esc(hit[1])}</span>` : esc(hit[1]); i += hit[1].length; }
      else { out += esc(code[i]); i++; }
    }
    return out;
  }

  // ── Markdown (минимальный, безопасный: всё экранируется) ───────────────
  function inline(s, codes) {
    return s
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=$|[\s).,!?:;])/g, '$1<em>$2</em>')
      .replace(/\u0000I(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
  }

  function md(src, caret) {
    const fences = [];
    let t = String(src).replace(/\r/g, '');
    // Блоки кода (в том числе ещё не закрытый — во время печати).
    t = t.replace(/```([\w+#.-]*)[ \t]*\n?([\s\S]*?)(```|$)/g, (_, lang, code) => {
      fences.push({ lang, code: code.replace(/\n$/, '') });
      return `\n\u0000C${fences.length - 1}\u0000\n`;
    });
    const ticks = [];
    t = esc(t).replace(/`([^`\n]+)`/g, (_, c) => { ticks.push(c); return `\u0000I${ticks.length - 1}\u0000`; });

    const out = [];
    let para = [], list = null;
    const flushP = () => { if (para.length) { out.push(`<p>${inline(para.join('<br>'), ticks)}</p>`); para = []; } };
    const flushL = () => {
      if (list) { out.push(`<${list.t}>${list.items.map((x) => `<li>${inline(x, ticks)}</li>`).join('')}</${list.t}>`); list = null; }
    };
    for (const line of t.split('\n')) {
      let m;
      if (/^\u0000C\d+\u0000$/.test(line.trim())) { flushP(); flushL(); out.push(line.trim()); }
      else if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flushP(); flushL(); const n = m[1].length + 1; out.push(`<h${n}>${inline(m[2], ticks)}</h${n}>`); }
      else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { flushP(); if (!list || list.t !== 'ul') { flushL(); list = { t: 'ul', items: [] }; } list.items.push(m[1]); }
      else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flushP(); if (!list || list.t !== 'ol') { flushL(); list = { t: 'ol', items: [] }; } list.items.push(m[1]); }
      else if ((m = line.match(/^&gt;\s?(.*)$/))) { flushP(); flushL(); out.push(`<blockquote>${inline(m[1], ticks)}</blockquote>`); }
      else if (!line.trim()) { flushP(); flushL(); }
      else { flushL(); para.push(line); }
    }
    flushP(); flushL();

    let html = out.join('').replace(/\u0000C(\d+)\u0000/g, (_, i) => {
      const f = fences[i];
      return `<div class="code"><div class="code-h"><span>${esc(f.lang || 'код')}</span><button class="copy" data-act="copycode">${ic('copy', 14)}Копировать</button></div><pre><code>${highlight(f.code, f.lang)}</code></pre></div>`;
    });
    if (caret) html = /<\/(p|li|h\d|blockquote)>$/.test(html) ? html.replace(/(<\/(p|li|h\d|blockquote)>)$/, '<span class="caret"></span>$1') : `${html}<span class="caret"></span>`;
    return html;
  }

  // ── Сообщения ────────────────────────────────────────────────────────────
  // Из истории: «[пользователь прислал картинку] текст\n\n📎 имя:\n```…```» → текст + плашки вложений.
  function parseUserText(content) {
    let text = String(content);
    const attach = { image: false, files: [] };
    if (text.startsWith('[пользователь прислал картинку]')) { attach.image = true; text = text.replace(/^\[пользователь прислал картинку\]\s*/, ''); }
    text = text.replace(/\n*📎 ([^\n]*?):\n```\n[\s\S]*?\n```/g, (_, name) => { attach.files.push(name); return ''; }).trim();
    return { text, attach: attach.image || attach.files.length ? attach : null };
  }

  const lastAssistant = () => { for (let i = S.messages.length - 1; i >= 0; i--) if (S.messages[i].role === 'assistant') return S.messages[i]; return null; };

  function addMessage(m) {
    m.id = nid();
    S.messages.push(m);
    return m;
  }

  const ICON = {
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
    redo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/></svg>',
  };

  function thinkHtml(m) {
    const tools = m.trace.filter((x) => x.k === 'tool');
    const thoughts = m.trace.filter((x) => x.k === 'think');
    const running = !m.done;
    const sec = Math.max(1, Math.round(((m.ms != null ? m.ms : Date.now() - m.t0)) / 1000));
    let label;
    if (running) {
      const cur = tools.filter((x) => x.state === 'run').pop();
      label = cur ? `${cur.label}…` : m.text ? 'Пишет…' : 'Думает…';
    } else if (tools.length || thoughts.length) {
      label = `Думал ${sec} с${tools.length ? ` · ${tools.length} ${plural(tools.length, 'команда', 'команды', 'команд')}` : ''}`;
    } else {
      label = `Ответил за ${sec} с`;
    }
    const expandable = running || tools.length || thoughts.length;
    const chip = `<button class="chip ${running ? 'run' : ''} ${m.open ? 'open' : ''}" ${expandable ? 'data-act="think"' : 'disabled'}><span class="dot"></span><span class="lbl">${esc(label)}</span>${expandable ? `<span class="chev">${ic('chev')}</span>` : ''}</button>`;
    if (!m.open || !expandable) return chip;

    const items = m.trace.map((x) => {
      if (x.k === 'think') return `<div class="t-think">${md(x.t)}</div>`;
      const open = m.openTools.has(x.id);
      const icon = x.state === 'run' ? '<span class="spin"></span>' : x.state === 'err' ? ic('x', 14) : ic('check', 14);
      const kind = /^github_/.test(x.name) ? 'branch' : x.name === 'create_file' ? 'file' : /image/.test(x.name) ? 'image' : 'terminal';
      const detail = open ? `<pre class="t-out">${esc(`${x.name}(${JSON.stringify(x.args || {})})\n\n${x.out || '…'}`)}</pre>` : '';
      return `<div class="t-tool ${x.state}"><button class="t-row" data-act="tool" data-id="${esc(x.id)}"><span class="st">${icon}</span>${ic(kind, 15)}<span class="lbl">${esc(x.label || x.name)}</span><span class="ms">${x.ms != null ? `${(x.ms / 1000).toFixed(1)} с` : ''}</span></button>${detail}</div>`;
    });
    if (running && m.live) items.push(`<div class="t-think live">${md(m.live)}</div>`);
    if (!items.length) items.push('<div class="t-think live">Размышляет…</div>');
    return `${chip}<div class="think-body">${items.join('')}</div>`;
  }

  // Кнопки под сообщением бота — как inline-клавиатура в Telegram.
  // Кнопки под ответом: аккуратные «таблетки» с иконками.
  function actionsHtml(m) {
    if (!m.done || m.typing || m.error || !(m.text || m.image || (m.files && m.files.length))) return '';
    const last = m === lastAssistant();
    const btns = [];
    if (last && S.hasLast && !S.busy && m.text) {
      btns.push(`<button class="kbtn" data-act="again">${ic('refresh')}Заново</button>`);
      btns.push(`<button class="kbtn" data-act="short">${ic('shrink')}Короче</button>`);
      btns.push(`<button class="kbtn" data-act="long">${ic('expand')}Подробнее</button>`);
    }
    if (m.text) btns.push(`<button class="kbtn" data-act="copy">${ic('copy')}Копировать</button>`);
    return btns.length ? `<div class="kb">${btns.join('')}</div>` : '';
  }

  const kbSize = (n) => (n < 1024 ? `${n} Б` : `${(n / 1024).toFixed(1)} КБ`);

  // Картинка (или заглушка, пока рисуется) и карточки файлов под текстом ответа.
  function extrasHtml(m) {
    const parts = [];
    const drawing = !m.done && !m.image && m.trace.some((x) => x.k === 'tool' && (x.name === 'generate_image' || x.name === 'edit_image'));
    if (m.image || drawing) {
      if (m.imgData) {
        const note = m.image && m.image.sent ? `<span class="gen-note">${ic('check')}Отправлено вам в чат</span>` : '<span class="gen-note"></span>';
        parts.push(`<div class="genimg"><img src="${m.imgData}" alt="Картинка" data-act="imgview"><div class="gen-act">${note}<button class="mini" data-act="imgdoc">${ic('download')}Файлом</button></div></div>`);
      } else if (m.imgErr) {
        parts.push(`<div class="muted">${m.image && m.image.sent ? 'Картинка уже у вас в чате с ботом.' : 'Картинка недоступна — попросите нарисовать заново.'}</div>`);
      } else {
        parts.push(`<div class="gen-ph"><span class="spin"></span>${m.image ? 'Загружаю…' : 'Рисую…'}</div>`);
      }
    }
    (m.files || []).forEach((f, i) => {
      const where = f.sent ? `<span class="ok">${ic('check')}в чате</span>` : '<span class="ok">в чат не отправился</span>';
      parts.push(`<div class="filecard"><div class="fi">${ic('file', 22)}</div><div class="fm"><b>${esc(f.name)}</b><span><span>${kbSize(f.size)}</span>${where}</span></div>${f.text != null ? `<div class="acts"><button class="mini" data-act="fcopy" data-i="${i}" aria-label="Копировать">${ic('copy')}</button><button class="mini" data-act="fdl" data-i="${i}" aria-label="Скачать">${ic('download')}</button></div>` : ''}</div>`);
    });
    return parts.join('');
  }

  function msgEl(m) {
    let e = els.get(m.id);
    if (e) return e;
    const root = document.createElement('div');
    root.className = `msg ${m.role}`;
    root.dataset.id = m.id;
    if (m.role === 'user') {
      const a = m.attach;
      const att = a ? `${a.image ? (typeof a.image === 'string' ? `<img class="att-img" src="${a.image}" alt="">` : `<div class="att-file">${ic('image', 15)}Картинка</div>`) : ''}${(a.files || []).map((n) => `<div class="att-file">${ic('paperclip', 15)}${esc(n)}</div>`).join('')}` : '';
      root.innerHTML = `<div class="bubble me">${att}${m.text ? `<div>${esc(m.text)}</div>` : ''}${m.at ? `<span class="stamp">${hhmm(m.at)}</span>` : ''}</div>`;
      e = { root };
    } else {
      root.innerHTML = '<div class="bubble bot"><div class="a-body"></div><div class="extras"></div><div class="think"></div><div class="stamp"></div></div><div class="kb-w"></div>';
      e = { root, bubble: root.querySelector('.bubble'), body: root.querySelector('.a-body'), extras: root.querySelector('.extras'), think: root.querySelector('.think'), stamp: root.querySelector('.stamp'), actions: root.querySelector('.kb-w'), cache: {} };
    }
    els.set(m.id, e);
    listEl.appendChild(root);
    return e;
  }

  function setHtml(e, key, node, html) {
    if (e.cache[key] === html) return;
    e.cache[key] = html;
    const keep = node.querySelector('.think-body');
    const top = keep ? keep.scrollTop : 0;
    node.innerHTML = html;
    const nb = node.querySelector('.think-body');
    if (nb && top) nb.scrollTop = top;
  }

  function renderMsg(m) {
    const e = msgEl(m);
    if (m.role === 'user') return;
    const shown = m.typing ? m.text.slice(0, Math.floor(m.shown)) : m.text;
    let body = '';
    if (m.error) body = `<div class="a-error"><span>⚠️ ${esc(m.error)}</span><button data-act="retry">Повторить</button></div>`;
    else if (shown) body = md(shown, m.typing || !m.done);
    else if (!m.done) body = '<span class="typing" aria-label="печатает"><i></i><i></i><i></i></span>';   // мигающие точки, пока ответа ещё нет
    const extras = m.role === 'assistant' ? extrasHtml(m) : '';
    e.bubble.classList.toggle('hidden', !body && !m.error && !extras);
    setHtml(e, 'body', e.body, body);
    setHtml(e, 'extras', e.extras, extras);
    if (m.at && m.done && !m.typing && !m.error) setHtml(e, 'stamp', e.stamp, hhmm(m.at + (m.ms || 0)));
    setHtml(e, 'think', e.think, m.restored || (m.error && !m.trace.length) ? '' : thinkHtml(m));
    setHtml(e, 'actions', e.actions, actionsHtml(m));
  }

  function renderAll() {
    listEl.querySelectorAll('.empty').forEach((n) => n.remove());
    for (const m of S.messages) renderMsg(m);
    for (const [id, e] of els) if (!S.messages.some((m) => m.id === id)) { e.root.remove(); els.delete(id); }
    if (!S.messages.length) renderEmpty();
    updateComposer();
  }

  function renderEmpty() {
    if (listEl.querySelector('.empty')) return;
    const div = document.createElement('div');
    div.className = 'empty';
    const ideas = [
      ['bulb', 'Объясни просто', 'как работает нейросеть', 'Объясни простыми словами, как работает нейросеть'],
      ['list', 'План на неделю', 'разложить дела по дням', 'Помоги составить план на неделю'],
      ['code', 'Напиши код', 'скрипт на Python', 'Напиши на Python скрипт, который переименовывает файлы в папке'],
      ['image', 'Нарисуй', 'кот-астронавт на Луне', 'Нарисуй кота-астронавта на Луне'],
    ];
    div.innerHTML = `<div class="logo">${ic('moon')}</div><h1>${S.name ? `Привет, ${esc(S.name.split(' ')[0])}` : 'Привет'}</h1><p>Я Луна. Спросите что угодно — покажу, как думаю.</p>
      ${S.configured ? '' : '<div class="notice">ИИ ещё не настроен владельцем бота.</div>'}
      <div class="cards">${ideas.map((c) => `<button class="card" data-idea="${esc(c[3])}"><span class="ci">${ic(c[0], 18)}</span><b>${c[1]}</b><span>${c[2]}</span></button>`).join('')}</div>`;
    listEl.appendChild(div);
  }

  // ── Автопрокрутка и плавная «печать» ───────────────────────────────────
  let stick = true;
  chatEl.addEventListener('scroll', () => { stick = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 90; }, { passive: true });
  const toBottom = (smooth) => { if (stick) chatEl.scrollTo({ top: chatEl.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); };

  // Текст приходит кусками раз в ~0.5 с, а на экране он «печатается» непрерывно.
  let raf = 0, lastPaint = 0;
  function loop(ts) {
    raf = 0;
    let more = false;
    for (const m of S.messages) {
      if (!m.typing) continue;
      const gap = m.text.length - m.shown;
      if (gap > 0) {
        m.shown += Math.max(m.done ? 3 : 1, gap * (m.done ? 0.2 : 0.1));
        if (m.shown > m.text.length) m.shown = m.text.length;
        more = true;
      } else if (m.done) {
        m.typing = false;
        renderMsg(m);
        updateComposer();
        continue;
      }
      if (ts - lastPaint > 45) { renderMsg(m); lastPaint = ts; }
      more = more || !m.done;
    }
    toBottom(false);
    if (more || S.messages.some((x) => x.typing)) raf = requestAnimationFrame(loop);
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };

  // ── Отправка и ход выполнения ────────────────────────────────────────────
  function applyRun(m, r) {
    if (!r) return;
    // Промежуточный текст может «откатиться» (новый шаг с командами) — принимаем только рост, а итог — всегда.
    const next = r.text || '';
    if (next.length >= (m.text || '').length || r.done) {
      if (!next.startsWith((m.text || '').slice(0, Math.floor(m.shown)))) m.shown = 0;   // итог не продолжает показанное — печатаем заново
      m.text = next;
    }
    m.trace = (r.trace || []).map((x) => ({ ...x }));
    m.live = r.live || '';
    m.files = r.files || [];
    if (r.image) {
      m.image = r.image;
      if (!m.imgData && !m.imgLoading) {
        m.imgLoading = true;
        const load = async () => {
          for (let t = 0; t < 4; t++) {   // тяжёлый ответ может не пройти с первого раза — пробуем ещё
            try { const res = await rpc('image', { runId: r.image.id }); m.imgData = res.dataUrl; break; } catch (e) { if (t < 3) await sleep(700 * (t + 1)); }
          }
          if (!m.imgData) m.imgErr = true;
          renderMsg(m); toBottom(true);
        };
        load();
      }
    }
    if (r.done) { m.done = true; m.ms = r.ms; m.error = r.error || null; if (m.error) m.typing = false; }
    if (m.text && !m.error) m.typing = true;
    renderMsg(m);
    kick();
  }

  // Читаем прогресс, пока запрос не завершится. Зависший запуск закрывает сервер (poll вернёт done+error),
  // а у клиента есть ещё и свой потолок и кнопка «Стоп» — приложение не может «застрять».
  async function follow(m, runId, stopped) {
    let misses = 0;
    const t0 = Date.now();
    while (!m.done && !stopped() && Date.now() - t0 < 10 * 60 * 1000) {
      await sleep(m.text || m.trace.length ? 650 : 900);
      if (m.done || stopped()) break;
      try {
        const res = await rpc('poll', { runId });
        if (res && res.run) { misses = 0; applyRun(m, res.run); }
        else if (++misses > 20) break;
      } catch (e) { if (++misses > 10) break; }
    }
  }

  // Второй этап: картинку рисует отдельный запрос со своим запасом времени.
  async function drawImage(m, runId, stopped) {
    const r = await rpc('makeImage', { runId });
    if (!stopped()) applyRun(m, r);
    return r;
  }

  const plainFail = (m, text) => { if (!m.done) { m.done = true; m.error = text; m.typing = false; m.ms = Date.now() - m.t0; } };

  async function ask({ text, mode = null, regen = false, again = false, images = [], files = [] }) {
    if (S.busy) return;
    if (!regen && !mode && !again && !text.trim() && !images.length && !files.length) return;
    S.busy = true;
    stick = true;
    haptic('light');

    if (regen || mode) {
      const prev = lastAssistant();
      if (prev) S.messages.splice(S.messages.indexOf(prev), 1);
    }
    if (!regen && !mode && !again) {
      const attach = images.length || files.length ? { image: images[0] || false, files: files.map((f) => f.name) } : null;
      addMessage({ role: 'user', text: text.trim(), at: Date.now(), attach });
    }
    const m = addMessage({ role: 'assistant', text: '', shown: 0, trace: [], live: '', done: false, typing: false, open: false, openTools: new Set(), t0: Date.now(), at: Date.now(), ms: null, error: null });
    const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const run = { m, runId, stopped: false, finished: false };
    S.run = run;
    const stopped = () => run.stopped || run.finished;
    renderAll();
    toBottom(true);

    const payload = { text, mode, regen: regen || undefined, runId, images, files: files.map((f) => ({ name: f.name, text: f.text })), force: S.forceNext || undefined };
    const poller = follow(m, runId, stopped);
    try {
      let res;
      try {
        res = await rpc('send', payload);
      } catch (e) {
        // Сервер ещё считает прошлый запуск живым (мы его остановили, а отмена не дошла) — закрываем и пробуем ещё раз.
        if (isEndpointErr(e) && e.parameters && e.parameters.code === 'BUSY') {
          await rpc('cancel', {}).catch(() => {});
          res = await rpc('send', { ...payload, force: true });
        } else throw e;
      }
      S.forceNext = false;
      if (run.stopped) return;
      applyRun(m, res);
      S.hasLast = true;
      if (res.pending && !run.stopped) await drawImage(m, runId, stopped);
      run.finished = true;
    } catch (e) {
      if (run.stopped) return;
      run.finished = true;
      if (isEndpointErr(e)) { plainFail(m, e.message); }
      else {
        // Связь оборвалась, а сервер, возможно, ещё работает — дочитываем прогресс (это ограничено, и есть «Стоп»).
        run.finished = false;
        await poller;
        run.finished = true;
        plainFail(m, 'Связь прервалась. Нажмите «Повторить».');
      }
    } finally {
      run.finished = true;
      if (S.run === run) { S.run = null; S.busy = false; }
      renderAll();
      kick();
    }
  }

  // «Стоп»: перестаём ждать, закрываем запуск на сервере и сразу разблокируем ввод.
  function stopRun() {
    const run = S.run;
    if (!run) { S.busy = false; updateComposer(); return; }
    run.stopped = true;
    const m = run.m;
    if (!m.done) { m.done = true; m.ms = Date.now() - m.t0; m.typing = false; m.live = ''; if (!m.text && !m.image) m.error = 'Остановлено'; }
    S.run = null; S.busy = false; S.forceNext = true;
    rpc('cancel', { runId: run.runId }).catch(() => {});
    haptic('light');
    renderAll();
  }

  async function sendFromInput() {
    const text = inputEl.value.trim();
    const { image, files } = S.pending;
    if (!text && !image && !files.length) return;
    if (S.busy) { toast('Луна ещё отвечает — нажмите ■, чтобы остановить'); return; }
    inputEl.value = '';
    S.pending = { image: null, files: [] };
    renderTray();
    autosize();
    updateComposer();
    await ask({ text, images: image ? [image.dataUrl] : [], files });
  }

  // ── Ввод ─────────────────────────────────────────────────────────────────
  function autosize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 156)}px`;
  }
  function updateComposer() {
    sendEl.disabled = !S.busy && !(inputEl.value.trim() || S.pending.image || S.pending.files.length);   // во время ответа кнопка — «Стоп»
    sendEl.classList.toggle('stop', S.busy);
    sendEl.setAttribute('aria-label', S.busy ? 'Остановить' : 'Отправить');
    inputEl.placeholder = S.busy ? 'Можно печатать, пока Луна отвечает…' : 'Сообщение Луне…';
    statusEl.textContent = S.busy ? 'печатает…' : 'в сети';
    statusEl.classList.toggle('typing-now', S.busy);
  }
  inputEl.addEventListener('input', () => { autosize(); updateComposer(); });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(pointer:fine)').matches) { e.preventDefault(); if (!S.busy) sendFromInput(); }
  });
  sendEl.addEventListener('click', () => { if (S.busy) stopRun(); else sendFromInput(); });

  // ── Вложения ─────────────────────────────────────────────────────────────
  const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|csv|tsv|log|js|mjs|cjs|jsx|ts|tsx|py|rb|php|java|kt|c|h|cpp|hpp|cs|go|rs|swift|sh|bash|zsh|sql|html|htm|css|scss|xml|yml|yaml|toml|ini|cfg|conf|env|lua|dart|vue|svelte)$/i;

  const readText = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });

  // Картинку уменьшаем и сжимаем в JPEG: передача идёт одним запросом, тяжёлые фото не пролезут.
  function shrinkImage(file, maxSide = 2048, quality = 0.92, limit = 1800000) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        let max = maxSide, q = quality, data = '';
        for (let i = 0; i < 5; i++) {
          const k = Math.min(1, max / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
          const g = c.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
          data = c.toDataURL('image/jpeg', q);
          if (data.length < limit) break;
          max = Math.round(max * 0.8); q = Math.max(0.6, q - 0.06);
        }
        URL.revokeObjectURL(url);
        resolve(data);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
      img.src = url;
    });
  }

  async function addFiles(list) {
    for (const f of Array.from(list || [])) {
      try {
        if (f.type.startsWith('image/')) {
          S.pending.image = { dataUrl: await shrinkImage(f), name: f.name || 'photo.jpg' };   // до 2048 px, JPEG ~92% — хватает для правок
        } else if (f.type.startsWith('text/') || f.type === 'application/json' || TEXT_EXT.test(f.name)) {
          if (f.size > 400000) { toast(`«${f.name}» больше 400 КБ`); continue; }
          if (S.pending.files.length >= 3) { toast('Не больше 3 файлов за раз'); continue; }
          const text = await readText(f);
          if (!text.trim()) { toast(`«${f.name}» пустой`); continue; }
          S.pending.files.push({ name: f.name, text: text.slice(0, 60000) });
          if (text.length > 60000) toast(`«${f.name}»: прочитаю первые 60 000 символов`);
        } else {
          toast('Такой формат пока не читаю: подойдут фото, текст и код');
        }
      } catch (e) { toast(`Не удалось открыть «${f.name}»`); }
    }
    renderTray();
    updateComposer();
  }

  function renderTray() {
    const { image, files } = S.pending;
    const items = [];
    if (image) items.push(`<div class="att"><img src="${image.dataUrl}" alt=""><span>Фото</span><button class="rm" data-rm="img" aria-label="Убрать">${ic('x', 12)}</button></div>`);
    files.forEach((f, i) => items.push(`<div class="att">${ic('paperclip', 16)}<span>${esc(f.name)}</span><button class="rm" data-rm="${i}" aria-label="Убрать">${ic('x', 12)}</button></div>`));
    trayEl.innerHTML = items.join('');
    trayEl.classList.toggle('hidden', !items.length);
  }
  trayEl.addEventListener('click', (ev) => {
    const rm = ev.target.closest('[data-rm]');
    if (!rm) return;
    if (rm.dataset.rm === 'img') S.pending.image = null; else S.pending.files.splice(Number(rm.dataset.rm), 1);
    renderTray(); updateComposer();
  });
  attachEl.addEventListener('click', () => { haptic('light'); fileEl.click(); });
  fileEl.addEventListener('change', async () => { const list = Array.from(fileEl.files || []); fileEl.value = ''; await addFiles(list); });
  inputEl.addEventListener('paste', (ev) => {   // фото из буфера обмена
    const files = Array.from((ev.clipboardData && ev.clipboardData.files) || []);
    if (files.length) { ev.preventDefault(); addFiles(files); }
  });

  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  // ── Копирование ──────────────────────────────────────────────────────────
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); }
    catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (err) { /* ничего */ }
      ta.remove();
    }
    haptic('light');
    toast('Скопировано');
  }

  // ── Клики по ленте (делегирование) ──────────────────────────────────────
  listEl.addEventListener('click', (ev) => {
    const idea = ev.target.closest('[data-idea]');
    if (idea) { inputEl.value = idea.dataset.idea; autosize(); sendFromInput(); return; }
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const root = btn.closest('.msg');
    const m = root && S.messages.find((x) => x.id === root.dataset.id);
    switch (btn.dataset.act) {
      case 'think': if (m) { m.open = !m.open; haptic('light'); renderMsg(m); } break;
      case 'tool': if (m) { const id = btn.dataset.id; m.openTools.has(id) ? m.openTools.delete(id) : m.openTools.add(id); renderMsg(m); } break;
      case 'copy': if (m) copy(m.text); break;
      case 'imgview': if (m && m.imgData) openSheet(`<img class="bigimg" src="${m.imgData}" alt="">`); break;
      case 'imgdoc':
        rpc('deliver', { as: 'document' }).then(() => toast('Отправил файлом в чат')).catch((e) => toast(e.message || 'Не получилось'));
        break;
      case 'fcopy': if (m && m.files && m.files[btn.dataset.i]) copy(m.files[btn.dataset.i].text); break;
      case 'fdl':
        if (m && m.files && m.files[btn.dataset.i]) { const f = m.files[btn.dataset.i]; download(f.name, f.text); toast('Если файл не скачался — он уже у вас в чате с ботом'); }
        break;
      case 'copycode': copy(btn.closest('.code').querySelector('code').textContent); break;
      case 'again': ask({ regen: true, text: '' }); break;
      case 'short': ask({ mode: 'short', text: '' }); break;
      case 'long': ask({ mode: 'long', text: '' }); break;
      case 'retry': {
        const idx = S.messages.indexOf(m);
        const q = idx > 0 && S.messages[idx - 1].role === 'user' ? S.messages[idx - 1].text : '';
        if (m) S.messages.splice(idx, 1);
        if (q) ask({ text: q, again: true }); else renderAll();
        break;
      }
      default:
    }
  });

  // ── Шторки: глубина мышления и меню ─────────────────────────────────────
  const DEPTH_INFO = {
    auto: ['', 'Авто', 'Как настроил владелец бота'],
    fast: ['', 'Быстро', 'Отвечаю сразу — для простых вопросов'],
    normal: ['', 'Обычно', 'Баланс скорости и качества'],
    deep: ['', 'Глубоко', 'Долго думаю: сложные задачи, математика, код'],
  };
  const depthLabel = () => (DEPTH_INFO[S.depth] || DEPTH_INFO.auto)[1];
  const DEPTH_ORDER = ['fast', 'normal', 'deep', 'auto'];
  const paintDepth = () => {
    effortEl.style.setProperty('--i', Math.max(0, DEPTH_ORDER.indexOf(S.depth)));
    effortEl.querySelectorAll('[data-depth]').forEach((b) => b.classList.toggle('on', b.dataset.depth === S.depth));
  };

  function openSheet(html) {
    sheetEl.innerHTML = `<div class="grab"></div>${html}`;
    sheetEl.classList.remove('hidden');
    overlayEl.classList.remove('hidden');
    overlayEl.classList.remove('soft');
    sheetEl.scrollTop = 0;
  }
  function closeSheet() { sheetEl.classList.add('hidden'); overlayEl.classList.add('hidden'); overlayEl.classList.remove('soft'); }
  overlayEl.addEventListener('click', closeSheet);

  effortEl.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-depth]');
    if (!btn) return;
    S.depth = btn.dataset.depth; paintDepth(); haptic('light');
    try { await rpc('setDepth', { depth: S.depth }); toast(`${depthLabel()} — выбрано`); } catch (e) { toast('Не удалось сохранить'); }
  });

  const row = (icon, title, sub, attrs, tail = '') => `<button class="opt" ${attrs}><span class="em">${ic(icon)}</span><span class="tx"><b>${title}</b><span>${sub}</span></span>${tail}</button>`;

  function menuHtml() {
    const gh = S.github;
    return `<h3>Меню</h3>
      ${row('palette', 'Оформление', 'Тема, обои, цвет акцента', 'data-menu="look"')}
      ${row('pen', 'Новый чат', 'Сбросить диалог, память о вас останется', 'data-menu="new"')}
      <h4>GitHub · только чтение</h4>
      ${gh.connected
        ? `<p class="muted">Подключён: <b>@${esc(gh.login)}</b>. Просите: «что в README моего репозитория…», «найди в коде…», «какие открытые issues».</p>
           <div class="row"><button class="btn danger" data-menu="ghoff">Отключить</button></div>`
        : `<p class="muted">Токен fine-grained с правами Read-only: Contents, Issues, Pull requests, Metadata (github.com/settings/personal-access-tokens/new).</p>
           <input id="ghToken" class="field" type="password" placeholder="github_pat_…" autocomplete="off" autocapitalize="off" spellcheck="false">
           <div class="row"><button class="btn" data-menu="ghon">Подключить</button></div>`}
      <h4>Что я помню о вас</h4>
      ${S.facts.length ? `<ul class="facts">${S.facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '<p class="muted">Пока ничего — расскажите о себе в чате.</p>'}
      ${S.owner && S.models ? `<h4>Модели · только админ</h4>
        ${row('brain', 'Основная', esc(S.models.model || '—'), 'data-menu="pick" data-kind="model"')}
        ${row('bolt', 'Быстрая', `${esc(S.models.fast || 'как основная')} · для «Короче» и сводок`, 'data-menu="pick" data-kind="fast"')}
        ${row('image', 'Для картинок', esc(S.models.image || '—'), 'data-menu="pick" data-kind="image"')}` : ''}
      <p class="muted" style="margin-top:18px;text-align:center;font-size:12.5px">Luna · версия ${VERSION}</p>`;
  }

  // ── Выбор модели (только админы; сервер проверяет это сам) ───────────────
  const PICK_TITLE = { model: 'Основная модель', fast: 'Быстрая модель', image: 'Модель для картинок' };
  async function openPicker(kind) {
    openSheet(`<h3>${PICK_TITLE[kind]}</h3><p class="muted">Загружаю список…</p>`);
    let data;
    try { data = await rpc('models'); } catch (e) { openSheet(menuHtml()); toast(e.message || 'Не получилось'); return; }
    S.models = data.current;
    const cur = data.current[kind] || '';
    const list = data.list;
    const draw = (q) => {
      const needle = q.trim().toLowerCase();
      const items = list.filter((id) => id.toLowerCase().includes(needle)).slice(0, 80);
      const own = needle && !list.includes(q.trim()) ? `<button class="opt" data-model="${esc(q.trim())}"><span class="em">${ic('edit')}</span><span class="tx"><b>Использовать «${esc(q.trim())}»</b><span>ввести название вручную</span></span></button>` : '';
      const off = kind === 'fast' ? `<button class="opt" data-model="off"><span class="em">${ic('refresh')}</span><span class="tx"><b>Как основная</b><span>без отдельной быстрой модели</span></span>${!cur ? ic('check') .replace('class="ic"', 'class="ic ck"') : ''}</button>` : '';
      return `${off}${own}${items.map((id) => `<button class="opt" data-model="${esc(id)}"><span class="em">${ic(id === cur ? 'check' : 'cpu')}</span><span class="tx"><b>${esc(id)}</b></span></button>`).join('') || (own ? '' : '<p class="muted">Ничего не найдено</p>')}`;
    };
    openSheet(`<h3>${PICK_TITLE[kind]}</h3><p class="muted">Сейчас: <b>${esc(cur || 'как основная')}</b></p>
      <input id="mq" class="field" placeholder="Поиск или своё название" autocomplete="off" autocapitalize="off" spellcheck="false">
      <div id="mlist" style="margin-top:8px">${draw('')}</div>`);
    sheetEl.dataset.kind = kind;
    sheetEl._draw = draw;
  }
  sheetEl.addEventListener('change', (ev) => { if (ev.target.id === 'wallFile' && ev.target.files && ev.target.files[0]) pickWallpaper(ev.target.files[0]); });
  sheetEl.addEventListener('input', (ev) => {
    if (ev.target.id === 'scrim') { P.scrim = Number(ev.target.value); document.documentElement.style.setProperty('--scrim', String(P.scrim)); savePrefs(); return; }
    if (ev.target.id === 'mq' && sheetEl._draw) $('#mlist').innerHTML = sheetEl._draw(ev.target.value);
  });
  menuBtn.addEventListener('click', () => { haptic('light'); sheetEl._draw = null; openSheet(menuHtml()); });

  sheetEl.addEventListener('click', async (ev) => {
    const th = ev.target.closest('[data-pref-theme]');
    if (th) { P.theme = th.dataset.prefTheme; savePrefs(); applyPrefs(); openSheet(appearanceHtml()); overlayEl.classList.add('soft'); return; }
    const wl = ev.target.closest('[data-pick-wall]');
    if (wl) { P.wall = wl.dataset.pickWall; savePrefs(); applyPrefs(); openSheet(appearanceHtml()); overlayEl.classList.add('soft'); haptic('light'); return; }
    const ac = ev.target.closest('[data-accent]');
    if (ac) { P.accent = ac.dataset.accent; savePrefs(); applyPrefs(); openSheet(appearanceHtml()); overlayEl.classList.add('soft'); haptic('light'); return; }
    const mdl = ev.target.closest('[data-model]');
    if (mdl && sheetEl.dataset.kind) {
      const kind = sheetEl.dataset.kind;
      try {
        const r = await rpc('setModel', { kind, id: mdl.dataset.model });
        S.models = r.current; sheetEl._draw = null; delete sheetEl.dataset.kind;
        openSheet(menuHtml()); toast('Модель сохранена');
      } catch (e) { toast(e.message || 'Не получилось'); }
      return;
    }
    const act = ev.target.closest('[data-menu]');
    if (!act) return;
    switch (act.dataset.menu) {
      case 'new': {
        const go = async () => {
          try { await rpc('resetChat'); S.messages = []; S.hasLast = false; closeSheet(); renderAll(); toast('Новый чат'); } catch (e) { toast('Не получилось'); }
        };
        if (tg && tg.showConfirm) tg.showConfirm('Начать новый чат? Текущий диалог будет сброшен.', (ok) => ok && go()); else go();
        break;
      }
      case 'ghon': {
        const token = ($('#ghToken') || {}).value || '';
        act.disabled = true;
        try {
          const r = await rpc('github', { action: 'connect', token });
          S.github = { connected: true, login: r.login };
          openSheet(menuHtml());
          toast(r.wide ? 'Подключено. У токена широкие права — лучше только чтение' : 'GitHub подключён');
        } catch (e) { act.disabled = false; toast(e.message || 'Не получилось'); }
        break;
      }
      case 'look': openAppearance(); break;
      case 'wallfile': { const f = $('#wallFile'); if (f) f.click(); break; }
      case 'pick': openPicker(act.dataset.kind); break;
      case 'ghoff':
        try { await rpc('github', { action: 'disconnect' }); S.github = { connected: false, login: null }; openSheet(menuHtml()); toast('GitHub отключён'); } catch (e) { toast('Не получилось'); }
        break;
      default:
    }
  });

  // ── Оформление: тема, обои, акцент (хранится на устройстве) ──────────────
  const PREF_KEY = 'luna.prefs.v1', WALL_KEY = 'luna.wall.v1';
  const P = { theme: 'auto', wall: 'aurora', accent: 'violet', scrim: 25 };
  let customWall = '';
  try { Object.assign(P, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); customWall = localStorage.getItem(WALL_KEY) || ''; } catch (e) { /* без localStorage — настройки живут до закрытия */ }
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(P)); } catch (e) { /* ничего */ } };
  const WALLS = [['aurora', 'Аврора'], ['sunset', 'Закат'], ['ocean', 'Океан'], ['forest', 'Лес'], ['rose', 'Роза'], ['graphite', 'Графит'], ['dots', 'Точки'], ['plain', 'Чисто']];
  const ACCENTS = { violet: ['#7c5cff', '#3b9bff'], blue: ['#2f7bff', '#35c7ff'], rose: ['#ff5c8a', '#ff9a5c'], emerald: ['#14b87a', '#2bd4c4'], amber: ['#ff9f1c', '#ff5c5c'] };
  const wallEl = $('#wall'), themeBtn = $('#themeBtn');

  const systemDark = () => (tg && tg.colorScheme ? tg.colorScheme === 'dark' : Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches));
  const effectiveTheme = () => (P.theme === 'auto' ? (systemDark() ? 'dark' : 'light') : P.theme);

  function applyPrefs() {
    const root = document.documentElement;
    const th = effectiveTheme();
    root.dataset.theme = th;
    const [a1, a2] = ACCENTS[P.accent] || ACCENTS.violet;
    root.style.setProperty('--a1', a1); root.style.setProperty('--a2', a2);
    root.style.setProperty('--scrim', String(P.scrim));
    const custom = P.wall === 'custom' && customWall;
    wallEl.dataset.wall = custom ? 'custom' : (WALLS.some((w) => w[0] === P.wall) ? P.wall : 'aurora');
    wallEl.style.backgroundImage = custom ? `url(${customWall})` : '';
    themeBtn.innerHTML = ic(th === 'dark' ? 'sun' : 'moon', 22);
    try {
      const col = th === 'dark' ? '#0e0f13' : '#f4f5fa';
      if (tg && tg.setHeaderColor) tg.setHeaderColor(col);
      if (tg && tg.setBackgroundColor) tg.setBackgroundColor(col);
    } catch (e) { /* старые клиенты */ }
  }
  themeBtn.addEventListener('click', () => { P.theme = effectiveTheme() === 'dark' ? 'light' : 'dark'; savePrefs(); applyPrefs(); haptic('light'); });

  function appearanceHtml() {
    const tile = (id, label) => `<button class="wall-tile ${P.wall === id ? 'on' : ''}" data-wall="${id}" data-pick-wall="${id}" aria-label="${label}"><span>${label}</span></button>`;
    const mine = customWall ? `<button class="wall-tile ${P.wall === 'custom' ? 'on' : ''}" data-pick-wall="custom" data-wall="custom" style="background-image:url(${customWall})" aria-label="Своё фото"><span>Своё</span></button>` : '';
    return `<h3>Оформление</h3>
      <h4>Тема</h4>
      <div class="seg3">${[['auto', 'Авто', 'spark'], ['light', 'Светлая', 'sun'], ['dark', 'Тёмная', 'moon']].map((t) => `<button data-pref-theme="${t[0]}" class="${P.theme === t[0] ? 'on' : ''}">${ic(t[2], 16)}${t[1]}</button>`).join('')}</div>
      <h4>Обои</h4>
      <div class="walls">${WALLS.map((w) => tile(w[0], w[1])).join('')}${mine}<button class="wall-tile upload" data-menu="wallfile">${ic('image')}<span>Своё фото</span></button></div>
      <input id="wallFile" type="file" accept="image/*" hidden>
      <h4>Затемнение обоев</h4>
      <input id="scrim" type="range" min="0" max="70" step="5" value="${P.scrim}">
      <h4>Цвет акцента</h4>
      <div class="accents">${Object.entries(ACCENTS).map(([k, c]) => `<button class="acc ${P.accent === k ? 'on' : ''}" data-accent="${k}" style="--c1:${c[0]};--c2:${c[1]}" aria-label="${k}">${ic('check')}</button>`).join('')}</div>`;
  }
  function openAppearance() { sheetEl.dataset.kind = ''; openSheet(appearanceHtml()); overlayEl.classList.add('soft'); }

  async function pickWallpaper(file) {
    try {
      const data = await shrinkImage(file, 1280, 0.8);
      try { localStorage.setItem(WALL_KEY, data); } catch (e) { toast('Фото слишком тяжёлое для хранения на устройстве'); return; }
      customWall = data; P.wall = 'custom'; savePrefs(); applyPrefs(); openSheet(appearanceHtml()); overlayEl.classList.add('soft');
    } catch (e) { toast('Не удалось открыть фото'); }
  }

  // ── Клавиатура и высота экрана ───────────────────────────────────────────
  function fitViewport() {
    const vv = window.visualViewport;
    document.documentElement.style.setProperty('--vh', `${vv ? vv.height : window.innerHeight}px`);
    toBottom(false);
  }
  if (window.visualViewport) window.visualViewport.addEventListener('resize', fitViewport);
  window.addEventListener('resize', fitViewport);

  // ── Старт ────────────────────────────────────────────────────────────────
  async function init() {
    applyPrefs();
    if (tg && tg.onEvent) tg.onEvent('themeChanged', applyPrefs);
    if (tg) {
      try {
        tg.ready(); tg.expand();
        if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();   // чтобы прокрутка чата не закрывала приложение
        if (tg.setHeaderColor) tg.setHeaderColor('bg_color');
      } catch (e) { /* старые клиенты */ }
    }
    fitViewport();
    paintDepth();
    renderAll();
    try {
      const st = await rpc('state');
      Object.assign(S, { name: st.name, owner: st.owner, configured: st.configured, model: st.model, models: st.models, depth: st.depth, github: st.github, facts: st.facts, hasLast: st.hasLast });
      S.messages = [];
      for (const h of st.history) addMessage(h.role === 'user'
        ? { role: 'user', ...parseUserText(h.content) }
        : { role: 'assistant', text: h.content, shown: h.content.length, trace: [], live: '', done: true, typing: false, open: false, openTools: new Set(), t0: 0, ms: null, error: null, restored: true });
      paintDepth();
      listEl.innerHTML = ''; els.clear();
      renderAll();
      stick = true; toBottom(false);
      if (st.run) {   // приложение закрыли посреди ответа — подхватываем
        S.busy = true;
        const m = addMessage({ role: 'assistant', text: '', shown: 0, trace: [], live: '', done: false, typing: false, open: false, openTools: new Set(), t0: Date.now(), ms: null, error: null });
        const run = { m, runId: st.run.id, stopped: false, finished: false };
        S.run = run;
        renderAll(); applyRun(m, st.run);
        const stopped = () => run.stopped || run.finished;
        const poller = follow(m, st.run.id, stopped);
        if (st.run.pending) drawImage(m, st.run.id, stopped).catch((e) => plainFail(m, e.message || 'Не получилось нарисовать'));
        await poller;
        run.finished = true;
        if (S.run === run) { S.run = null; S.busy = false; }
        renderAll();
      }
    } catch (e) {
      listEl.innerHTML = `<div class="empty"><div class="moon">🌙</div><h1>Откройте в Telegram</h1><p>${esc(e.message || 'Не удалось загрузить')}</p></div>`;
    }
  }
  init();
})();
