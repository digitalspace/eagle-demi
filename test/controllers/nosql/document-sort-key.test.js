'use strict';

// Documents have no write choke point: a site that forgets `displayNameSort` silently sorts the
// row first under `sortBy=displayName`. The seed site is in test/seed/transform.test.js.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const documents = require('../../../src/repositories/documents');
const projects = require('../../../src/repositories/projects');
const documentController = require('../../../src/controllers/nosql/document');
const sealedController = require('../../../src/controllers/nosql/sealed');
const { naturalSortKey } = require('../../../src/helpers/natural-sort');
const { mockRes } = require('../../helpers/mock-res');

const PARENT = { id: '207', read: ['public', 'staff'], isPublished: true, region: 'skeena' };

test('every document write site stamps the natural-sort key', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

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

// The PDF title worker treats a Mongo ObjectId `id` as proof Eagle set the row's key
// (helpers/pdf-title.js `isFromEagle`), so no caller-reachable create may take one. Intake's
// case is in test/controllers/native/intake.test.js.
test('createSealed ignores an id in the body', async (t) => {
  t.mock.method(projects, 'getById', async () => PARENT);
  let saved;
  t.mock.method(documents, 'upsert', async (doc) => { saved = doc; return doc; });

  await sealedController.createSealed({
    params: {}, query: {},
    body: { id: '5f1d7a3c9b2e4d6f8a0b1c2d', project: '207', displayName: 'a.pdf', s3Key: '207/a.pdf' }
  }, mockRes());

  assert.match(saved.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
