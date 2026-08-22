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
    assert.throws(() => script.parseArgs(['--oops']), /unknown flag/);
  });

  // These drive run() with a stubbed transport, the way copy-blobs.test.js drives copyOne. Asserting
  // the definitions-vs-live property from the files alone says nothing about whether the code still
  // CHECKS it — deleting the guard from run() left the whole suite green until these existed.
  const stub = (t2, handler) => {
    const calls = [];
    const original = global.fetch;
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

  await t.test('run() refuses to write an index the app is serving from', async (tt) => {
    const calls = stub(tt, ok);
    await assert.rejects(
      () => script.run({ endpoint: ENDPOINT, live: true, only: '', liveNames: ['chunks'] }),
      /refusing to PUT index "chunks"/
    );
    assert.strictEqual(calls.filter(c => c.method === 'PUT').length, 0, 'and it must refuse BEFORE writing anything');
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

  await t.test('the definitions do not collide with what the app serves today', () => {
    // THE GUARD THIS SCRIPT EXISTS AROUND. An index PUT is not additive: rewriting the schema of an
    // index that is serving traffic is an outage, not an error. The committed definitions are
    // renamed AHEAD of the cutover precisely so these two sets stay disjoint, and this asserts the
    // property rather than trusting the rename.
    const { config } = require('../../src/search/ai-search');
    const cfg = config();
    const live = new Set([cfg.index, cfg.projectsIndex, cfg.documentsIndex].filter(Boolean));
    for (const { body } of script.load(script.INDEX_DIR)) {
      assert.ok(
        !live.has(body.name),
        `definition "${body.name}" is also what the app is configured to serve — applying it ` +
        `would rewrite a live schema`
      );
    }
  });
});
