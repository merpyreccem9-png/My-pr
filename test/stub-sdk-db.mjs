// Тестовая заглушка `sdk/db`: описание схемы + операторы. Хранилище — в stub-sdk.mjs.

export const tables = new Map();

function col() {
  const meta = { dflt: undefined, pk: false, auto: false };
  const p = new Proxy({}, {
    get(_, k) {
      if (k === '__meta') return meta;
      if (k === 'then') return undefined;
      if (k === 'default') return (v) => { meta.dflt = v; return p; };
      if (k === 'primaryKey') return (o) => { meta.pk = true; meta.auto = !!o?.autoIncrement; return p; };
      return () => p;
    },
  });
  return p;
}

export const integer = col;
export const text = col;
export const boolean = col;
export const json = col;
export const real = col;

const noop = () => new Proxy(() => {}, { get: (_, k) => (k === 'then' ? undefined : noop()), apply: () => noop() });
export const index = noop;
export const uniqueIndex = noop;
export const unique = noop;
export const check = noop;
export const primaryKey = noop;

export function table(name, cols) {
  const t = { __name: name };
  const meta = {};
  for (const [k, c] of Object.entries(cols)) {
    t[k] = { __col: k, __table: name };
    meta[k] = c.__meta;
  }
  tables.set(name, { meta, rows: [], seq: 0 });
  return t;
}

export const sql = Object.assign((strings, ...vals) => ({ __sql: strings.join('?'), vals }), {
  raw: (s) => ({ __sql: s, vals: [] }),
});

export const eq = (a, b) => ({ op: 'eq', a, b });
export const lt = (a, b) => ({ op: 'lt', a, b });
export const and = (...c) => ({ op: 'and', c });
export const inArray = (a, list) => ({ op: 'in', a, list });
export const desc = (c) => ({ dir: 'desc', c });
export const asc = (c) => ({ dir: 'asc', c });

export default { table, eq, and, lt, inArray, desc, asc, sql };
