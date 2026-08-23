'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const script = require('../../src/scripts/apply-search-definitions');

test('apply-search-definitions', async (t) => {
  await t.test('loads every index and indexer definition, indexes sorted', () => {
    const indexes = script.load(script.INDEX_DIR).map(d => d.body.name);
    const indexers = script.load(script.INDEXER_DIR).map(d => d.body.name);
    assert.deepStrictEqual(indexes, ['chunks', 'documents', 'projects']);
    assert.deepStrictEqual(indexers, ['chunks-indexer', 'documents-indexer', 'projects-indexer']);
  });

  await t.test('every indexer targets an index that is being applied alongside it', () => {
    // An indexer fails to create if its target index is missing, so a definition set that
    // references an index nobody ships is a run that dies half-applied.
    const indexNames = new Set(script.load(script.INDEX_DIR).map(d => d.body.name));
    for (const { body } of script.load(script.INDEXER_DIR)) {
      assert.ok(
        indexNames.has(body.targetIndexName),
        `${body.name} targets "${body.targetIndexName}", which no index definition declares`
      );
    }
  });

  await t.test('every indexer names a data source, and none is shipped as a definition', () => {
    // The script refuses to create data sources: connectionString comes back redacted on export,
    // so a definition file could only ever restore a broken one.
    const fs = require('fs');
    const dsDir = path.join(script.INDEX_DIR, '..', 'datasources');
    const onDisk = fs.readdirSync(dsDir).filter(f => f.endsWith('.json'));
    assert.ok(onDisk.length > 0, 'data source definitions should still be committed for reference');
    for (const { body } of script.load(script.INDEXER_DIR)) {
      assert.ok(body.dataSourceName, `${body.name} has no dataSourceName`);
    }
  });

  await t.test('--live is opt-in and unknown flags are refused', () => {
    assert.strictEqual(script.parseArgs([]).live, false);
    assert.strictEqual(script.parseArgs(['--live']).live, true);
    assert.strictEqual(script.parseArgs(['--only', 'chunks']).only, 'chunks');
    assert.throws(() => script.parseArgs(['--only']), /needs a value/);
    // The EMPTY case is separate from the missing one: `--only "$IDX"` with IDX unset satisfies the
    // value() guard, and select() would then short-circuit its must-match check and apply all six
    // objects instead of the one asked for.
    assert.throws(() => script.parseArgs(['--only', '']), /empty value/);
    assert.throws(() => script.parseArgs(['--only', '   ']), /empty value/);
    assert.throws(() => script.parseArgs(['--oops']), /unknown flag/);
  });

  // These drive run() with a stubbed transport, the way copy-blobs.test.js drives copyOne. Asserting
  // the definitions-vs-live property from the files alone says nothing about whether the code still
  // CHECKS it — deleting the guard from run() left the whole suite green until these existed.
  const stub = (t2, handler) => {
    const calls = [];
    const original = global.fetch;
    // MOCK THE TOKEN, not just the transport. getToken() goes to DefaultAzureCredential, which on a
    // developer box quietly succeeds off an existing az login and in CI spends ~15s probing IMDS
    // before failing — so without this the suite passes locally and fails in CI, which is how the
    // gap was found. Mocking it also keeps these tests from depending on any ambient credential.
    const aiSearch = require('../../src/search/ai-search');
    t2.mock.method(aiSearch, 'getToken', async () => 'test-token');
    global.fetch = async (url, init) => {
      calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
      return handler ? handler(url, init) : { status: 404, text: async () => '' };
    };
    t2.after(() => { global.fetch = original; });
    return calls;
  };
  const ENDPOINT = 'https://svc.search.windows.net';
  // GET: data sources exist, indexes and indexers do not yet (the state a first run meets).
  // PUT: created. A stub that 404s a PUT makes run() throw before it can be observed.
  const ok = (url, init) => ({
    status: init.method === 'PUT' ? 201 : (/\/datasources\//.test(url) ? 200 : 404),
    text: async () => ''
  });

  await t.test('a dry run writes nothing at all', async (tt) => {
    const calls = stub(tt, ok);
    await script.run({ endpoint: ENDPOINT, live: false, only: '', liveNames: ['demi-chunks'] });
    assert.strictEqual(calls.filter(c => c.method === 'PUT').length, 0, 'a dry run must issue no PUT');
    assert.ok(calls.length > 0, 'and it must still probe, or it proved nothing');
  });

  await t.test('--live writes indexes before indexers, and never a data source', async (tt) => {
    const calls = stub(tt, ok);
    await script.run({ endpoint: ENDPOINT, live: true, only: '', liveNames: ['demi-chunks'] });
    const puts = calls.filter(c => c.method === 'PUT').map(c => c.url.split('?')[0].replace(ENDPOINT, ''));
    assert.deepStrictEqual(puts, [
      '/indexes/chunks', '/indexes/documents', '/indexes/projects',
      '/indexers/chunks-indexer', '/indexers/documents-indexer', '/indexers/projects-indexer'
    ], 'every index must be written before any indexer');
    assert.strictEqual(
      calls.filter(c => c.method === 'PUT' && /\/datasources\//.test(c.url)).length, 0,
      'a data source must never be written — connectionString is redacted on export'
    );
  });

  // THE SILENT FAILURE. This script never writes a data source, so a field added to an index and
  // to the committed data source is applied, reported green, and then never populated — the live
  // indexer keeps projecting the old SELECT and every new field stays null.
  await t.test('a live data source whose query differs from the committed copy is called out', async (tt) => {
    const lines = [];
    const log = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    tt.after(() => { console.log = log; });

    stub(tt, (url, init) => {
      const ds = /\/datasources\/([^?]+)/.exec(url)?.[1];
      if (ds) {
        // Only the documents data source is stale, and with the pre-widening SELECT: no typeId,
        // no datePosted. The other two match, so the tally has to be 1 — a guard that warned on
        // every data source would pass this assertion just as well.
        const body = ds === 'demi-documents-ds'
          ? { name: ds, container: { name: 'documents', query: 'SELECT c.id, c.displayName FROM c' } }
          : script.readCommittedDataSource(ds);
        return { status: 200, text: async () => JSON.stringify(body) };
      }
      return { status: init.method === 'PUT' ? 201 : 404, text: async () => '' };
    });

    await script.run({ endpoint: ENDPOINT, live: false, only: '', liveNames: [] });
    const out = lines.join('\n');
    assert.match(out, /data source demi-documents-ds DIFFERS/);
    assert.match(out, /stays null/);
    assert.match(out, /WARNING: 1 data source\(s\) differ/);
  });

  await t.test('an unchanged data source raises nothing', async (tt) => {
    const lines = [];
    const log = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    tt.after(() => { console.log = log; });

    const committed = script.readCommittedDataSource('demi-documents-ds');
    stub(tt, (url, init) => {
      if (/\/datasources\//.test(url)) {
        return { status: 200, text: async () => JSON.stringify(committed) };
      }
      return { status: init.method === 'PUT' ? 201 : 404, text: async () => '' };
    });

    await script.run({ endpoint: ENDPOINT, live: false, only: 'documents', liveNames: [] });
    assert.ok(!lines.join('\n').includes('DIFFERS'), 'a matching query must not warn');
  });

  await t.test('run() refuses to write an index the app is serving from', async (tt) => {
    const calls = stub(tt, ok);
    await assert.rejects(
      () => script.run({ endpoint: ENDPOINT, live: true, only: '', liveNames: ['chunks'] }),
      /refusing to PUT index "chunks"/
    );
    assert.strictEqual(calls.filter(c => c.method === 'PUT').length, 0, 'and it must refuse BEFORE writing anything');
  });

  await t.test('a DRY RUN is never refused, even when the names are the live ones', async (tt) => {
    // The guard used to run before the dry-run split, so once the rename made the committed names
    // the live ones, the first command an operator reaches for during an incident exited 1 without
    // printing anything. A dry run touches nothing — it must work in every state, and say which
    // indexes are serving.
    const calls = stub(tt, ok);
    const lines = [];
    const realLog = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try {
      await script.run({ endpoint: ENDPOINT, live: false, only: '', liveNames: ['chunks', 'projects', 'documents'] });
    } finally {
      console.log = realLog;
    }
    assert.strictEqual(calls.filter(c => c.method === 'PUT').length, 0, 'still writes nothing');
    assert.ok(calls.length > 0, 'and it still probes, so it reported something');
    // AND IT SAYS WHICH ARE SERVING. Without this the test asserted nothing the previous dry-run
    // test did not already cover, and blanking the marker left the suite green.
    for (const name of ['chunks', 'projects', 'documents']) {
      assert.ok(
        lines.some(l => l.includes(name) && l.includes('SERVING TRAFFIC')),
        `the dry run must mark "${name}" as serving; output was:\n${lines.join('\n')}`
      );
    }
  });

  await t.test('a missing data source stops the run rather than creating one', async (tt) => {
    stub(tt, () => ({ status: 404, text: async () => '' }));
    await assert.rejects(
      () => script.run({ endpoint: ENDPOINT, live: false, only: '', liveNames: ['demi-chunks'] }),
      /does not exist/
    );
  });

  await t.test('--only accepts either vocabulary and refuses a value that matches nothing', () => {
    assert.deepStrictEqual(script.select('chunks').indexers.map(d => d.body.name), ['chunks-indexer']);
    assert.deepStrictEqual(script.select('chunks-indexer').indexes.map(d => d.body.name), ['chunks']);
    assert.throws(() => script.select('typo'), /matches no definition/);
  });

  await t.test('ai-search still exports the token helper this script destructures', () => {
    // Removing the export leaves the suite green and the script dies at its first request with
    // "getToken is not a function", because destructuring a missing property does not throw.
    assert.strictEqual(typeof require('../../src/search/ai-search').getToken, 'function');
  });

  await t.test('a 403 names the right cause — network and RBAC are told apart by the body', () => {
    // Both faults arrive as 403 and the status cannot separate them. Getting this backwards sends
    // someone to request a role grant that changes nothing, or to debug networking when the grant
    // is what is missing. The network body below is the verbatim shape Azure returned from a
    // workstation against demi-search-test on 2026-08-22.
    const networkBody = JSON.stringify({ error: { code: '', message:
      "Request is denied as the source is not allowed by applicable rules. The service is set 'publicNetworkAccess: Disabled'." } });
    assert.throws(
      () => script.assertNotForbidden(403, networkBody, 'index chunks'),
      /NETWORK RULES/,
      'a network-rule 403 must not be reported as a missing role'
    );
    assert.throws(
      () => script.assertNotForbidden(403, JSON.stringify({ error: { message: 'Authorization failed.' } }), 'index chunks'),
      /Search Service Contributor/,
      'an authorization 403 must name the role to grant'
    );
    // Anything that is not a 403 passes straight through — this guard must not swallow a 404.
    assert.doesNotThrow(() => script.assertNotForbidden(404, '', 'index chunks'));
    assert.doesNotThrow(() => script.assertNotForbidden(200, '', 'index chunks'));
  });

  await t.test('after the cutover the definitions ARE the live indexes, and the guard is what protects them', () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and it was right to until 2026-08-22. Before the
    // cutover the committed definitions were renamed AHEAD of the service, so the two sets were
    // disjoint and that disjointness was the safety property. The cutover pointed SEARCH_INDEX* at
    // the plain names, so they now coincide BY DESIGN — the old assertion would fail, and "fixing"
    // it by renaming a definition would be undoing the cutover.
    //
    // What still protects a live schema is the runtime guard in run(), covered by
    // 'run() refuses to write an index the app is serving from' above and mutation-proven there.
    // That guard now REFUSES a plain re-run of this script, which is correct: with the names
    // coincident, applying the definitions again would rewrite indexes serving traffic.
    const { config } = require('../../src/search/ai-search');
    const cfg = config();
    const live = new Set([cfg.index, cfg.projectsIndex, cfg.documentsIndex].filter(Boolean));
    const names = script.load(script.INDEX_DIR).map(d => d.body.name);
    assert.ok(
      names.every(n => live.has(n)),
      `expected the committed definitions ${names.join(', ')} to be exactly what the app serves ` +
      `(${[...live].join(', ')}) after the cutover`
    );
  });
});
