'use strict';

/**
 * Images uploaded through the Update form are Documents with `documentSource: 'UPDATE'`. They show
 * on their Update only, so the Cosmos document lists leave them out. No Cosmos runs here, so the
 * SQL sent is the observable surface.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const documentsRepo = require('../../src/repositories/documents');
const documentController = require('../../src/controllers/nosql/document');
const chunksRepo = require('../../src/repositories/chunks');
const { Readable } = require('node:stream');

// Null-safe: a missing or null documentSource must keep the row, which `!=` alone would not.
const EXCLUSION = '(NOT IS_STRING(c.documentSource) OR c.documentSource != @updateSource)';
const PUBLIC = { tier: 'public', roles: ['public'] };
const ADMIN_USER = { realm_access: { roles: ['sysadmin'] } };
const UPDATE_IMAGE = { id: 'd1', projectId: '207', read: ['public'], documentSource: 'UPDATE' };

/** Every Cosmos query this test makes, with the one parameter that names the excluded source. */
function captureQueries(t) {
  const specs = [];
  t.mock.method(cosmos, 'query', async (_container, spec) => {
    specs.push(spec);
    return { items: [] };
  });
  return specs;
}

const updateSourceOf = spec => spec.parameters.find(p => p.name === '@updateSource')?.value;

test('Update-form images stay out of the Cosmos document lists', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('the recent-uploads project ranking leaves them out', async (tt) => {
    const specs = captureQueries(tt);

    await documentsRepo.projectUploadMaxima(PUBLIC);

    assert.ok(specs[0].query.includes(EXCLUSION), specs[0].query);
    assert.strictEqual(updateSourceOf(specs[0]), 'UPDATE');
  });

  await t.test('the recent-uploads rows of a project leave them out', async (tt) => {
    const specs = captureQueries(tt);

    await documentsRepo.newestUploads(PUBLIC, '207');

    assert.ok(specs[0].query.includes(EXCLUSION), specs[0].query);
    assert.strictEqual(updateSourceOf(specs[0]), 'UPDATE');
  });

  // GET /documents is also the extraction host's work list (`extracted=false`), so this is what
  // keeps Update images from ever getting chunks.
  await t.test('GET /documents leaves them out', async (tt) => {
    const specs = captureQueries(tt);
    const res = { status() { return this; }, json() { return this; }, setHeader() {} };

    await documentController.getDocuments(
      { query: { extracted: 'false' }, params: {}, header: () => null }, res);

    assert.ok(specs[0].query.includes(EXCLUSION), specs[0].query);
    assert.strictEqual(updateSourceOf(specs[0]), 'UPDATE');
  });

  // The chunk search resolves each hit's parent through listByIds: an Update image's chunk, if one
  // was made before the ingest refusal, must not reach a result.
  await t.test('the chunk parent lookup leaves them out', async (tt) => {
    const specs = captureQueries(tt);

    await documentsRepo.listByIds(PUBLIC, ['d1'], ['207']);

    assert.ok(specs[0].query.includes(EXCLUSION), specs[0].query);
    assert.strictEqual(updateSourceOf(specs[0]), 'UPDATE');
  });

  // Backfills and purges walk every row through listVisible; they must still reach Update images.
  await t.test('listVisible without the flag keeps them', async (tt) => {
    const specs = captureQueries(tt);

    await documentsRepo.listVisible(PUBLIC, {});

    assert.ok(!specs[0].query.includes(EXCLUSION), specs[0].query);
  });
});

test('chunk ingest refuses an Update-form image', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  /** Every chunk write the handler attempts, by either door. */
  function stubWrites(tt) {
    const writes = [];
    tt.mock.method(documentsRepo, 'getById', async () => UPDATE_IMAGE);
    tt.mock.method(documentsRepo, 'patchExtraction', async (...args) => { writes.push(['patch', args]); return {}; });
    tt.mock.method(chunksRepo, 'replaceForDocument', async (...args) => { writes.push(['replace', args]); return { succeeded: 1, failed: 0 }; });
    tt.mock.method(chunksRepo, 'upsertBatch', async (...args) => { writes.push(['upsert', args]); return { succeeded: 1, failed: 0 }; });
    return writes;
  }
  const res = () => ({
    statusCode: 200, body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    setHeader() {}
  });

  await t.test('a JSON body answers 409 and writes nothing', async (tt) => {
    const writes = stubWrites(tt);
    const out = res();

    await documentController.ingestChunks(
      { params: { id: 'd1' }, query: {}, body: { markdown: 'x'.repeat(200) }, user: ADMIN_USER }, out);

    assert.strictEqual(out.statusCode, 409);
    assert.deepStrictEqual(writes, []);
  });

  await t.test('an NDJSON stream answers 409 and writes nothing', async (tt) => {
    const writes = stubWrites(tt);
    const out = res();
    const lines = [JSON.stringify({}), JSON.stringify('x'.repeat(300))];

    await documentController.ingestChunks({
      stream: Readable.from(lines.map(l => `${l}\n`)),
      params: { id: 'd1' }, query: {}, user: ADMIN_USER, is: (type) => type === 'application/x-ndjson'
    }, out);

    assert.strictEqual(out.statusCode, 409);
    assert.deepStrictEqual(writes, []);
  });
});
