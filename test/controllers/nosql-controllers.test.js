'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const projects = require('../../src/repositories/projects');
const documents = require('../../src/repositories/documents');
const aiSearch = require('../../src/search/ai-search');
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
    t.mock.method(aiSearch, 'deleteFromIndex', async () => 1);
    t.mock.method(aiSearch, 'deleteChunksForDocument', async () => 0);
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
    assert.strictEqual(res.body.removedFromSearch, 1);
  });

  await t.test('a failed index removal does not fail the delete', async () => {
    // The record is already gone from Cosmos. Throwing here would leave the caller unable to tell
    // what happened — and with no nightly full sync left to reconcile it, the response is now the
    // ONLY signal that the row is still searchable.
    t.mock.method(aiSearch, 'deleteFromIndex', async () => 0);
    t.mock.method(aiSearch, 'deleteChunksForDocument', async () => 0);
    t.mock.method(documents, 'getById', async () => ({ id: 'd1', projectId: '207' }));
    t.mock.method(documents, 'deleteById', async () => true);

    const res = mockRes();
    await documentController.deleteDocument({ params: { id: 'd1' }, query: {} }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.removedFromSearch, 0);
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

test('the router mounts one data layer, unconditionally', async (t) => {
  const load = (env = {}) => {
    const key = require.resolve('../../src/routes/api');
    delete require.cache[key];
    const prev = { ...process.env };
    Object.assign(process.env, env);
    try {
      const router = require('../../src/routes/api');
      return router.stack.filter(l => l.route).map(l => l.route.path).sort();
    } finally {
      for (const k of Object.keys(env)) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
      delete require.cache[key];
    }
  };

  await t.test('no environment variable can change the route table', () => {
    // USE_COSMOS_NOSQL was the rollback switch between the Mongo-API and NoSQL controllers.
    // Both it and the layer it fell back to are gone; a stale value left on the deployed app
    // must not resurrect a branch. Asserting the table is IDENTICAL either way is the check —
    // a flag that silently changed which controller answers is how the wrong data layer got
    // activated against an account that did not speak its query language.
    const withFlag = load({ USE_COSMOS_NOSQL: 'true' });
    const withoutFlag = load({ USE_COSMOS_NOSQL: 'false' });

    assert.deepStrictEqual(withFlag, withoutFlag);
  });

  await t.test('publish/unpublish and chunk ingest are always mounted', () => {
    // Both used to be conditional, purely because the Mongo controller had no such handler.
    // Mounting them behind a truthiness check on the controller export means a rename would
    // silently drop the route instead of failing.
    const paths = load();
    assert.ok(paths.includes('/documents/:id/published'));
    assert.ok(paths.includes('/documents/:id/chunks'));
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

  // Provenance exists because the extraction host ROUTES: a text-layer probe keeps digital PDFs on
  // a CPU path and only text-poor ones reach OCR. Without recording which, a text-layer artefact
  // and an OCR error are indistinguishable afterwards, and no claim about OCR quality can be
  // evidenced or disproved.
  await t.test('extraction provenance round-trips onto the document when supplied', async () => {
    stubDoc(t);
    let patched = null;
    t.mock.method(documents, 'patchExtraction', async (id, projectId, fields) => {
      patched = fields; return {};
    });
    t.mock.method(chunksRepo, 'replaceForDocument', async () => ({ succeeded: 1 }));

    await documentController.ingestChunks({
      params: { id: 'd1' },
      query: {},
      body: {
        markdown: 'z'.repeat(200),
        extraction: {
          path: 'ocr',
          engine: 'rapidocr',
          doclingVersion: '2.55.0',
          options: { force_ocr: false, images_scale: 2 },
          at: '2026-07-31T21:00:00.000Z'
        }
      },
      user: ADMIN_USER
    }, mockRes());

    assert.strictEqual(patched.extraction.path, 'ocr');
    assert.strictEqual(patched.extraction.engine, 'rapidocr');
    assert.strictEqual(patched.extraction.doclingVersion, '2.55.0');
    assert.strictEqual(patched.extraction.at, '2026-07-31T21:00:00.000Z');
    assert.ok(patched.extraction.options.includes('force_ocr'));
    // cosmos.patch throws a RangeError above ten operations.
    assert.ok(Object.keys(patched).length <= 10);
  });

  // Absent provenance must stay ABSENT rather than becoming an empty object: "no field" is the
  // honest signal for the ~80k rows written before this existed, and an empty object would read
  // as "provenance recorded, path unknown", which is a different and false statement.
  await t.test('the field is omitted entirely when the host sends nothing', async () => {
    stubDoc(t);
    let patched = null;
    t.mock.method(documents, 'patchExtraction', async (id, projectId, fields) => {
      patched = fields; return {};
    });
    t.mock.method(chunksRepo, 'replaceForDocument', async () => ({ succeeded: 1 }));

    await documentController.ingestChunks(
      { params: { id: 'd1' }, query: {}, body: { markdown: 'z'.repeat(200) }, user: ADMIN_USER },
      mockRes()
    );

    assert.ok(!('extraction' in patched), 'no provenance means no field');
  });

  // The extraction host is a separate externally-run process, and this object is written verbatim
  // onto a document the API then serves — the same distrust the ACL gets.
  await t.test('provenance from the host is whitelisted and bounded', async () => {
    stubDoc(t);
    let patched = null;
    t.mock.method(documents, 'patchExtraction', async (id, projectId, fields) => {
      patched = fields; return {};
    });
    t.mock.method(chunksRepo, 'replaceForDocument', async () => ({ succeeded: 1 }));

    await documentController.ingestChunks({
      params: { id: 'd1' },
      query: {},
      body: {
        markdown: 'z'.repeat(200),
        extraction: {
          path: 'something-else',
          engine: 'e'.repeat(5000),
          options: { blob: 'x'.repeat(5000) },
          injected: 'must not survive'
        }
      },
      user: ADMIN_USER
    }, mockRes());

    // An unrecognised path is recorded as 'unknown', not dropped: knowing the host claimed
    // something we do not understand beats silently recording nothing.
    assert.strictEqual(patched.extraction.path, 'unknown');
    assert.strictEqual(patched.extraction.engine.length, 60);
    assert.ok(patched.extraction.options.length <= 500);
    assert.ok(!('injected' in patched.extraction), 'unknown keys must not be persisted');
    // Cosmos bills by document size, so an unbounded field is paid for on every read.
    assert.ok(JSON.stringify(patched.extraction).length < 800);
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
