// Тестовая заглушка `sdk`: мини-СУБД в памяти, запись вызовов Bot API, управляемый fetch.

import { tables } from './stub-sdk-db.mjs';

// ── мини-СУБД ────────────────────────────────────────────────────────────

const matches = (e, row) => {
  if (!e) return true;
  switch (e.op) {
    case 'eq': return row[e.a.__col] === e.b;
    case 'lt': return row[e.a.__col] < e.b;
    case 'in': return e.list.includes(row[e.a.__col]);
    case 'and': return e.c.every((x) => matches(x, row));
  }
  throw new Error(`unsupported where: ${JSON.stringify(e)}`);
};

function evalSet(val, snap) {
  if (val && val.__sql) {
    if (val.__sql.includes('CASE WHEN')) {
      const [dayCol, dayParam, nCol] = val.vals;
      return snap[dayCol.__col] === dayParam ? snap[nCol.__col] + 1 : 1;
    }
    throw new Error(`unsupported sql in set: ${val.__sql}`);
  }
  return val;
}

const rowsOf = (t) => tables.get(t.__name).rows;

class Select {
  constructor() { this.w = []; this.ord = []; this.lim = null; }
  from(t) { this.t = t; return this; }
  where(...e) { this.w.push(...e); return this; }
  orderBy(...o) { this.ord = o; return this; }
  limit(n) { this.lim = n; return this; }
  offset() { return this; }
  async all() {
    let rows = rowsOf(this.t).filter((r) => this.w.every((e) => matches(e, r)));
    for (const o of [...this.ord].reverse()) {
      const k = o.c.__col;
      const sign = o.dir === 'desc' ? -1 : 1;
      rows = rows.slice().sort((a, b) => (a[k] > b[k] ? sign : a[k] < b[k] ? -sign : 0));
    }
    if (this.lim !== null) rows = rows.slice(0, this.lim);
    return rows.map((r) => ({ ...r }));
  }
  async get() { return (await this.limit(1).all())[0] ?? null; }
  then(res, rej) { return this.all().then(res, rej); }
}

class Insert {
  constructor(t) { this.t = t; this.vals = []; this.conflict = null; this.ret = false; this.nothing = false; }
  values(v) { this.vals = Array.isArray(v) ? v : [v]; return this; }
  onConflictDoUpdate(c) { this.conflict = c; return this; }
  onConflictDoNothing() { this.nothing = true; return this; }
  returning() { this.ret = true; return this; }
  async run() {
    const tb = tables.get(this.t.__name);
    const pkKey = Object.keys(tb.meta).find((k) => tb.meta[k].pk);
    const out = [];
    for (const v of this.vals) {
      const existing = pkKey && !tb.meta[pkKey].auto ? tb.rows.find((r) => r[pkKey] === v[pkKey]) : null;
      if (existing) {
        if (this.nothing) continue;
        if (!this.conflict) throw new Error('UNIQUE constraint failed');
        const snap = { ...existing };
        const upd = {};
        for (const [k, val] of Object.entries(this.conflict.set)) upd[k] = evalSet(val, snap);
        Object.assign(existing, upd);
        out.push({ ...existing });
        continue;
      }
      const row = {};
      for (const [k, m] of Object.entries(tb.meta)) {
        row[k] = m.dflt !== undefined && !(m.dflt && m.dflt.__sql) ? m.dflt : null;
      }
      Object.assign(row, v);
      if (pkKey && tb.meta[pkKey].auto) row[pkKey] = ++tb.seq;
      tb.rows.push(row);
      out.push({ ...row });
    }
    return this.ret ? out : { rowsAffected: out.length, lastInsertRowid: tb.seq, rows: [] };
  }
  then(res, rej) { return this.run().then(res, rej); }
}

class Update {
  constructor(t) { this.t = t; this.w = []; }
  set(p) { this.p = p; return this; }
  where(...e) { this.w.push(...e); return this; }
  async run() {
    let n = 0;
    for (const r of rowsOf(this.t)) if (this.w.every((e) => matches(e, r))) { Object.assign(r, this.p); n++; }
    return { rowsAffected: n, lastInsertRowid: 0, rows: [] };
  }
  then(res, rej) { return this.run().then(res, rej); }
}

class Delete {
  constructor(t) { this.t = t; this.w = []; }
  where(...e) { this.w.push(...e); return this; }
  async run() {
    const tb = tables.get(this.t.__name);
    const before = tb.rows.length;
    tb.rows = tb.rows.filter((r) => !this.w.every((e) => matches(e, r)));
    return { rowsAffected: before - tb.rows.length, lastInsertRowid: 0, rows: [] };
  }
  then(res, rej) { return this.run().then(res, rej); }
}

export const db = {
  select: () => new Select(),
  insert: (t) => new Insert(t),
  update: (t) => new Update(t),
  delete: (t) => new Delete(t),
  $count: async (t, w) => rowsOf(t).filter((r) => matches(w, r)).length,
};

export const dump = (name) => tables.get(name).rows.map((r) => ({ ...r }));

export function resetDb() {
  for (const tb of tables.values()) { tb.rows = []; tb.seq = 0; }
}

// ── Bot API ──────────────────────────────────────────────────────────────

export class BotApiError extends Error {
  constructor(method, code, description, parameters = {}) {
    super(description);
    this.method = method;
    this.code = code;
    this.description = description;
    this.parameters = parameters;
  }
}

export const apiCalls = [];
export const members = new Map();      // `${chat}:${user}` → ChatMember
export const apiFail = new Map();      // method → { code, description }

export const calls = (method) => apiCalls.filter((c) => c.method === method).map((c) => c.params);
export const lastText = () => calls('sendMessage').at(-1)?.text;

export function resetApi() {
  apiCalls.length = 0;
  members.clear();
  apiFail.clear();
}

export const api = new Proxy({}, {
  get(_, method) {
    if (method === 'then') return undefined;
    return async (params = {}) => {
      apiCalls.push({ method, params });
      const f = apiFail.get(method);
      if (f) {
        if (f.times !== undefined && --f.times <= 0) apiFail.delete(method);
        throw new BotApiError(method, f.code, f.description);
      }
      if (method === 'getMe') return { id: 99, is_bot: true, username: 'YoruxiiBot' };
      if (method === 'getChatMember') {
        return members.get(`${params.chat_id}:${params.user_id}`)
          ?? { status: 'member', user: { id: params.user_id, first_name: `U${params.user_id}` } };
      }
      if (method === 'sendMessage') return { message_id: 5000 + apiCalls.length };
      return true;
    };
  },
});

// ── fetch ────────────────────────────────────────────────────────────────

export const fetchCalls = [];
let fetchImpl = async () => { throw new Error('fetch not mocked'); };
export const mockFetch = (fn) => { fetchImpl = fn; };
export const resetFetch = () => { fetchCalls.length = 0; fetchImpl = async () => { throw new Error('fetch not mocked'); }; };

export const jsonResponse = (obj, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(obj),
});

export async function fetch(url, init) {
  fetchCalls.push({ url, init });
  return fetchImpl(url, init);
}

fetch.body = { json: (o) => JSON.stringify(o) };

export class InputFile {}
export class EndpointError extends Error {}
