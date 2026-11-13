'use strict';

const cosmos = require('../../src/db/cosmos-nosql');
const MAP = require('../../src/data/works-catalog-map.json');
const PHASE_MAP = require('../../src/data/phase-catalog-map.json');

const PROJECT = '7001';
const NUMBER = 101;

// Catalogs as build-works-catalog.js resolves them, with made-up phase ids, as in the W7 tests.
const phaseId = (year, name) => `${year}:${name}`;
const CATALOG = { ...MAP, appliedTo: MAP.appliedTo.map(entry => ({ ...entry, catalogIds: { 1996: phaseId(1996, entry.phase), 2002: phaseId(2002, entry.phase) } })) };
const PHASES = Object.fromEntries([1996, 2002].map(year => [year, PHASE_MAP.acts[year].map(entry => ({ ...entry, catalogId: phaseId(year, entry.name) }))]));

const ref = (sheet, slot) => ({ file: 'made-up.xlsx', sheet, row: 5, ...(slot && { slot }) });
const register = { ref: ref('Projects'), id: NUMBER, name: 'Sample Mine', intakeType: 's.6', intakeDate: '2005-01-01',
  determinationType: 's.10(1)(c)', determinationDate: '2005-03-01', decision: 'EA Certificate Granted', decisionDate: '2008-05-01' };
const amendment = (slot, startDate, endDate) => ({ ref: ref('Amendments', slot), id: NUMBER, name: 'Sample Mine', startDate, endDate });
const trackWork = (n, fields) => ({ id: `track-${n}`, projectId: PROJECT, source: 'track', owner: 'track', workTypeId: 7, workState: 'COMPLETED', ...fields });

const coded = (code, message) => Object.assign(new Error(message), { code });

/** An in-memory `lists` container: etags change on every write, and create, replace and remove honour them as Cosmos does. */
function fakeLists(t) {
  const items = new Map();
  let n = 0;
  const keyOf = (id, kind) => `${kind}|${id}`;
  const put = (item) => {
    const stored = { ...item, _etag: `"e${n += 1}"` };
    items.set(keyOf(item.id, item.kind), stored);
    return stored;
  };
  t.mock.method(cosmos, 'readItem', async (_c, id, kind) => items.get(keyOf(id, kind)) || null);
  t.mock.method(cosmos, 'create', async (_c, item) => {
    if (items.has(keyOf(item.id, item.kind))) throw coded(409, 'conflict');
    return put(item);
  });
  t.mock.method(cosmos, 'replace', async (_c, id, kind, item, etag) => {
    const current = items.get(keyOf(id, kind));
    if (!current) throw coded(404, 'missing');
    if (current._etag !== etag) throw coded(412, 'precondition');
    return put(item);
  });
  t.mock.method(cosmos, 'remove', async (_c, id, kind, { etag }) => {
    const current = items.get(keyOf(id, kind));
    if (current && current._etag !== etag) throw coded(412, 'precondition');
    return items.delete(keyOf(id, kind));
  });
  t.mock.method(cosmos, 'query', async (_c, spec, { partitionKey }) => {
    const [{ value }] = spec.parameters;
    const kept = [...items.values()].filter(item => item.kind === partitionKey);
    if (spec.query.includes('MAX(c.seq)')) {
      const seqs = kept.filter(item => item.batchId === value).map(item => item.seq);
      return { items: seqs.length ? [Math.max(...seqs)] : [] };
    }
    return { items: kept.filter(item => item.status === value).map(item => item.id) };
  });
  return { get: (id, kind) => items.get(keyOf(id, kind)), all: () => [...items.values()], set: put };
}

module.exports = { CATALOG, PHASES, PROJECT, NUMBER, fakeLists, ref, register, amendment, trackWork };
