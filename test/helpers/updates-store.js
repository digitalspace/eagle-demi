'use strict';

/**
 * An in-memory `updates` container that evaluates the SQL the repository sends.
 *
 * A patch condition and a query filter are SQL only Cosmos evaluates, so a stub that always
 * succeeds, or answers every row, passes whatever the SQL says. This one evaluates the predicate
 * text itself, and throws on any term it does not know: drop a clause from the repository and the
 * store stops enforcing it, so the test that relies on it goes red.
 *
 * Supported: AND, OR, parentheses, `c.f <op> value` (=, !=, <, <=, >, >=; value a @param, a
 * "string", a number, true or false), IS_STRING, IS_DEFINED, IS_NULL, NOT, ARRAY_CONTAINS, and on
 * queries ORDER BY one field, maxItemCount and a continuation.
 */

const cosmos = require('../../src/db/cosmos-nosql');

const precondition = () => Object.assign(new Error('precondition failed'), { code: 412 });

/** Split `text` on `separator` where no parenthesis or string is open. */
function splitTop(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && text.startsWith(separator, i)) {
      parts.push(text.slice(start, i));
      start = i + separator.length;
      i += separator.length - 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map(part => part.trim());
}

/** `(x)` whose outer parentheses enclose the whole of it. */
function wrapped(text) {
  if (!text.startsWith('(') || !text.endsWith(')')) return false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    if (depth === 0 && i < text.length - 1) return false;
  }
  return true;
}

function valueOf(token, params) {
  if (token.startsWith('@')) {
    if (!(token in params)) throw new Error(`updates-store: unbound parameter ${token}`);
    return params[token];
  }
  if (/^"[^"]*"$/.test(token) || /^'[^']*'$/.test(token)) return token.slice(1, -1);
  if (token === 'true' || token === 'false') return token === 'true';
  if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
  throw new Error(`updates-store: unknown value ${token}`);
}

const COMPARE = {
  '=': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b
};

const isNull = (value) => value === undefined || value === null;

function evaluate(text, row, params) {
  const expr = text.trim();
  if (wrapped(expr)) return evaluate(expr.slice(1, -1), row, params);
  const ors = splitTop(expr, ' OR ');
  if (ors.length > 1) return ors.some(part => evaluate(part, row, params));
  const ands = splitTop(expr, ' AND ');
  if (ands.length > 1) return ands.every(part => evaluate(part, row, params));
  if (expr.startsWith('NOT ')) return !evaluate(expr.slice(4), row, params);

  let m = /^IS_(STRING|DEFINED|NULL)\(c\.(\w+)\)$/.exec(expr);
  if (m) {
    const value = row[m[2]];
    if (m[1] === 'STRING') return typeof value === 'string';
    if (m[1] === 'DEFINED') return value !== undefined;
    return value === null;
  }
  m = /^ARRAY_CONTAINS\(c\.(\w+), '([^']*)'\)$/.exec(expr);
  if (m) return Array.isArray(row[m[1]]) && row[m[1]].includes(m[2]);
  m = /^c\.(\w+) (=|!=|<=|>=|<|>) (\S+)$/.exec(expr);
  if (m) {
    const left = row[m[1]];
    const right = valueOf(m[3], params);
    // Cosmos: a comparison across types, or with an undefined side, is undefined, so not true.
    if (isNull(left) || typeof left !== typeof right) return false;
    return COMPARE[m[2]](left, right);
  }
  throw new Error(`updates-store: cannot evaluate "${expr}"`);
}

/** Evaluate a patch condition, `FROM c WHERE <predicate>`. */
function conditionHolds(row, condition) {
  const m = /^FROM c WHERE (.+)$/s.exec(condition);
  if (!m) throw new Error(`updates-store: unknown condition ${condition}`);
  return evaluate(m[1], row, {});
}

/** Rows a query answers, in its ORDER BY. A row without the ORDER BY field drops out, as in Cosmos. */
function answer(rows, spec) {
  const m = /^SELECT .+? FROM c WHERE (.+?)(?: ORDER BY c\.(\w+) (ASC|DESC))?$/s.exec(spec.query);
  if (!m) throw new Error(`updates-store: unknown query ${spec.query}`);
  const params = Object.fromEntries((spec.parameters || []).map(p => [p.name, p.value]));
  let matched = rows.filter(row => evaluate(m[1], row, params));
  if (m[2]) {
    const field = m[2];
    const sign = m[3] === 'DESC' ? -1 : 1;
    matched = matched.filter(row => !isNull(row[field]))
      .sort((a, b) => (a[field] < b[field] ? -sign : a[field] > b[field] ? sign : 0));
  }
  return matched;
}

function apply(row, operations) {
  const next = { ...row };
  for (const op of operations) {
    const field = op.path.slice(1);
    if (op.op === 'incr') next[field] = (next[field] || 0) + op.value;
    else next[field] = op.value;
  }
  return next;
}

/**
 * Mock the Cosmos calls the updates repository makes, over `rows`.
 *
 * `onQuery(store, items)` runs after a query has matched its rows and before it answers — the window
 * a row can change in between the timer listing it and claiming it. `pageSize` caps a page below
 * what was asked, as Cosmos may. `queries` records each query's spec and options.
 */
function updatesStore(t, rows, { onQuery = null, pageSize = Infinity } = {}) {
  const store = new Map(rows.map(row => [String(row.id), { ...row }]));
  const patches = [];
  const queries = [];

  t.mock.method(cosmos, 'patch', async (container, id, pk, operations, condition) => {
    patches.push({ container, id: String(id), operations, condition });
    const row = store.get(String(id));
    if (!row) throw Object.assign(new Error('not found'), { code: 404 });
    if (condition && !conditionHolds(row, condition)) throw precondition();
    const next = apply(row, operations);
    store.set(String(id), next);
    return { ...next };
  });
  t.mock.method(cosmos, 'query', async (container, spec, options = {}) => {
    queries.push({ spec, options });
    const matched = answer([...store.values()].map(row => ({ ...row })), spec);
    const offset = Number(options.continuationToken || 0);
    const size = Math.min(options.maxItemCount || matched.length, pageSize);
    const end = offset + size;
    const items = matched.slice(offset, end);
    if (onQuery) onQuery(store, items);
    return {
      items,
      continuationToken: end < matched.length ? String(end) : undefined,
      requestCharge: 0
    };
  });
  t.mock.method(cosmos, 'readItem', async (container, id) => {
    const row = store.get(String(id));
    return row ? { ...row } : null;
  });

  return { store, patches, queries, row: (id) => store.get(String(id)) };
}

module.exports = { updatesStore, evaluate };
