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

test('chunk ingest — NDJSON streaming path', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const { Readable } = require('node:stream');
  const { chunkMarkdown } = require('../../src/chunker');
  const DOC = { id: 'd1', projectId: '207', read: ['staff', 'sysadmin'], isPublished: false };

  // A real Readable, not a fake: the handler drives it with readline, and a stub that merely
  // exposes the lines would not exercise the streaming at all — which is the entire feature.
  const streamReq = (lines) => Object.assign(
    Readable.from(lines.map(l => `${l}\n`)),
    { params: { id: 'd1' }, query: {}, user: ADMIN_USER, is: (t2) => t2 === 'application/x-ndjson' }
  );

  const ndjson = (blocks, meta = {}) =>
    [JSON.stringify(meta), ...blocks.map(b => JSON.stringify(b))];

  function stubDoc(t2, doc = DOC) {
    t2.mock.method(documents, 'getById', async () => doc);
    t2.mock.method(documents, 'patchExtraction', async () => ({}));
  }

  await t.test('streamed chunks match the JSON path exactly, block for block', async () => {
    // Two doors into one corpus. If they disagree, a document's chunk boundaries depend on how big
    // it happened to be, and re-ingesting through the other door rewrites every id.
    stubDoc(t);
    const blocks = Array.from({ length: 12 }, (_, i) => `Block ${i} ${'z'.repeat(400)}`);
    const written = [];
    t.mock.method(chunksRepo, 'upsertBatch', async (a, id, items) => {
      written.push(...items); return { succeeded: items.length, failed: 0, statusCounts: {} };
    });
    t.mock.method(chunksRepo, 'deleteSurplus', async () => ({ succeeded: 0, failed: 0 }));

    await documentController.ingestChunks(streamReq(ndjson(blocks)), mockRes());

    const viaJson = chunkMarkdown(blocks.join('\n\n'));
    assert.deepStrictEqual(
      written.map(c => ({ pageNumber: c.pageNumber, chunkIndex: c.chunkIndex, content: c.content })),
      viaJson,
      'the streaming path produced different chunks from chunkMarkdown'
    );
  });

  await t.test('flushes in batches instead of buffering the whole document', async () => {
    // The reason this feature exists. If it accumulated everything and wrote once, a 63 MB
    // document would still be held whole in memory and nothing would have been fixed.
    stubDoc(t);
    const blocks = Array.from({ length: 900 }, (_, i) => `Para ${i} ${'q'.repeat(2600)}`);
    const batchSizes = [];
    t.mock.method(chunksRepo, 'upsertBatch', async (a, id, items) => {
      batchSizes.push(items.length); return { succeeded: items.length, failed: 0, statusCounts: {} };
    });
    t.mock.method(chunksRepo, 'deleteSurplus', async () => ({ succeeded: 0, failed: 0 }));

    await documentController.ingestChunks(streamReq(ndjson(blocks)), mockRes());

    assert.ok(batchSizes.length > 1, `expected several batches, got ${batchSizes.length}`);
    for (const n of batchSizes) {
      assert.ok(n <= 200, `a batch of ${n} exceeds the streaming batch bound`);
    }
  });

  await t.test('ONE huge block is still flushed in bounded batches', async () => {
    // The regression that killed the worker six times on 5cd1bf58f8f32d0024119fb9: that document
    // is 30 MB across 2,247 lines with only FIVE blank ones, so it splits into ~6 blocks of ~5 MB
    // and each one emits well over a thousand chunks in a single call. Checking the batch bound
    // between blocks made the bound follow BLOCK size, which is the one thing that cannot be
    // relied on. The test above uses 900 separate blocks and passed throughout — a single block
    // is what distinguishes the two.
    stubDoc(t);
    const batchSizes = [];
    t.mock.method(chunksRepo, 'upsertBatch', async (a, id, items) => {
      batchSizes.push(items.length); return { succeeded: items.length, failed: 0, statusCounts: {} };
    });
    t.mock.method(chunksRepo, 'deleteSurplus', async () => ({ succeeded: 0, failed: 0 }));

    // One block, no blank lines, big enough that splitText alone yields hundreds of chunks.
    const oneBlock = 'lorem ipsum dolor sit amet '.repeat(40000);
    await documentController.ingestChunks(streamReq(ndjson([oneBlock])), mockRes());

    assert.ok(batchSizes.length > 1,
      `a single huge block must still flush repeatedly, got ${batchSizes.length} batch(es)`);
    for (const n of batchSizes) {
      assert.ok(n <= 200, `a batch of ${n} from ONE block exceeds the streaming bound`);
    }
  });

  await t.test('the ACL still comes from the LIVE document', async () => {
    stubDoc(t);
    const written = [];
    t.mock.method(chunksRepo, 'upsertBatch', async (a, id, items) => {
      written.push(...items); return { succeeded: items.length, failed: 0, statusCounts: {} };
    });
    t.mock.method(chunksRepo, 'deleteSurplus', async () => ({ succeeded: 0, failed: 0 }));

    await documentController.ingestChunks(
      streamReq(ndjson(['x'.repeat(300)], { read: ['public'], extraction: { path: 'ocr' } })),
      mockRes()
    );

    assert.ok(written.length > 0);
    for (const c of written) assert.deepStrictEqual(c.read, ['staff', 'sysadmin']);
  });

  await t.test('a failed batch 500s, records the error, and never marks the document extracted',
    async () => {
      // bulkVerified REPORTS partial failure, it does not throw. Marking the document extracted
      // here would drop it from the work list with part of its text missing.
      stubDoc(t);
      const patches = [];
      t.mock.method(documents, 'patchExtraction', async (id, pid, fields) => {
        patches.push(fields); return {};
      });
      t.mock.method(chunksRepo, 'upsertBatch', async () =>
        ({ succeeded: 0, failed: 3, statusCounts: { 429: 3 } }));
      t.mock.method(chunksRepo, 'deleteSurplus', async () => ({ succeeded: 0, failed: 0 }));

      const res = mockRes();
      await documentController.ingestChunks(streamReq(ndjson(['a'.repeat(400)])), res);

      assert.strictEqual(res.statusCode, 500);
      assert.ok(patches.length > 0, 'the failure must be recorded on the document');
      for (const p of patches) {
        assert.ok(!p.contentExtracted, 'a partial write must never mark the document extracted');
        assert.ok(p.contentExtractionError, 'and must leave an error behind');
      }
    });

  await t.test('surplus chunks are deleted with the ids that survived', async () => {
    // AI Search never sees deletes, so an orphan left here stays searchable forever.
    stubDoc(t);
    let keep = null;
    t.mock.method(chunksRepo, 'upsertBatch', async (a, id, items) =>
      ({ succeeded: items.length, failed: 0, statusCounts: {} }));
    t.mock.method(chunksRepo, 'deleteSurplus', async (a, id, keepIds) => {
      keep = keepIds; return { succeeded: 0, failed: 0 };
    });

    const res = mockRes();
    await documentController.ingestChunks(
      streamReq(ndjson(Array.from({ length: 6 }, (_, i) => `B${i} ${'w'.repeat(900)}`))), res);

    assert.ok(Array.isArray(keep) && keep.length > 0);
    assert.strictEqual(keep.length, res.body.chunks, 'kept ids must equal the reported count');
    assert.deepStrictEqual(keep, [...new Set(keep)], 'chunk ids must be unique');
  });

  await t.test('a malformed line is a 400, not a half-written document', async () => {
    stubDoc(t);
    t.mock.method(chunksRepo, 'upsertBatch', async (a, id, items) =>
      ({ succeeded: items.length, failed: 0, statusCounts: {} }));
    t.mock.method(chunksRepo, 'deleteSurplus', async () => ({ succeeded: 0, failed: 0 }));

    for (const [lines, why] of [
      [['not json'], 'metadata line must be JSON'],
      [['{}', '{"not":"a string"}'], 'blocks must be JSON-encoded strings'],
      [[], 'an empty stream has no metadata line']
    ]) {
      const res = mockRes();
      await documentController.ingestChunks(streamReq(lines), res);
      assert.strictEqual(res.statusCode, 400, why);
    }
  });

  await t.test('provenance from line 1 is sanitised and recorded', async () => {
    stubDoc(t);
    let patched = null;
    t.mock.method(documents, 'patchExtraction', async (id, pid, fields) => {
      patched = fields; return {};
    });
    t.mock.method(chunksRepo, 'upsertBatch', async (a, id, items) =>
      ({ succeeded: items.length, failed: 0, statusCounts: {} }));
    t.mock.method(chunksRepo, 'deleteSurplus', async () => ({ succeeded: 0, failed: 0 }));

    await documentController.ingestChunks(
      streamReq(ndjson(['m'.repeat(300)], { extraction: { path: 'nonsense', engine: 'docling' } })),
      mockRes()
    );

    assert.strictEqual(patched.contentExtracted, true);
    assert.strictEqual(patched.contentExtractionError, null);
    assert.strictEqual(patched.extraction.path, 'unknown', 'an unknown path is recorded, not trusted');
  });
});
