'use strict';

// In-memory Cosmos containers (`PARTITION` names them). Of predicates only the seal term runs, dropping a row with
// no `read[]` as Cosmos does; any other parameter throws, so an unknown query shape fails instead of matching all.
// `works` queries run their whole WHERE clause instead (`whereOf`).

const cosmos = require('../../src/db/cosmos-nosql');

const PARTITION = {
  documents: 'projectId', projects: 'id', lists: 'kind', notifications: 'id', updates: 'id', commentPeriods: 'projectId',
  comments: 'periodId', works: 'projectId'
};
const FIELD_OF_PARAM = { '@id': 'id', '@eagleId': 'eagleId', '@projectId': 'projectId', '@kind': 'kind', '@periodId': 'periodId' };

const failure = (code, message) => Object.assign(new Error(message), { code });

/** `set` and `remove` on top-level paths: the mirror and the cascade send `set`, clearing a marker sends `remove`. */
function applyPatch(row, operations) {
  const next = { ...row };
  for (const op of operations) {
    const field = op.path.slice(1);
    if (op.op === 'set') next[field] = op.value;
    else if (op.op === 'remove') {
      // Cosmos rejects a remove of a path the item does not hold.
      if (!(field in next)) throw failure(400, `mirror-store: remove of absent path ${op.path}`);
      delete next[field];
    } else throw new Error(`mirror-store: unknown patch op ${op.op}`);
  }
  return next;
}

/**
 * A `works` WHERE clause as a row predicate: `c.f = @p`, `= true`, IS_DEFINED, IS_BOOL, IS_STRING, STARTSWITH,
 * NOT/AND/OR. Every term works.js writes is guarded, so two-valued logic gives Cosmos' answer.
 */
function whereOf({ query, parameters }) {
  const values = Object.fromEntries(parameters.map(({ name, value }) => [name, value]));
  const named = new Set(query.match(/@\w+/g) || []);
  const unknown = [...named].filter(name => !(name in values)).concat(Object.keys(values).filter(name => !named.has(name)));
  if (unknown.length) throw new Error(`mirror-store: parameter ${unknown.join(', ')} not both named and bound`);
  const expression = query.replace(/^SELECT \* FROM c WHERE /, '')
    .replace(/IS_DEFINED\(c\.(\w+)\)/g, '(row.$1 !== undefined)')
    .replace(/IS_BOOL\(c\.(\w+)\)/g, "(typeof row.$1 === 'boolean')")
    .replace(/IS_STRING\(c\.(\w+)\)/g, "(typeof row.$1 === 'string')")
    .replace(/STARTSWITH\(c\.(\w+), (@\w+)\)/g, "String(row.$1).startsWith(values['$2'])")
    .replace(/c\.(\w+) = (@\w+)/g, "(row.$1 === values['$2'])")
    .replace(/c\.(\w+) = true/g, '(row.$1 === true)')
    .replace(/\bAND\b/g, '&&').replace(/\bOR\b/g, '||').replace(/\bNOT\b/g, '!');
  if (/\bc\.|(?<!')@/.test(expression)) throw new Error(`mirror-store: untranslated works term in ${expression}`);
  const where = new Function('row', 'values', `return ${expression};`);
  return (row) => where(row, values);
}

function matches(row, spec) {
  // `c.<field> IN (@a0, @a1)`, as `inList` writes it.
  const lists = [...spec.query.matchAll(/c\.(\w+) IN \(([^)]*)\)/g)]
    .map(([, field, names]) => ({ field, names: names.split(',').map(name => name.trim()) }));
  const listed = new Set(lists.flatMap(list => list.names));
  const valueOf = name => spec.parameters.find(p => p.name === name).value;
  for (const { field, names } of lists) {
    if (!names.map(valueOf).map(String).includes(String(row[field]))) return false;
  }
  for (const { name, value } of spec.parameters.filter(p => !listed.has(p.name))) {
    if (!(name in FIELD_OF_PARAM)) throw new Error(`mirror-store: unknown parameter ${name}`);
    if (String(row[FIELD_OF_PARAM[name]]) !== String(value)) return false;
  }
  const sealed = /NOT ARRAY_CONTAINS\(c\.read, '([^']+)'\)/.exec(spec.query);
  return !sealed || (Array.isArray(row.read) && !row.read.includes(sealed[1]));
}

/**
 * Mock the Cosmos calls over `rows` (each `{ container, ...row }`). `writes` records every write
 * attempt, landed or not; `rows(container)` is what is stored now.
 */
function mirrorStore(t, rows) {
  let etags = 0;
  const stamp = (item) => ({ ...item, _etag: `"m${++etags}"` });
  const stored = rows.map(({ container, ...row }) => ({ container, row: stamp(row) }));
  const writes = [];
  const key = (container, row) => `${row.id}|${row[PARTITION[container]]}`;
  const find = (container, row) => stored.find(s => s.container === container &&
    key(container, s.row) === key(container, row));
  const inContainer = (container) => stored.filter(s => s.container === container).map(s => s.row);

  t.mock.method(cosmos, 'readItem', async (container, id, pk) => {
    const hit = find(container, { id, [PARTITION[container]]: pk });
    return hit ? { ...hit.row } : null;
  });
  const predicateOf = (container, spec) => (container === 'works' ? whereOf(spec) : row => matches(row, spec));
  t.mock.method(cosmos, 'query', async (container, spec) => {
    cosmos.assertQuerySpec(spec, container);
    return { items: inContainer(container).filter(predicateOf(container, spec)).map(row => ({ ...row })) };
  });
  t.mock.method(cosmos, 'queryFirst', async (container, spec) => {
    cosmos.assertQuerySpec(spec, container);
    const row = inContainer(container).find(predicateOf(container, spec));
    return row ? { ...row } : null;
  });
  t.mock.method(cosmos, 'create', async (container, item) => {
    writes.push({ op: 'create', container, item });
    if (find(container, item)) throw failure(409, 'conflict');
    const row = stamp(item);
    stored.push({ container, row });
    return { ...row };
  });
  // The etag is tested against a row at the item's own key only: a partition move upserts into a
  // key that holds nothing yet, carrying the old row's etag, and the move path relies on it landing.
  t.mock.method(cosmos, 'upsert', async (container, item, { etag } = {}) => {
    writes.push({ op: 'upsert', container, item, etag });
    const hit = find(container, item);
    if (etag && hit && hit.row._etag !== etag) throw failure(412, 'precondition failed');
    const row = stamp(item);
    if (hit) hit.row = row;
    else stored.push({ container, row });
    return { ...row };
  });

  t.mock.method(cosmos, 'replace', async (container, id, pk, item, etag) => {
    writes.push({ op: 'replace', container, item, etag });
    const hit = find(container, { id, [PARTITION[container]]: pk });
    if (!hit) throw failure(404, 'not found');
    if (etag && hit.row._etag !== etag) throw failure(412, 'precondition failed');
    hit.row = stamp(item);
    return { ...hit.row };
  });

  t.mock.method(cosmos, 'remove', async (container, id, pk, { etag } = {}) => {
    writes.push({ op: 'remove', container, id, pk, etag });
    const hit = find(container, { id, [PARTITION[container]]: pk });
    if (!hit) return false;
    if (etag && hit.row._etag !== etag) throw failure(412, 'precondition failed');
    stored.splice(stored.indexOf(hit), 1);
    return true;
  });
  const patchOne = (container, id, pk, operations, etag) => {
    const hit = find(container, { id, [PARTITION[container]]: pk });
    if (!hit) throw failure(404, 'not found');
    if (etag && hit.row._etag !== etag) throw failure(412, 'precondition failed');
    hit.row = stamp(applyPatch(hit.row, operations));
    return { ...hit.row };
  };
  t.mock.method(cosmos, 'patch', async (container, id, pk, operations, condition, etag) => {
    writes.push({ op: 'patch', container, id, pk, operations });
    if (condition) throw new Error('mirror-store: patch conditions are not evaluated');
    return patchOne(container, id, pk, operations, etag);
  });
  t.mock.method(cosmos, 'bulkVerified', async (container, operations) => {
    for (const op of operations) {
      if (op.operationType !== 'Patch') throw new Error(`mirror-store: unknown bulk op ${op.operationType}`);
      writes.push({ op: 'patch', container, id: op.id, pk: op.partitionKey, operations: op.resourceBody.operations });
      patchOne(container, op.id, op.partitionKey, op.resourceBody.operations);
    }
    return { succeeded: operations.length, failed: 0, statusCounts: {}, requestCharge: 0 };
  });

  return { writes, rows: inContainer };
}

module.exports = { mirrorStore };
