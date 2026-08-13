'use strict';

/**
 * Every authenticated create, update and delete writes exactly one audit row.
 *
 * That rule is the reason this file exists rather than a handful of assertions scattered through
 * the controller tests: the gap it closed was not a broken audit call, it was seven handlers that
 * never had one — including all three boundary mutations, which nobody noticed until the rule was
 * applied as a checklist. A test per controller would have kept that shape invisible.
 *
 * `exactly one` is the load-bearing word in every assertion below. The failure mode that costs
 * money here is not a missing row, it is a row per chunk or per project: the ingest routes handle
 * ~1.13M chunks and the wildfire sync patches every project, into a table kept for seven years.
 */

process.env.NODE_ENV = 'test';
// Both, before src/config is first required: the writer is inert without them (utils/audit.js),
// so without this the whole file would pass by recording nothing at all.
process.env.AUDIT_DCR_ENDPOINT = 'https://dcr-test.canadacentral-1.ingest.monitor.azure.com';
process.env.AUDIT_DCR_IMMUTABLE_ID = 'dcr-testimmutableid';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { Readable } = require('node:stream');

const audit = require('../../src/utils/audit');
const storage = require('../../src/storage');
const documents = require('../../src/repositories/documents');
const projects = require('../../src/repositories/projects');
const boundaries = require('../../src/repositories/boundaries');
const chunksRepo = require('../../src/repositories/chunks');
const documentController = require('../../src/controllers/nosql/document');
const boundaryController = require('../../src/controllers/nosql/boundary');

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    setHeader() {}
  };
}

// A real Keycloak-shaped principal, not a bare roles object: actorFor() classifies on `sub` and
// `preferred_username`, so a stub without them lands in the 'unknown' bucket and the ActorType
// assertions below would pass while proving nothing.
const STAFF = {
  sub: 'kc-sub-1',
  preferred_username: 'staff.person',
  realm_access: { roles: ['sysadmin'] }
};

let rows = [];
audit._setTransport(async (stream, batch) => { rows.push(...batch); });

/** Run an authenticated mutation and return the audit rows it produced. */
async function rowsFrom(fn) {
  rows = [];
  await fn();
  await audit.flush();
  return rows;
}

test('authenticated CUD audit coverage', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.after(() => audit._resetTransport());

  await t.test('document upload writes one document.create marked via upload', async () => {
    // Same action as createDocument by design — the two doors stay one query — so `via` is the
    // only thing distinguishing them, and it is what this asserts.
    t.mock.method(projects, 'getById', async () => ({
      id: '207', read: ['public', 'staff', 'sysadmin'], isPublished: true, region: 'skeena'
    }));
    t.mock.method(storage, 'putFile', async () => {});
    t.mock.method(fs.promises, 'unlink', async () => {});
    t.mock.method(documents, 'upsert', async (item) => item);

    const res = mockRes();
    const written = await rowsFrom(() => documentController.extractDocument({
      body: { project: '207', displayName: 'Application.pdf' },
      file: { path: '/tmp/up1', originalname: 'Application.pdf', mimetype: 'application/pdf' },
      query: {}, params: {}, user: STAFF
    }, res));

    assert.strictEqual(res.statusCode, 202);
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].Action, 'document.create');
    assert.strictEqual(written[0].Detail.via, 'upload');
    assert.strictEqual(written[0].ProjectId, '207');
    assert.strictEqual(written[0].TargetId, res.body.docId);
    assert.strictEqual(written[0].ActorType, 'user');
    assert.strictEqual(written[0].ActorId, 'kc-sub-1');
  });

  await t.test('JSON chunk ingest writes one document.ingest, not one per chunk', async () => {
    t.mock.method(documents, 'getById', async () => ({
      id: 'd1', projectId: '207', read: ['staff', 'sysadmin'], isPublished: false
    }));
    t.mock.method(documents, 'patchExtraction', async () => ({}));
    t.mock.method(chunksRepo, 'replaceForDocument', async (a, id, items) => ({
      succeeded: items.length, failed: 0, statusCounts: {}
    }));

    const res = mockRes();
    const written = await rowsFrom(() => documentController.ingestChunks({
      params: { id: 'd1' }, query: {}, body: { markdown: 'z'.repeat(4000) }, user: STAFF
    }, res));

    assert.ok(res.body.chunks >= 1);
    assert.strictEqual(written.length, 1, 'one row per document, never per chunk');
    assert.strictEqual(written[0].Action, 'document.ingest');
    assert.strictEqual(written[0].TargetId, 'd1');
    assert.strictEqual(written[0].ProjectId, '207');
    assert.strictEqual(written[0].Detail.streamed, false);
    assert.strictEqual(written[0].Detail.chunks, res.body.chunks);
  });

  await t.test('NDJSON chunk ingest writes one document.ingest marked streamed', async () => {
    // Asserted separately from the JSON path because they are two literal call sites:
    // ingestChunksStreaming and its fail() both hand the same `res` back to ingestChunks, so a
    // single row emitted by the caller could not tell a completed stream from a 500.
    t.mock.method(documents, 'getById', async () => ({
      id: 'd1', projectId: '207', read: ['staff', 'sysadmin'], isPublished: false
    }));
    t.mock.method(documents, 'patchExtraction', async () => ({}));
    t.mock.method(chunksRepo, 'upsertBatch', async (a, id, items) => ({
      succeeded: items.length, failed: 0, statusCounts: {}
    }));
    t.mock.method(chunksRepo, 'deleteSurplus', async () => ({ succeeded: 0, failed: 0 }));

    const lines = [JSON.stringify({}), ...Array.from({ length: 8 },
      (_, i) => JSON.stringify(`Block ${i} ${'w'.repeat(500)}`))];
    const req = Object.assign(
      Readable.from(lines.map(l => `${l}\n`)),
      { params: { id: 'd1' }, query: {}, user: STAFF, is: (type) => type === 'application/x-ndjson' }
    );

    const res = mockRes();
    const written = await rowsFrom(() => documentController.ingestChunks(req, res));

    assert.strictEqual(res.body.streamed, true);
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].Action, 'document.ingest');
    assert.strictEqual(written[0].Detail.streamed, true);
    assert.strictEqual(written[0].Detail.chunks, res.body.chunks);
  });

  await t.test('a reported extraction failure writes one row, marked failure', async () => {
    // Answers 200 and marks the document extracted with zero chunks, so it is a successful
    // authenticated update however the extraction went — the row is what attributes a document
    // that looks processed and has no text.
    t.mock.method(documents, 'getById', async () => ({
      id: 'd2', projectId: '207', read: ['staff', 'sysadmin'], isPublished: false
    }));
    t.mock.method(documents, 'patchExtraction', async () => ({}));

    const res = mockRes();
    const written = await rowsFrom(() => documentController.ingestChunks({
      params: { id: 'd2' }, query: {}, body: { error: 'docling timed out' }, user: STAFF
    }, res));

    assert.strictEqual(res.body.recordedError, true);
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].Action, 'document.ingest');
    assert.strictEqual(written[0].Outcome, 'failure');
    assert.strictEqual(written[0].Detail.chunks, 0);
    assert.strictEqual(written[0].Detail.recordedError, true);
  });

  await t.test('boundary create writes one boundary.create', async () => {
    t.mock.method(boundaries, 'upsert', async (item) => item);

    const res = mockRes();
    const written = await rowsFrom(() => boundaryController.createBoundary({
      body: { type: 'region', name: 'Skeena' }, query: {}, params: {}, user: STAFF
    }, res));

    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].Action, 'boundary.create');
    assert.strictEqual(written[0].TargetId, 'region_Skeena');
    assert.strictEqual(written[0].Detail.type, 'region');
    // Boundaries have no parent project; the column stays empty rather than borrowing an id.
    assert.strictEqual(written[0].ProjectId, '');
  });

  await t.test('boundary update records the publish transition', async () => {
    // The edit anyone reads this table to find: read[] derives from isPublished, so flipping it
    // is a visibility change, in the same class as document.publish.
    t.mock.method(boundaries, 'getById', async () => ({
      id: 'region_Skeena', type: 'region', name: 'Skeena', isPublished: true,
      read: ['public', 'staff', 'sysadmin']
    }));
    t.mock.method(boundaries, 'upsert', async (item) => item);

    const written = await rowsFrom(() => boundaryController.updateBoundary({
      params: { id: 'region_Skeena' }, query: {},
      body: { name: 'Skeena Region', isPublished: false }, user: STAFF
    }, mockRes()));

    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].Action, 'boundary.update');
    assert.strictEqual(written[0].TargetId, 'region_Skeena');
    assert.strictEqual(written[0].Detail.isPublishedFrom, true);
    assert.strictEqual(written[0].Detail.isPublishedTo, false);
    assert.deepStrictEqual(written[0].Detail.changed, ['name'],
      'the partition key and read[] are stripped from the body, so they cannot appear as changes');
  });

  await t.test('boundary delete writes one boundary.delete', async () => {
    t.mock.method(boundaries, 'getById', async () => ({
      id: 'region_Skeena', type: 'region', name: 'Skeena', isPublished: true
    }));
    t.mock.method(boundaries, 'deleteById', async () => ({}));

    const written = await rowsFrom(() => boundaryController.deleteBoundary({
      params: { id: 'region_Skeena' }, query: {}, user: STAFF
    }, mockRes()));

    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].Action, 'boundary.delete');
    assert.strictEqual(written[0].TargetId, 'region_Skeena');
    assert.strictEqual(written[0].Detail.name, 'Skeena');
  });

  await t.test('a failed mutation writes no row at all', async () => {
    // Every call site sits after the mutation succeeded and before the success response, which is
    // what makes "row exists" mean "it happened". A 404 that still wrote a row would break that.
    t.mock.method(boundaries, 'getById', async () => null);

    const res = mockRes();
    const written = await rowsFrom(() => boundaryController.deleteBoundary({
      params: { id: 'region_Nowhere' }, query: {}, user: STAFF
    }, res));

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(written.length, 0);
  });
});
