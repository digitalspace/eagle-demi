'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { purge, exitCodeFor } = require('../../src/scripts/purge-index-only-chunks');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'demi-purge-index-only-'));
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

let seq = 0;
const tmpFile = (ext) => path.join(DIR, `${seq++}.${ext}`);

const P1 = '5cf00c03a266b7e1877504a1';
const P2 = '5cf00c03a266b7e1877504a2';

/** Index row of chunk `chunkId`; the key is not the chunk id, as with the indexer's base64 key. */
const row = (documentId, chunkId, projectId = P1) =>
  ({ id: `key-${chunkId}`, chunkId, documentId, projectId, pageNumber: 0 });

function fakeDocuments(docs) {
  return {
    async listDistinctProjectIds() {
      return [...new Set(docs.map(d => d.projectId))];
    },
    async projectedRowsForProject(access, projectId) {
      return docs.filter(d => d.projectId === projectId).map(d => ({ id: d.id }));
    },
    async parentFieldRowsWithNoProject() {
      return [];
    }
  };
}

/**
 * The index answers from `rows` minus deletes, one row per page so every listing pages. Keys in
 * `failKeys` come back refused, as deleteDocuments reports a rejected batch.
 */
function fakeSearch(rows, { configured = true, onList = () => {}, failKeys = [] } = {}) {
  const state = { deleted: [] };
  return {
    state,
    MAX_PAGE_ROWS: 1,
    config: () => ({ configured, index: 'chunks' }),
    async runSearch(index, opts) {
      const documentId = /^documentId eq '(.*)'$/.exec(opts.filter)[1];
      onList(documentId);
      const mine = rows.filter(r => r.documentId === documentId && !state.deleted.includes(r.id));
      return { value: mine.slice(opts.skip, opts.skip + opts.top) };
    },
    async deleteDocuments(keys) {
      state.deleted.push(...keys.filter(key => !failKeys.includes(key)));
      return keys.filter(key => failKeys.includes(key));
    }
  };
}

/** `cosmos` maps document id to its chunk ids, or to an Error the read throws. */
const fakeChunks = (cosmos) => ({
  async idsForDocument(access, documentId) {
    if (cosmos[documentId] instanceof Error) throw cosmos[documentId];
    return cosmos[documentId] || [];
  }
});

const auditActions = (file) => fs.readFileSync(file, 'utf8').trim().split('\n')
  .map(line => JSON.parse(line)).map(line => `${line.key}:${line.action}`);

/** One document whose newer chunking `c1` is live and whose old `c0` row is left in the index. */
function oneLeftover() {
  return {
    documents: fakeDocuments([{ id: 'd1', projectId: P1 }]),
    chunks: fakeChunks({ d1: ['c1'] }),
    search: fakeSearch([row('d1', 'c0'), row('d1', 'c1')]),
    cosmosReady: true
  };
}

test('a dry run deletes nothing and writes a would-delete line per index-only row', async () => {
  const opts = oneLeftover();
  const audit = tmpFile('ndjson');

  await purge(['--audit', audit], opts);

  assert.deepStrictEqual(opts.search.state.deleted, []);
  assert.deepStrictEqual(auditActions(audit), ['key-c0:would-delete']);
});

test('a live run deletes only the listed keys whose chunk id the Cosmos read lacks', async () => {
  const opts = oneLeftover();
  // A row with no chunk id cannot be judged, so it stays.
  opts.search = fakeSearch([row('d1', 'c0'), row('d1', 'c1'), { id: 'key-blank', documentId: 'd1' }]);
  const audit = tmpFile('ndjson');

  await purge(['--live', '--max-delete', '10', '--audit', audit], opts);

  assert.deepStrictEqual(opts.search.state.deleted, ['key-c0']);
  assert.deepStrictEqual(auditActions(audit), ['key-c0:deleted']);
});

test('a chunk written after the index listing is kept, because Cosmos is read after it', async () => {
  const cosmos = { d1: ['c1'] };
  const opts = {
    documents: fakeDocuments([{ id: 'd1', projectId: P1 }]),
    chunks: fakeChunks(cosmos),
    // c2 is indexed and lands in Cosmos while the listing runs.
    search: fakeSearch([row('d1', 'c1'), row('d1', 'c2')], { onList: () => { cosmos.d1 = ['c1', 'c2']; } }),
    cosmosReady: true
  };

  await purge(['--live', '--max-delete', '10', '--audit', tmpFile('ndjson')], opts);

  assert.deepStrictEqual(opts.search.state.deleted, []);
});

test('a document with no Cosmos chunk keeps all its index rows', async () => {
  const opts = {
    documents: fakeDocuments([{ id: 'd1', projectId: P1 }]),
    chunks: fakeChunks({}),
    search: fakeSearch([row('d1', 'c0'), row('d1', 'c1')]),
    cosmosReady: true
  };
  const audit = tmpFile('ndjson');

  const summary = await purge(['--live', '--max-delete', '10', '--audit', audit], opts);

  assert.deepStrictEqual(opts.search.state.deleted, []);
  assert.strictEqual(summary.run.keptNoLiveRows, 2);
  assert.deepStrictEqual(auditActions(audit), ['key-c0:kept-no-live', 'key-c1:kept-no-live']);
});

test('--live without --max-delete refuses before any read', async () => {
  const opts = oneLeftover();

  await assert.rejects(purge(['--live', '--audit', tmpFile('ndjson')], opts), /--max-delete/);
  assert.deepStrictEqual(opts.search.state.deleted, []);
});

test('the delete ceiling allows an exact fit and stops before the delete that would pass it', async () => {
  const opts = {
    documents: fakeDocuments([{ id: 'd1', projectId: P1 }, { id: 'd2', projectId: P1 }]),
    chunks: fakeChunks({ d1: ['c9'], d2: ['c8'] }),
    search: fakeSearch([row('d1', 'c0'), row('d1', 'c1'), row('d2', 'c2'), row('d2', 'c3')]),
    cosmosReady: true
  };

  // Two documents of 2 rows under a ceiling of 2: the first fills it exactly, the second stops.
  const summary = await purge(['--live', '--max-delete', '2', '--audit', tmpFile('ndjson')], opts);

  assert.strictEqual(opts.search.state.deleted.length, 2);
  assert.strictEqual(summary.stop, 'max-delete');
  assert.strictEqual(exitCodeFor(summary), 1);
});

test('a live run refuses when search is not configured', async () => {
  const opts = oneLeftover();
  opts.search = fakeSearch([row('d1', 'c0')], { configured: false });

  await assert.rejects(
    purge(['--live', '--max-delete', '10', '--audit', tmpFile('ndjson')], opts),
    /SEARCH_ENDPOINT/
  );
});

test('a run stopped by --max-minutes resumes from its state file at the next partition', async () => {
  const state = tmpFile('json');
  const opts = () => {
    // Each partition check reads the clock once, after the start; the second one is past the limit.
    const times = [0, 0, 120000];
    return {
      documents: fakeDocuments([{ id: 'd1', projectId: P1 }, { id: 'd2', projectId: P2 }]),
      chunks: fakeChunks({ d1: ['c1'], d2: ['c2'] }),
      search: fakeSearch([row('d1', 'c0'), row('d2', 'c3', P2)]),
      clock: () => times.shift() ?? 0,
      cosmosReady: true
    };
  };
  const args = ['--state', state, '--max-minutes', '1', '--audit', tmpFile('ndjson')];

  const first = await purge(args, opts());
  const second = await purge(args, opts());

  assert.strictEqual(first.stop, 'max-minutes');
  assert.strictEqual(second.resumed, 1);
  assert.strictEqual(second.run.documents, 1);
  assert.strictEqual(second.total.wouldDelete, 2);
});

test('a live run refuses a state file a dry run wrote', async () => {
  const state = tmpFile('json');
  await purge(['--state', state, '--audit', tmpFile('ndjson')], oneLeftover());

  await assert.rejects(
    purge(['--live', '--max-delete', '10', '--state', state, '--audit', tmpFile('ndjson')],
      oneLeftover()),
    /another mode/
  );
});

test('a partition with a failed delete or an unjudged document is walked again on resume', async () => {
  const state = tmpFile('json');
  const opts = () => ({
    documents: fakeDocuments([{ id: 'd1', projectId: P1 }, { id: 'd2', projectId: P2 }]),
    chunks: fakeChunks({ d1: ['c1'], d2: new Error('throttled') }),
    search: fakeSearch([row('d1', 'c0'), row('d2', 'c2', P2)], { failKeys: ['key-c0'] }),
    cosmosReady: true
  });
  const args = ['--live', '--max-delete', '10', '--state', state, '--audit', tmpFile('ndjson')];

  await purge(args, opts());
  const second = await purge(args, opts());

  assert.strictEqual(second.resumed, 1);
});
