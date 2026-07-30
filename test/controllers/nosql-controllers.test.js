'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const projects = require('../../src/repositories/projects');
const documents = require('../../src/repositories/documents');
const typesenseClient = require('../../src/typesense/typesenseClient');
const projectController = require('../../src/controllers/nosql/project');
const documentController = require('../../src/controllers/nosql/document');
const chunksRepo = require('../../src/repositories/chunks');
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
  const load = (enabled) => {
    const key = require.resolve('../../src/routes/api');
    delete require.cache[key];
    const prev = process.env.USE_COSMOS_NOSQL;
    if (enabled) process.env.USE_COSMOS_NOSQL = 'true';
    else delete process.env.USE_COSMOS_NOSQL;

    const router = require('../../src/routes/api');
    const paths = router.stack.filter(l => l.route).map(l => `${l.route.path}`).sort();

    if (prev === undefined) delete process.env.USE_COSMOS_NOSQL;
    else process.env.USE_COSMOS_NOSQL = prev;
    delete require.cache[key];
    return paths;
  };

  await t.test('the switch is NOT inferred from COSMOS_ENDPOINT', () => {
    // COSMOS_ENDPOINT is already set on the deployed app and points at the MongoDB-API
    // account. Keying the data layer off it silently activated the NoSQL controllers against
    // an account that does not speak SQL. A mode switch must be explicit.
    const key = require.resolve('../../src/routes/api');
    const prevEndpoint = process.env.COSMOS_ENDPOINT;
    const prevFlag = process.env.USE_COSMOS_NOSQL;

    delete require.cache[key];
    process.env.COSMOS_ENDPOINT = 'https://anything.documents.azure.com:443/';
    delete process.env.USE_COSMOS_NOSQL;
    const router = require('../../src/routes/api');
    const paths = router.stack.filter(l => l.route).map(l => l.route.path);

    assert.ok(!paths.includes('/documents/:id/published'),
      'COSMOS_ENDPOINT alone must NOT activate the NoSQL layer');

    if (prevEndpoint === undefined) delete process.env.COSMOS_ENDPOINT;
    else process.env.COSMOS_ENDPOINT = prevEndpoint;
    if (prevFlag !== undefined) process.env.USE_COSMOS_NOSQL = prevFlag;
    delete require.cache[key];
  });

  await t.test('the NoSQL path never DROPS a route', () => {
    // The invariant that matters: switching the data layer must not silently remove an
    // endpoint clients depend on. Adding one is fine and expected.
    const legacy = load(false);
    const nosql = new Set(load(true));

    const missing = legacy.filter(p => !nosql.has(p));
    assert.deepStrictEqual(missing, [], 'these routes disappear under the NoSQL layer');
  });

  await t.test('publish/unpublish exists only on the NoSQL path, by design', () => {
    // Hiding a document is a publication change, not a deletion. The legacy Mongo controller
    // has no equivalent, so the route is added conditionally rather than 501-ing.
    assert.ok(load(true).includes('/documents/:id/published'));
    assert.ok(!load(false).includes('/documents/:id/published'));
  });
});

test('chunk ingest route', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const DOC = { id: 'd1', projectId: '207', read: ['staff', 'sysadmin'], isPublished: false };

  function stubDoc(t, doc = DOC) {
    t.mock.method(documents, 'getById', async () => doc);
    t.mock.method(documents, 'patchExtraction', async () => ({}));
  }

  await t.test('the ACL comes from the LIVE document, never from the request', async () => {
    // The whole reason this route takes a document id and markdown rather than chunk objects: a
    // compromised or buggy extraction host must not be able to widen a document's visibility.
    stubDoc(t);
    let written = null;
    t.mock.method(chunksRepo, 'replaceForDocument', async (access, id, items) => {
      written = items;
      return { succeeded: items.length, failed: 0, statusCounts: {} };
    });

    await documentController.ingestChunks(
      { params: { id: 'd1' }, query: {}, body: { markdown: 'x'.repeat(200), read: ['public'] },
        user: ADMIN_USER },
      mockRes()
    );

    assert.ok(written.length > 0);
    for (const chunk of written) {
      assert.deepStrictEqual(chunk.read, ['staff', 'sysadmin'],
        'a caller-supplied read[] must be ignored entirely');
      assert.ok(!chunk.read.includes('public'));
    }
  });

  await t.test('chunk ids are deterministic, so a re-post is idempotent', async () => {
    stubDoc(t);
    const runs = [];
    t.mock.method(chunksRepo, 'replaceForDocument', async (access, id, items) => {
      runs.push(items.map(i => i.id));
      return { succeeded: items.length, failed: 0, statusCounts: {} };
    });

    const req = () => ({
      params: { id: 'd1' }, query: {}, body: { markdown: 'y'.repeat(300) }, user: ADMIN_USER
    });
    await documentController.ingestChunks(req(), mockRes());
    await documentController.ingestChunks(req(), mockRes());

    assert.deepStrictEqual(runs[0], runs[1], 're-posting the same markdown yields the same ids');
  });

  await t.test('records the chunk count and clears the error on the document', async () => {
    stubDoc(t);
    let patched = null;
    t.mock.method(documents, 'patchExtraction', async (id, projectId, fields) => {
      patched = fields; return {};
    });
    t.mock.method(chunksRepo, 'replaceForDocument', async () => ({ succeeded: 1 }));

    const res = mockRes();
    await documentController.ingestChunks(
      { params: { id: 'd1' }, query: {}, body: { markdown: 'z'.repeat(200) }, user: ADMIN_USER },
      res
    );

    assert.strictEqual(patched.contentExtracted, true);
    assert.strictEqual(patched.contentExtractionError, null);
    assert.ok(patched.contentPageCount >= 1);
    // Five fields — cosmos.patch throws a RangeError above ten operations.
    assert.ok(Object.keys(patched).length <= 10);
    assert.strictEqual(res.body.chunks, patched.contentPageCount);
  });

  await t.test('a PARTIAL chunk write fails the request instead of claiming success', async () => {
    // bulkVerified reports partial failure, it does not throw. Trusting the call rather than its
    // report is how a sync once claimed 60,578 writes against 56,317 rows. Here it would mark a
    // document extracted with part of its text missing — and `extracted=false` would never offer
    // it again, so the gap would be permanent and invisible.
    stubDoc(t);
    const patches = [];
    t.mock.method(documents, 'patchExtraction', async (id, projectId, fields) => {
      patches.push(fields); return {};
    });
    t.mock.method(chunksRepo, 'replaceForDocument', async (access, id, items) =>
      ({ succeeded: items.length - 1, failed: 1, statusCounts: { 201: items.length - 1, 429: 1 } }));

    const res = mockRes();
    await documentController.ingestChunks(
      { params: { id: 'd1' }, query: {}, body: { markdown: 'q'.repeat(9000) }, user: ADMIN_USER },
      res
    );

    assert.strictEqual(res.statusCode, 500, 'a partial write must not return success');
    assert.ok(/incomplete/i.test(res.body.error));
    assert.ok(patches.length > 0 && patches[patches.length - 1].contentExtractionError,
      'the failure has to land on the document so it is findable later');
    assert.ok(!patches.some(p => p.contentExtracted === true),
      'a document with missing chunks must never be marked extracted');
  });

  await t.test('a reported extraction error is recorded, not swallowed', async () => {
    stubDoc(t);
    let patched = null;
    t.mock.method(documents, 'patchExtraction', async (id, projectId, fields) => {
      patched = fields; return {};
    });
    t.mock.method(chunksRepo, 'replaceForDocument', async () =>
      assert.fail('a failed extraction must not write chunks'));

    const res = mockRes();
    await documentController.ingestChunks(
      { params: { id: 'd1' }, query: {}, body: { error: 'docling timed out' }, user: ADMIN_USER },
      res
    );

    assert.strictEqual(patched.contentPageCount, 0);
    assert.match(patched.contentExtractionError, /docling timed out/);
    assert.strictEqual(res.body.recordedError, true);
  });

  await t.test('a document the caller cannot see is 404, and writes nothing', async () => {
    t.mock.method(documents, 'getById', async () => null);
    t.mock.method(chunksRepo, 'replaceForDocument', async () =>
      assert.fail('must not write chunks for an invisible document'));

    const res = mockRes();
    await documentController.ingestChunks(
      { params: { id: 'nope' }, query: {}, body: { markdown: 'x' }, user: ADMIN_USER }, res
    );
    assert.strictEqual(res.statusCode, 404);
  });

  await t.test('a missing markdown body is rejected rather than clearing the chunks', async () => {
    stubDoc(t);
    t.mock.method(chunksRepo, 'replaceForDocument', async () =>
      assert.fail('an empty body must not wipe a document\'s extracted text'));

    const res = mockRes();
    await documentController.ingestChunks(
      { params: { id: 'd1' }, query: {}, body: {}, user: ADMIN_USER }, res
    );
    assert.strictEqual(res.statusCode, 400);
  });
});
