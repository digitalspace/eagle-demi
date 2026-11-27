'use strict';

// documents.listExtractionBacklog: the rows src/scripts/extraction-backlog.js sends to the extraction queue.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const documents = require('../../src/repositories/documents-extraction');
const { evaluate } = require('../helpers/updates-store');

const QUEUED_BEFORE = '2026-11-20T12:00:00.000Z';

const row = (id, ts, overrides = {}) => ({
  id, projectId: '207', _ts: ts, documentSource: 'PROJECT', scanStatus: 'clean', isDeleted: false,
  s3Key: `207/${id}.pdf`, contentExtracted: false, read: ['staff'], ...overrides
});

const ROWS = [
  row('never-queued', 30),
  row('queued-long-ago', 20, { extractionQueuedAt: '2026-11-01T00:00:00.000Z' }),
  row('queued-yesterday', 10, { extractionQueuedAt: '2026-11-26T00:00:00.000Z' }),
  row('queued-just-inside', 11, { extractionQueuedAt: '2026-11-20T12:00:00.001Z' }),
  row('legacy-no-scan-status', 40, { scanStatus: undefined }),
  row('extracted', 1, { contentExtracted: true }),
  row('update-image', 2, { documentSource: 'UPDATE' }),
  row('pending', 3, { scanStatus: 'pending' }),
  row('deleted', 4, { isDeleted: true }),
  row('no-key', 5, { s3Key: '' }),
  row('null-key', 6, { s3Key: null }),
  row('no-project', 7, { projectId: undefined }),
  row('sealed', 8, { read: ['compliance'] })
];

/** Answer the query from ROWS: its WHERE evaluated, then ORDER BY `_ts`, TOP and the projection applied. */
function store(t) {
  const specs = [];
  t.mock.method(cosmos, 'query', async (container, spec) => {
    cosmos.assertQuerySpec(spec, container);
    specs.push(spec);
    const [, top, select, where] =
      /^SELECT TOP (@\w+) (.+?) FROM c WHERE (.+) ORDER BY c\._ts ASC$/s.exec(spec.query);
    const params = Object.fromEntries(spec.parameters.map(p => [p.name, p.value]));
    const fields = select.split(', ').map(field => field.replace(/^c\./, ''));
    const items = ROWS.filter(r => evaluate(where, r, params))
      .sort((a, b) => a._ts - b._ts)
      .slice(0, params[top])
      .map(r => Object.fromEntries(fields.filter(f => r[f] !== undefined).map(f => [f, r[f]])));
    return { items };
  });
  return specs;
}

test('documents.listExtractionBacklog', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('returns only unextracted, released, stored rows, never one queued under 7 days ago, oldest write first', async (t) => {
    store(t);
    const rows = await documents.listExtractionBacklog({ queuedBefore: QUEUED_BEFORE, max: 100 });
    assert.deepStrictEqual(rows.map(r => r.id), ['queued-long-ago', 'never-queued', 'legacy-no-scan-status']);
  });

  await t.test('returns at most max rows', async (t) => {
    store(t);
    const rows = await documents.listExtractionBacklog({ queuedBefore: QUEUED_BEFORE, max: 2 });
    assert.deepStrictEqual(rows.map(r => r.id), ['queued-long-ago', 'never-queued']);
  });

  await t.test('projects the fields the enqueue skip rules read', async (t) => {
    store(t);
    const [first] = await documents.listExtractionBacklog({ queuedBefore: QUEUED_BEFORE, max: 1 });
    assert.deepStrictEqual(Object.keys(first).sort(),
      ['contentExtracted', 'documentSource', 'id', 'isDeleted', 'projectId', 's3Key', 'scanStatus']);
  });
});
