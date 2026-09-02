'use strict';

/**
 * `displayNameSort` at the three controller write sites. The seed's own site is covered by
 * test/seed/transform.test.js, and it is the one that also serves eagle-api's push.
 *
 * Documents have no write choke point, so a site that forgets the key writes a row the indexer then
 * carries with a NULL sort field — which orders it before every named row under
 * `sortBy=displayName` and says nothing anywhere.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const documents = require('../../../src/repositories/documents');
const projects = require('../../../src/repositories/projects');
const storage = require('../../../src/storage');
const documentController = require('../../../src/controllers/nosql/document');
const { naturalSortKey } = require('../../../src/helpers/natural-sort');

const PARENT = { id: '207', read: ['public', 'staff'], isPublished: true, region: 'skeena' };

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    setHeader() {}
  };
}

test('every document write site stamps the natural-sort key', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('createDocument derives it from the display name', async () => {
    t.mock.method(projects, 'getById', async () => PARENT);
    let saved;
    t.mock.method(documents, 'upsert', async (doc) => { saved = doc; return doc; });

    await documentController.createDocument({
      query: {}, body: { project: '207', displayName: 'Appendix 2', s3Key: 'k.pdf' }
    }, mockRes());

    assert.strictEqual(saved.displayNameSort, 'appendix 000000000002');
  });

  await t.test('extractDocument derives it from the name the upload lands under', async () => {
    // No `displayName` in the body, so the row is named after the file — and the sort key has to
    // follow that fallback rather than the missing field.
    t.mock.method(projects, 'getById', async () => PARENT);
    t.mock.method(storage, 'putFile', async () => {});
    t.mock.method(fs.promises, 'unlink', async () => {});
    let saved;
    t.mock.method(documents, 'upsert', async (doc) => { saved = doc; return doc; });

    await documentController.extractDocument({
      query: {}, params: {}, body: { project: '207' },
      file: { path: '/tmp/up1', originalname: 'Appendix 10.pdf', mimetype: 'application/pdf' }
    }, mockRes());

    assert.strictEqual(saved.displayName, 'Appendix 10.pdf');
    assert.strictEqual(saved.displayNameSort, naturalSortKey('Appendix 10.pdf'));
    assert.ok(naturalSortKey('Appendix 2.pdf') < saved.displayNameSort, '2 pages before 10');
  });

  await t.test('updateDocument recomputes it on a rename', async () => {
    const stored = {
      id: 'd1', projectId: '207', displayName: 'Appendix 2',
      displayNameSort: naturalSortKey('Appendix 2'), read: ['public'], isPublished: true
    };
    t.mock.method(documents, 'getById', async () => structuredClone(stored));
    let saved;
    t.mock.method(documents, 'upsert', async (doc) => { saved = doc; return doc; });

    await documentController.updateDocument({
      params: { id: 'd1' }, query: {}, body: { displayName: 'Appendix 10' }
    }, mockRes());

    assert.strictEqual(saved.displayName, 'Appendix 10');
    assert.strictEqual(saved.displayNameSort, 'appendix 000000000010',
      'a stale sort key would order the row under its old name');
  });

  await t.test('updateDocument fills the key in on a row that predates it', async () => {
    // The backfill is the bulk path; an edit is the incidental one. Neither may leave the key
    // derived from anything but the name the row ends up with.
    const legacy = {
      id: 'd1', projectId: '207', displayName: 'Appendix 2', read: ['public'], isPublished: true
    };
    t.mock.method(documents, 'getById', async () => structuredClone(legacy));
    let saved;
    t.mock.method(documents, 'upsert', async (doc) => { saved = doc; return doc; });

    await documentController.updateDocument({
      params: { id: 'd1' }, query: {}, body: { description: 'unrelated edit' }
    }, mockRes());

    assert.strictEqual(saved.displayNameSort, 'appendix 000000000002');
  });
});
