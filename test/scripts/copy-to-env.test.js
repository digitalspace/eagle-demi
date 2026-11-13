'use strict';

process.env.NODE_ENV = 'test';
process.env.COSMOS_ENDPOINT = 'https://source.example/';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { main } = require('../../src/scripts/copy-to-env');
const { logger } = require('../../src/utils/logger');

const TARGET = 'https://target.example/';

/** One container: `pages` keyed by continuation token ('start' = first page), `stored` = rows upserted. */
function fakeContainer(pages, total) {
  const reads = [];
  const stored = [];
  let fetches = 0;
  return {
    reads,
    stored,
    items: {
      query(spec, opts = {}) {
        reads.push({ query: spec.query, token: opts.continuationToken });
        return {
          async fetchAll() { return { resources: [total ?? stored.length] }; },
          async fetchNext() {
            // Each page is served once; a copy loop that never stops fails here instead of hanging.
            if (++fetches > Object.keys(pages).length) throw new Error(`fetchNext called ${fetches} times`);
            return pages[opts.continuationToken || 'start'];
          }
        };
      },
      async upsert(row) { stored.push(row); return { resource: row }; }
    }
  };
}

function fakeClient(source, target) {
  const byEndpoint = { [process.env.COSMOS_ENDPOINT]: source, [TARGET]: target };
  return (endpoint) => ({
    database() { return { container() { return byEndpoint[endpoint]; } }; }
  });
}

// A factory: the script deletes system properties from the rows it reads, in place.
function onePage() {
  return {
    start: {
      resources: [{ id: 'a', _rid: 'r1', _etag: 'e1', _ts: 1 }, { id: 'b', _rid: 'r2', _etag: 'e2', _ts: 2 }],
      continuationToken: undefined,
      hasMoreResults: false
    }
  };
}

function staffPage() {
  const staff = {
    externalIds: [{ system: 'track', value: '1' }], staffAssignments: [{ role: 'epd' }],
    capitalInvestments: [{ amountCad: 1 }], staffNotes: [{ text: 'note' }]
  };
  const row = {
    id: 'p1', name: 'Mine', intake: 'x', ...staff, legislation_2002: { name: 'Mine', intake: 'x' },
    sources: { eagle: { name: 'Mine', intake: 'x', legislation_1996: { name: 'Mine', intake: 'x' } } }
  };
  return { start: { resources: [row], continuationToken: undefined, hasMoreResults: false } };
}

function tmpCheckpoint(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-to-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'cp.json');
}

test('copy-to-env', async (t) => {
  t.beforeEach((tt) => {
    tt.mock.method(logger, 'info', () => {});
    tt.mock.method(logger, 'warn', () => {});
  });

  await t.test('a dry run counts the source and writes nothing to the target', async (tt) => {
    const source = fakeContainer(onePage(), 2);
    const target = fakeContainer({});
    await main(['--target', TARGET, '--containers', 'projects', '--checkpoint', tmpCheckpoint(tt)],
      { client: fakeClient(source, target) });
    assert.deepStrictEqual(source.reads.map((r) => r.query), ['SELECT VALUE COUNT(1) FROM c']);
    assert.deepStrictEqual(target.stored, []);
  });

  await t.test('--live upserts every source row into the target', async (tt) => {
    const source = fakeContainer(onePage(), 2);
    const target = fakeContainer({});
    await main(['--target', TARGET, '--containers', 'projects', '--checkpoint', tmpCheckpoint(tt), '--live'],
      { client: fakeClient(source, target) });
    assert.deepStrictEqual(target.stored.map((r) => r.id), ['a', 'b']);
  });

  await t.test('--live strips Cosmos system properties before the upsert', async (tt) => {
    const source = fakeContainer(onePage(), 2);
    const target = fakeContainer({});
    await main(['--target', TARGET, '--containers', 'projects', '--checkpoint', tmpCheckpoint(tt), '--live'],
      { client: fakeClient(source, target) });
    assert.deepStrictEqual(target.stored[0], { id: 'a' });
  });

  await t.test('--live resumes from and advances the checkpoint at --checkpoint', async (tt) => {
    const checkpoint = tmpCheckpoint(tt);
    fs.writeFileSync(checkpoint, JSON.stringify({ projects: { copied: 1, token: 't1' } }));
    const pages = {
      start: onePage().start,
      t1: { resources: [{ id: 'b' }], continuationToken: undefined, hasMoreResults: false }
    };
    const source = fakeContainer(pages, 2);
    const target = fakeContainer({});
    await main(['--target', TARGET, '--containers', 'projects', '--checkpoint', checkpoint, '--live'],
      { client: fakeClient(source, target) });
    assert.deepStrictEqual(target.stored.map((r) => r.id), ['b']);
    assert.strictEqual(JSON.parse(fs.readFileSync(checkpoint, 'utf8')).projects.copied, 2);
  });

  await t.test('--live follows the continuation token across pages and ends with no stored token', async (tt) => {
    const checkpoint = tmpCheckpoint(tt);
    const pages = {
      start: { resources: [{ id: 'a' }, { id: 'b' }], continuationToken: 't1', hasMoreResults: true },
      t1: { resources: [{ id: 'c' }], continuationToken: undefined, hasMoreResults: false }
    };
    const source = fakeContainer(pages, 3);
    const target = fakeContainer({});
    await main(['--target', TARGET, '--containers', 'projects', '--checkpoint', checkpoint, '--live'],
      { client: fakeClient(source, target) });
    assert.deepStrictEqual(target.stored.map((r) => r.id), ['a', 'b', 'c']);
    assert.strictEqual(JSON.parse(fs.readFileSync(checkpoint, 'utf8')).projects.token, undefined);
  });

  await t.test('--live skips a container whose target already holds as many rows as the source', async (tt) => {
    const source = fakeContainer(onePage(), 2);
    const target = fakeContainer({}, 2);
    await main(['--target', TARGET, '--containers', 'projects', '--checkpoint', tmpCheckpoint(tt), '--live'],
      { client: fakeClient(source, target) });
    assert.deepStrictEqual(source.reads.map((r) => r.query), ['SELECT VALUE COUNT(1) FROM c']);
    assert.deepStrictEqual(target.stored, []);
  });

  await t.test('copy-to-env refuses works, ImportBatch, ImportBatchEntry and ImportLock', async (tt) => {
    await tt.test('--containers naming works throws before any read', async (ttt) => {
      const source = fakeContainer(onePage(), 2);
      await assert.rejects(main(['--target', TARGET, '--containers', 'projects,works', '--checkpoint', tmpCheckpoint(ttt), '--live'],
        { client: fakeClient(source, fakeContainer({})) }), { message: 'Refusing to copy container works' });
      assert.deepStrictEqual(source.reads, []);
    });

    await tt.test('lists rows of the import kinds are not upserted', async (ttt) => {
      const kinds = ['List', 'ImportBatch', 'ImportBatchEntry', 'ImportLock', 'WorksCatalog'];
      const pages = { start: { resources: kinds.map(kind => ({ id: kind, kind })), continuationToken: undefined, hasMoreResults: false } };
      const target = fakeContainer({});
      await main(['--target', TARGET, '--containers', 'lists', '--checkpoint', tmpCheckpoint(ttt), '--live'],
        { client: fakeClient(fakeContainer(pages, kinds.length), target) });
      assert.deepStrictEqual(target.stored.map((r) => r.kind), ['List', 'WorksCatalog']);
    });
  });

  await t.test('copy strips the four staff-only fields and every intake copy (top level, legislation blocks, sources.eagle)', async (tt) => {
    const target = fakeContainer({});
    await main(['--target', TARGET, '--containers', 'projects', '--checkpoint', tmpCheckpoint(tt), '--live'],
      { client: fakeClient(fakeContainer(staffPage(), 1), target) });
    assert.deepStrictEqual(target.stored[0], {
      id: 'p1', name: 'Mine', legislation_2002: { name: 'Mine' }, sources: { eagle: { name: 'Mine', legislation_1996: { name: 'Mine' } } }
    });
  });

  await t.test('copy keeps them with --keep-staff', async (tt) => {
    const target = fakeContainer({});
    await main(['--target', TARGET, '--containers', 'projects', '--checkpoint', tmpCheckpoint(tt), '--keep-staff', 'SIGNOFF-1', '--live'],
      { client: fakeClient(fakeContainer(staffPage(), 1), target) });
    assert.deepStrictEqual(target.stored[0], staffPage().start.resources[0]);
  });

  await t.test('--keep-staff with no sign-off reference throws before any read', async (tt) => {
    const source = fakeContainer(staffPage(), 1);
    await assert.rejects(main(['--target', TARGET, '--containers', 'projects', '--checkpoint', tmpCheckpoint(tt), '--keep-staff', '--live'],
      { client: fakeClient(source, fakeContainer({})) }), { message: '--keep-staff needs a sign-off reference' });
    assert.deepStrictEqual(source.reads, []);
  });

  await t.test('--keep-staff with a reference holding a space throws', async (tt) => {
    await assert.rejects(main(['--target', TARGET, '--containers', 'projects', '--checkpoint', tmpCheckpoint(tt), '--keep-staff', 'SIGNOFF 1'],
      { client: fakeClient(fakeContainer(staffPage(), 1), fakeContainer({})) }), { message: '--keep-staff needs a sign-off reference' });
  });

  await t.test('a run with no --target throws', async (tt) => {
    await assert.rejects(main(['--containers', 'projects', '--checkpoint', tmpCheckpoint(tt)],
      { client: fakeClient(fakeContainer({}), fakeContainer({})) }), { message: 'Missing --target <endpoint>' });
  });

  await t.test('a run with no COSMOS_ENDPOINT throws', async (tt) => {
    const endpoint = process.env.COSMOS_ENDPOINT;
    delete process.env.COSMOS_ENDPOINT;
    tt.after(() => { process.env.COSMOS_ENDPOINT = endpoint; });
    await assert.rejects(main(['--target', TARGET, '--containers', 'projects', '--checkpoint', tmpCheckpoint(tt)],
      { client: fakeClient(fakeContainer({}), fakeContainer({})) }), { message: 'COSMOS_ENDPOINT not set' });
  });
});
