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
