'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const projects = require('../../src/repositories/projects');
const documents = require('../../src/repositories/documents');
const typesenseClient = require('../../src/typesense/typesenseClient');
const projectController = require('../../src/controllers/nosql/project');
const documentController = require('../../src/controllers/nosql/document');
const { TIER } = require('../../src/helpers/access-sql');

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    setHeader(k, v) { this.headers[k] = v; }
  };
  return res;
}

const ANON = { query: {}, params: {}, body: {} };
const ADMIN_USER = { realm_access: { roles: ['sysadmin'] } };

test('nosql project controller', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('anonymous list resolves the public tier and defaults to Track-only', async () => {
    let seenAccess, seenOpts;
    t.mock.method(projects, 'listVisible', async (access, opts) => {
      seenAccess = access; seenOpts = opts;
      return { items: [], continuationToken: undefined };
    });

    await projectController.getProjects({ ...ANON }, mockRes());

    assert.strictEqual(seenAccess.tier, TIER.PUBLIC);
    assert.strictEqual(seenOpts.trackOnly, true, 'NRPTI-seeded projects excluded by default');
  });

  await t.test('includeNrpti widens provenance but never visibility', async () => {
    let seenAccess, seenOpts;
    t.mock.method(projects, 'listVisible', async (access, opts) => {
      seenAccess = access; seenOpts = opts;
      return { items: [], continuationToken: undefined };
    });

    await projectController.getProjects({ query: { includeNrpti: 'true' } }, mockRes());

    assert.strictEqual(seenOpts.trackOnly, false);
    assert.strictEqual(seenAccess.tier, TIER.PUBLIC,
      'a query param must not change the caller access tier');
  });

  await t.test('a token promotes the tier; a header cannot', async () => {
    let seenAccess;
    t.mock.method(projects, 'listVisible', async (access) => {
      seenAccess = access;
      return { items: [], continuationToken: undefined };
    });

    await projectController.getProjects({ query: {}, user: ADMIN_USER }, mockRes());
    assert.strictEqual(seenAccess.tier, TIER.PRIVILEGED);

    await projectController.getProjects(
      { query: {}, header: () => 'sysadmin' }, mockRes()
    );
    assert.strictEqual(seenAccess.tier, TIER.PUBLIC);
  });

  await t.test('a hidden project reads as 404, not 403 — no existence disclosure', async () => {
    t.mock.method(projects, 'getById', async () => null);

    const res = mockRes();
    await projectController.getProject({ params: { id: '207' }, query: {} }, res);
    assert.strictEqual(res.statusCode, 404);
  });

  await t.test('update cannot reassign the partition key', async () => {
    t.mock.method(projects, 'getById', async () => ({
      id: '207', trackProjectId: 207, name: 'Original'
    }));
    let saved;
    t.mock.method(projects, 'upsert', async (doc) => { saved = doc; return doc; });

    await projectController.updateProject({
      params: { id: '207' },
      query: {},
      body: { id: '999', trackProjectId: 999, name: 'Renamed' }
    }, mockRes());

    // Changing a partition key in Cosmos is a delete-and-reinsert, not an update.
    assert.strictEqual(saved.id, '207');
    assert.strictEqual(saved.trackProjectId, 207);
    assert.strictEqual(saved.name, 'Renamed', 'non-key fields still update');
  });

  await t.test('create defaults closed', async () => {
    let saved;
    t.mock.method(projects, 'upsert', async (doc) => { saved = doc; return doc; });

    await projectController.createProject({
      body: { trackProjectId: 1, name: 'X', centroid: { coordinates: [0, 0] } }
    }, mockRes());

    assert.strictEqual(saved.isPublished, false);
    assert.ok(!saved.read.includes('public'), 'unpublished projects must not be public');
  });
});

test('nosql document controller — ACL cannot out-rank the parent project', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const { resolveDocumentAcl } = documentController;

  await t.test('private parent + requested public -> stays private', () => {
    const acl = resolveDocumentAcl({ read: ['sysadmin'], isPublished: false }, 'true');
    assert.strictEqual(acl.published, false);
    assert.ok(!acl.read.includes('public'));
  });

  await t.test('public parent + requested public -> public', () => {
    const acl = resolveDocumentAcl({ read: ['public', 'sysadmin'], isPublished: true }, 'true');
    assert.strictEqual(acl.published, true);
    assert.ok(acl.read.includes('public'));
  });

  await t.test('public parent, publish not requested -> stays private', () => {
    const acl = resolveDocumentAcl({ read: ['public'], isPublished: true }, undefined);
    assert.strictEqual(acl.published, false);
  });

  await t.test('delete removes the record but NEVER the stored file', async () => {
    t.mock.method(typesenseClient, 'deleteFromIndex', async () => true);
    t.mock.method(documents, 'getById', async () => ({
      id: 'd1', projectId: '207', s3Key: 'etl/thing.pdf'
    }));
    let deleted = false;
    t.mock.method(documents, 'deleteById', async () => { deleted = true; return true; });

    const res = mockRes();
    await documentController.deleteDocument({ params: { id: 'd1' }, query: {} }, res);

    assert.ok(deleted, 'the record is genuinely removed, not just flagged');
    assert.strictEqual(res.body.storedFileRetained, true,
      'no request path may destroy a source document — orphans are reaped by an audited job');
    assert.strictEqual(res.body.removedFromIndex, true);
  });

  await t.test('a failed index removal does not fail the delete', async () => {
    // The record is already gone from Cosmos, and the nightly full sync reconciles the index
    // via alias swap. Throwing here would leave the caller unable to tell what happened.
    t.mock.method(typesenseClient, 'deleteFromIndex', async () => false);
    t.mock.method(documents, 'getById', async () => ({ id: 'd1', projectId: '207' }));
    t.mock.method(documents, 'deleteById', async () => true);

    const res = mockRes();
    await documentController.deleteDocument({ params: { id: 'd1' }, query: {} }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.removedFromIndex, false);
  });

  await t.test('unpublish hides without deleting; read[] loses public', async () => {
    t.mock.method(documents, 'getById', async () => ({ id: 'd1', projectId: '207' }));
    t.mock.method(projects, 'getById', async () => ({ id: '207', read: ['public'], isPublished: true }));
    let args;
    t.mock.method(documents, 'setPublished', async (...a) => { args = a; return { id: 'd1' }; });
    t.mock.method(documents, 'deleteById', async () => {
      assert.fail('hiding a document must never delete it');
    });

    await documentController.setDocumentPublished(
      { params: { id: 'd1' }, query: {}, body: { isPublished: false } }, mockRes()
    );
    assert.strictEqual(args[2], false, 'published flag set to false');
  });

  await t.test('a document cannot be published under an unpublished project', async () => {
    t.mock.method(documents, 'getById', async () => ({ id: 'd1', projectId: '207' }));
    t.mock.method(projects, 'getById', async () => ({
      id: '207', read: ['sysadmin'], isPublished: false
    }));

    const res = mockRes();
    await documentController.setDocumentPublished(
      { params: { id: 'd1' }, query: {}, body: { isPublished: true } }, res
    );
    assert.strictEqual(res.statusCode, 409,
      'publishing under a private project would silently expose it');
  });
});

test('router selects the data layer from COSMOS_ENDPOINT', async (t) => {
  const load = (endpoint) => {
    const key = require.resolve('../../src/routes/api');
    delete require.cache[key];
    const prev = process.env.COSMOS_ENDPOINT;
    if (endpoint) process.env.COSMOS_ENDPOINT = endpoint;
    else delete process.env.COSMOS_ENDPOINT;

    const router = require('../../src/routes/api');
    const paths = router.stack.filter(l => l.route).map(l => `${l.route.path}`).sort();

    if (prev === undefined) delete process.env.COSMOS_ENDPOINT;
    else process.env.COSMOS_ENDPOINT = prev;
    delete require.cache[key];
    return paths;
  };

  await t.test('the NoSQL path never DROPS a route', () => {
    // The invariant that matters: switching the data layer must not silently remove an
    // endpoint clients depend on. Adding one is fine and expected.
    const legacy = load(null);
    const nosql = new Set(load('https://example.documents.azure.com:443/'));

    const missing = legacy.filter(p => !nosql.has(p));
    assert.deepStrictEqual(missing, [], 'these routes disappear under the NoSQL layer');
  });

  await t.test('publish/unpublish exists only on the NoSQL path, by design', () => {
    // Hiding a document is a publication change, not a deletion. The legacy Mongo controller
    // has no equivalent, so the route is added conditionally rather than 501-ing.
    assert.ok(load('https://example.documents.azure.com:443/').includes('/documents/:id/published'));
    assert.ok(!load(null).includes('/documents/:id/published'));
  });
});
