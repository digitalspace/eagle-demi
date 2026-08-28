'use strict';

/**
 * The document half of the field redactor: which attributes of a visible document leave, and which
 * body keys may come back in. The row gate (`read[]`) decides which documents; this decides which
 * fields of one, and it is level-driven rather than a fixed strip.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const documents = require('../../../src/repositories/documents');
const documentController = require('../../../src/controllers/nosql/document');

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    setHeader(k, v) { this.headers[k] = v; }
  };
}

const SYSADMIN = { realm_access: { roles: ['sysadmin'] } };

const STORED = {
  id: 'd1',
  projectId: '207',
  displayName: 'Application Part A',
  documentFileName: 'part-a.pdf',
  s3Key: 'etl/site-c/1389817063122_20d7490a.pdf',
  read: ['public', 'sysadmin', 'staff', 'demi-admin'],
  ownRead: ['public', 'sysadmin'],
  isPublished: true,
  _etag: '"0x8DF007286A35D0A"'
};

test('document field redaction', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('anonymous GET /api/documents/:id omits s3Key, read, _etag', async () => {
    t.mock.method(documents, 'getById', async () => structuredClone(STORED));

    const res = mockRes();
    await documentController.getDocument({ params: { id: 'd1' }, query: {} }, res);

    assert.strictEqual(res.body.s3Key, undefined, 'the object key is withheld');
    assert.strictEqual(res.body.read, undefined, 'the ACL is withheld');
    assert.strictEqual(res.body.ownRead, undefined, 'the pre-cascade ACL is withheld too');
    assert.strictEqual(res.body._etag, undefined, 'the concurrency token is withheld');
    assert.strictEqual(res.body.displayName, 'Application Part A', 'the record survives');
    assert.strictEqual(res.body.isPublished, true, 'the mirror survives');
  });

  await t.test('a sysadmin GET /api/documents/:id returns the level-2 fields', async () => {
    // Proves the redactor is level-driven and not a strip: the same row, a different caller.
    t.mock.method(documents, 'getById', async () => structuredClone(STORED));

    const res = mockRes();
    await documentController.getDocument(
      { params: { id: 'd1' }, query: {}, user: SYSADMIN }, res);

    assert.strictEqual(res.body._etag, STORED._etag, 'maxVis 2, and sysadmin is level 1');

    // `s3Key` and `read` are `maxVis: 0`, and 0 is no longer a caller level — sysadmin is 1. They
    // reach nobody through a response now, sysadmin included.
    assert.strictEqual(res.body.s3Key, undefined);
    assert.strictEqual(res.body.read, undefined);
  });

  await t.test('PUT /api/documents/:id rejects a hidden body key', async () => {
    t.mock.method(documents, 'getById', async () => structuredClone(STORED));
    let upserted = false;
    t.mock.method(documents, 'upsert', async (doc) => { upserted = true; return doc; });

    const res = mockRes();
    await documentController.updateDocument({
      params: { id: 'd1' }, query: {}, body: { s3Key: 'x' }
    }, res);

    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /s3Key/);
    assert.strictEqual(upserted, false, 'a refused body never reaches the upsert');
  });

  await t.test('PUT /api/documents/:id rejects vis for every caller', async () => {
    // Unconditional, not level-gated: a dial is policy, and no route sets one yet.
    t.mock.method(documents, 'getById', async () => structuredClone(STORED));
    let upserted = false;
    t.mock.method(documents, 'upsert', async (doc) => { upserted = true; return doc; });

    const res = mockRes();
    await documentController.updateDocument({
      params: { id: 'd1' }, query: {}, user: SYSADMIN, body: { vis: { displayName: 0 } }
    }, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(upserted, false);
  });

  await t.test('PUT /api/documents/:id still accepts an ordinary edit', async () => {
    t.mock.method(documents, 'getById', async () => structuredClone(STORED));
    let saved;
    t.mock.method(documents, 'upsert', async (doc) => { saved = doc; return doc; });

    const res = mockRes();
    await documentController.updateDocument({
      params: { id: 'd1' }, query: {}, body: { displayName: 'Renamed' }
    }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(saved.displayName, 'Renamed');
    assert.deepStrictEqual(saved.read, STORED.read, 'the stored ACL is untouched');
    assert.strictEqual(saved.s3Key, STORED.s3Key, 'the stored object key is untouched');
    assert.strictEqual(res.body.s3Key, undefined, 'the response is still redacted');
  });

  await t.test('a round-tripped Cosmos bookkeeping key is not a hidden key', async () => {
    // A caller GETs a row and PUTs back what it was given. Bookkeeping keys are dropped rather
    // than refused, so the guard cannot 400 an otherwise ordinary edit.
    t.mock.method(documents, 'getById', async () => structuredClone(STORED));
    let saved;
    t.mock.method(documents, 'upsert', async (doc) => { saved = doc; return doc; });

    const res = mockRes();
    // What a GET hands back: the `maxVis: 0` fields are not in it, so they cannot come back either.
    const asReturned = structuredClone(STORED);
    for (const hidden of ['s3Key', 'read', 'ownRead']) delete asReturned[hidden];

    await documentController.updateDocument({
      params: { id: 'd1' }, query: {}, user: SYSADMIN,
      body: { ...asReturned, _rid: 'abc', _ts: 1, displayName: 'Renamed' }
    }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(saved._rid, undefined, 'the bookkeeping key is not written back');
    assert.deepStrictEqual(saved.ownRead, STORED.ownRead, 'ownRead comes off the stored row');
  });
});
