'use strict';

process.env.NODE_ENV = 'test';
process.env.COSMOS_ENDPOINT = 'https://source.example/';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { main } = require('../../src/scripts/copy-to-env');

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

function tmpCheckpoint(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-to-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'cp.json');
}

test('copy-to-env', async (t) => {
  t.beforeEach((tt) => tt.mock.method(console, 'log', () => {}));

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

  await t.test('--live skips a container whose target already holds as many rows as the source', async (tt) => {
    const source = fakeContainer(onePage(), 2);
    const target = fakeContainer({}, 2);
    await main(['--target', TARGET, '--containers', 'projects', '--checkpoint', tmpCheckpoint(tt), '--live'],
      { client: fakeClient(source, target) });
    assert.deepStrictEqual(source.reads.map((r) => r.query), ['SELECT VALUE COUNT(1) FROM c']);
    assert.deepStrictEqual(target.stored, []);
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
