// Luna — Mini App: чат в стиле ChatGPT. Без зависимостей и сборки.
// Сервер (endpoints/send) пишет ход работы в kv, а мы читаем его через poll: плавный текст, «мысли» и команды вживую.
(() => {
  'use strict';

  const tg = window.Telegram && window.Telegram.WebApp;
  const $ = (s) => document.querySelector(s);
  const listEl = $('#list'), chatEl = $('#chat'), inputEl = $('#input'), sendEl = $('#send');
  const effortEl = $('#effort'), statusEl = $('#status'), menuBtn = $('#menuBtn');
  const sheetEl = $('#sheet'), overlayEl = $('#overlay'), toastEl = $('#toast');

  const S = {
    name: '', owner: false, configured: true, model: '', depth: 'auto',
    github: { connected: false, login: null }, facts: [],
    messages: [], busy: false, hasLast: false,
  };
  let seq = 0;
  const nid = () => `m${++seq}`;
  const els = new Map();   // id → { root, body, think, actions, cache }

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
      return `<div class="code"><div class="code-h"><span>${esc(f.lang || 'код')}</span><button class="copy" data-act="copycode">Копировать</button></div><pre><code>${esc(f.code)}</code></pre></div>`;
    });
    if (caret) html = /<\/(p|li|h\d|blockquote)>$/.test(html) ? html.replace(/(<\/(p|li|h\d|blockquote)>)$/, '<span class="caret"></span>$1') : `${html}<span class="caret"></span>`;
    return html;
  }

  // ── Сообщения ────────────────────────────────────────────────────────────
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
      label = cur ? `🐙 ${cur.label}…` : m.text ? 'Пишет…' : 'Думает…';
    } else if (tools.length || thoughts.length) {
      label = `Думал ${sec} с${tools.length ? ` · ${tools.length} ${plural(tools.length, 'команда', 'команды', 'команд')}` : ''}`;
    } else {
      label = `Ответил за ${sec} с`;
    }
    const expandable = running || tools.length || thoughts.length;
    const chip = `<button class="chip ${running ? 'run' : ''}" ${expandable ? 'data-act="think"' : 'disabled'}><span class="dot"></span><span class="lbl">${esc(label)}</span>${expandable ? `<span class="chev">${m.open ? '▾' : '▸'}</span>` : ''}</button>`;
    if (!m.open || !expandable) return chip;

    const items = m.trace.map((x) => {
      if (x.k === 'think') return `<div class="t-think">${md(x.t)}</div>`;
      const open = m.openTools.has(x.id);
      const icon = x.state === 'run' ? '<span class="spin"></span>' : x.state === 'err' ? '✕' : '✓';
      const detail = open ? `<pre class="t-out">${esc(`${x.name}(${JSON.stringify(x.args || {})})\n\n${x.out || '…'}`)}</pre>` : '';
      return `<div class="t-tool ${x.state}"><button class="t-row" data-act="tool" data-id="${esc(x.id)}"><span class="ic">${icon}</span><span class="lbl">${esc(x.label || x.name)}</span><span class="ms">${x.ms != null ? `${(x.ms / 1000).toFixed(1)} с` : ''}</span></button>${detail}</div>`;
    });
    if (running && m.live) items.push(`<div class="t-think live">${md(m.live)}</div>`);
    if (!items.length) items.push('<div class="t-think live">Размышляет…</div>');
    return `${chip}<div class="think-body">${items.join('')}</div>`;
  }

  // Кнопки под сообщением бота — как inline-клавиатура в Telegram.
  function actionsHtml(m) {
    if (!m.done || m.typing || m.error || !m.text) return '';
    const last = m === lastAssistant();
    const rows = [];
    if (last && S.hasLast && !S.busy) rows.push('<div class="kbrow"><button class="kbtn" data-act="again">🔄 Заново</button><button class="kbtn" data-act="short">✂️ Короче</button><button class="kbtn" data-act="long">➕ Подробнее</button></div>');
    rows.push('<div class="kbrow"><button class="kbtn" data-act="copy">📋 Копировать</button></div>');
    return `<div class="kb">${rows.join('')}</div>`;
  }

  function msgEl(m) {
    let e = els.get(m.id);
    if (e) return e;
    const root = document.createElement('div');
    root.className = `msg ${m.role}`;
    root.dataset.id = m.id;
    if (m.role === 'user') {
      root.innerHTML = `<div class="bubble me">${esc(m.text)}${m.at ? `<span class="stamp">${hhmm(m.at)}</span>` : ''}</div>`;
      e = { root };
    } else {
      root.innerHTML = '<div class="bubble bot"><div class="a-body"></div><div class="think"></div><div class="stamp"></div></div><div class="kb-w"></div>';
      e = { root, bubble: root.querySelector('.bubble'), body: root.querySelector('.a-body'), think: root.querySelector('.think'), stamp: root.querySelector('.stamp'), actions: root.querySelector('.kb-w'), cache: {} };
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
    e.bubble.classList.toggle('hidden', !body && !m.error);
    setHtml(e, 'body', e.body, body);
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
    const ideas = ['Объясни простыми словами, как работает ИИ', 'Помоги составить план на неделю', 'Придумай идею для проекта', 'Что нового в моих репозиториях?'];
    div.innerHTML = `<div class="moon">🌙</div><h1>${S.name ? `Привет, ${esc(S.name.split(' ')[0])}` : 'Привет'}</h1><p>Я Луна. Спросите что угодно — я покажу, как думаю.</p>
      ${S.configured ? '' : '<div class="notice">ИИ ещё не настроен владельцем бота.</div>'}
      <div class="chips">${ideas.map((t) => `<button data-idea="${esc(t)}">${esc(t)}</button>`).join('')}</div>`;
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
    if (r.done) { m.done = true; m.ms = r.ms; m.error = r.error || null; if (m.error) m.typing = false; }
    if (m.text && !m.error) m.typing = true;
    renderMsg(m);
    kick();
  }

  // Читаем прогресс, пока запрос не завершится (в том числе если ответ на send потерялся).
  async function follow(m, runId, shouldStop) {
    let misses = 0;
    const t0 = Date.now();
    while (!m.done && !shouldStop() && Date.now() - t0 < 12 * 60 * 1000) {
      await sleep(m.text || m.trace.length ? 650 : 900);
      if (m.done || shouldStop()) break;
      try {
        const res = await rpc('poll', { runId });
        if (res && res.run) { misses = 0; applyRun(m, res.run); }
        else if (++misses > 25) break;
      } catch (e) { if (++misses > 12) break; }
    }
  }

  async function ask({ text, mode = null, regen = false, again = false }) {
    if (S.busy) return;
    if (!regen && !mode && !again && !text.trim()) return;
    S.busy = true;
    stick = true;
    haptic('light');

    if (regen || mode) {
      const prev = lastAssistant();
      if (prev) S.messages.splice(S.messages.indexOf(prev), 1);
    }
    if (!regen && !mode && !again) addMessage({ role: 'user', text: text.trim(), at: Date.now() });
    const m = addMessage({ role: 'assistant', text: '', shown: 0, trace: [], live: '', done: false, typing: false, open: false, openTools: new Set(), t0: Date.now(), at: Date.now(), ms: null, error: null });
    renderAll();
    toBottom(true);
    const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    let finished = false;

    const poller = follow(m, runId, () => finished);
    try {
      const res = await rpc('send', { text, mode, regen: regen || undefined, runId });
      finished = true;
      applyRun(m, res);
      S.hasLast = true;
    } catch (e) {
      if (isEndpointErr(e)) {
        finished = true;
        if (e.parameters && e.parameters.code === 'BUSY') { S.messages.splice(S.messages.indexOf(m), 1); toast('Предыдущий ответ ещё готовится'); }
        else { m.done = true; m.error = e.message; m.ms = Date.now() - m.t0; }
      } else {
        // Соединение оборвалось, а сервер, возможно, ещё работает — продолжаем читать прогресс.
        await poller;
        finished = true;
        if (!m.done) { m.done = true; m.error = 'Связь прервалась. Нажмите «Повторить».'; }
      }
    } finally {
      finished = true;
      S.busy = false;
      renderAll();
      kick();
    }
  }

  async function sendFromInput() {
    const text = inputEl.value.trim();
    if (!text || S.busy) return;
    inputEl.value = '';
    autosize();
    updateComposer();
    await ask({ text });
  }

  // ── Ввод ─────────────────────────────────────────────────────────────────
  function autosize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 156)}px`;
  }
  function updateComposer() {
    sendEl.disabled = S.busy || !inputEl.value.trim();
    sendEl.classList.toggle('busy', S.busy);
    statusEl.textContent = S.busy ? 'печатает…' : 'в сети';
    statusEl.classList.toggle('typing-now', S.busy);
  }
  inputEl.addEventListener('input', () => { autosize(); updateComposer(); });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(pointer:fine)').matches) { e.preventDefault(); sendFromInput(); }
  });
  sendEl.addEventListener('click', sendFromInput);

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
    auto: ['🤖', 'Авто', 'Как настроил владелец бота'],
    fast: ['⚡', 'Быстро', 'Отвечаю сразу — для простых вопросов'],
    normal: ['⚖️', 'Обычно', 'Баланс скорости и качества'],
    deep: ['🧠', 'Глубоко', 'Долго думаю: сложные задачи, математика, код'],
  };
  const depthLabel = () => { const d = DEPTH_INFO[S.depth] || DEPTH_INFO.auto; return `${d[0]} ${d[1]}`; };
  const paintDepth = () => effortEl.querySelectorAll('[data-depth]').forEach((b) => b.classList.toggle('on', b.dataset.depth === S.depth));

  function openSheet(html) {
    sheetEl.innerHTML = `<div class="grab"></div>${html}`;
    sheetEl.classList.remove('hidden');
    overlayEl.classList.remove('hidden');
    sheetEl.scrollTop = 0;
  }
  function closeSheet() { sheetEl.classList.add('hidden'); overlayEl.classList.add('hidden'); }
  overlayEl.addEventListener('click', closeSheet);

  effortEl.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-depth]');
    if (!btn) return;
    S.depth = btn.dataset.depth; paintDepth(); haptic('light');
    try { await rpc('setDepth', { depth: S.depth }); toast(`${depthLabel()} — выбрано`); } catch (e) { toast('Не удалось сохранить'); }
  });

  function menuHtml() {
    const gh = S.github;
    return `<h3>Меню</h3>
      <button class="opt" data-menu="new"><span class="em">✨</span><span class="tx"><b>Новый чат</b><span>Сбросить диалог, память о вас останется</span></span></button>
      <h4>GitHub · только чтение</h4>
      ${gh.connected
        ? `<p class="muted">Подключён: <b>@${esc(gh.login)}</b>. Просите: «что в README моего репозитория…», «найди в коде…», «какие открытые issues».</p>
           <div class="row"><button class="btn danger" data-menu="ghoff">Отключить</button></div>`
        : `<p class="muted">Токен fine-grained с правами Read-only: Contents, Issues, Pull requests, Metadata (github.com/settings/personal-access-tokens/new).</p>
           <input id="ghToken" class="field" type="password" placeholder="github_pat_…" autocomplete="off" autocapitalize="off" spellcheck="false">
           <div class="row"><button class="btn" data-menu="ghon">Подключить</button></div>`}
      <h4>Что я помню о вас</h4>
      ${S.facts.length ? `<ul class="facts">${S.facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '<p class="muted">Пока ничего — расскажите о себе в чате.</p>'}
      ${S.owner && S.model ? `<h4>Модель</h4><p class="muted">${esc(S.model)}</p>` : ''}`;
  }
  menuBtn.addEventListener('click', () => { haptic('light'); openSheet(menuHtml()); });

  sheetEl.addEventListener('click', async (ev) => {
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
      case 'ghoff':
        try { await rpc('github', { action: 'disconnect' }); S.github = { connected: false, login: null }; openSheet(menuHtml()); toast('GitHub отключён'); } catch (e) { toast('Не получилось'); }
        break;
      default:
    }
  });

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
      Object.assign(S, { name: st.name, owner: st.owner, configured: st.configured, model: st.model, depth: st.depth, github: st.github, facts: st.facts, hasLast: st.hasLast });
      S.messages = [];
      for (const h of st.history) addMessage(h.role === 'user'
        ? { role: 'user', text: h.content }
        : { role: 'assistant', text: h.content, shown: h.content.length, trace: [], live: '', done: true, typing: false, open: false, openTools: new Set(), t0: 0, ms: null, error: null, restored: true });
      paintDepth();
      listEl.innerHTML = ''; els.clear();
      renderAll();
      stick = true; toBottom(false);
      if (st.run) {   // приложение закрыли посреди ответа — подхватываем
        S.busy = true;
        const m = addMessage({ role: 'assistant', text: '', shown: 0, trace: [], live: '', done: false, typing: false, open: false, openTools: new Set(), t0: Date.now(), ms: null, error: null });
        renderAll(); applyRun(m, st.run);
        await follow(m, st.run.id, () => false);
        S.busy = false; renderAll();
      }
    } catch (e) {
      listEl.innerHTML = `<div class="empty"><div class="moon">🌙</div><h1>Откройте в Telegram</h1><p>${esc(e.message || 'Не удалось загрузить')}</p></div>`;
    }
  }
  init();
})();
