'use strict';

/**
 * The Eagle mirror routes — `PUT /eagle/projects/:eagleId` and `PUT /eagle/documents/:eagleId`.
 *
 * eagle-api pushes fire-and-forget on every write it makes, so these handlers are the only thing
 * standing between a raw upstream record and the registry. What they are asserted on is what a
 * push must NOT destroy: the enrichment blocks under `sources`, a document's extraction state, and
 * the parent project's ceiling on a document's ACL. Each of those is silent when it breaks — the
 * push still returns 200 — which is why they are tested here rather than left to the merge suite.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const projects = require('../../../src/repositories/projects');
const documents = require('../../../src/repositories/documents');
const aiSearch = require('../../../src/search/ai-search');
const projectController = require('../../../src/controllers/nosql/project');
const documentController = require('../../../src/controllers/nosql/document');
const authMiddleware = require('../../../src/middleware/auth');
const { requireWrite } = require('../../../src/middleware/require-roles');
const { routeChains } = require('../../helpers/router-source');

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    setHeader() {}
  };
}

const STAFF = { sub: 'kc-sub-1', preferred_username: 'push', realm_access: { roles: ['sysadmin'] } };

const PROJECT_EAGLE_ID = '588511d0aaecd9001b825604';
const DOC_EAGLE_ID = '58869abba4acd4014b81f55c';

/** An Eagle project in the FLAT shape the public search endpoint returns. */
function eagleProject(overrides = {}) {
  return {
    _id: PROJECT_EAGLE_ID,
    name: 'Nicomen Wind Energy',
    description: 'A wind farm near Nicomen',
    status: 'Under Construction',
    read: ['public', 'sysadmin', 'staff'],
    centroid: [-120.4, 50.6],
    ...overrides
  };
}

/**
 * The same project as eagle-api's Mongo actually stores it: content nested under the legislation
 * block, with STALE top-level copies of `name` and `region` beside it. This is what the push
 * sends — the flattening the search endpoint does is not in the push path.
 */
function rawMongoProject(blockOverrides = {}, topOverrides = {}) {
  const { _id, read, ...content } = eagleProject();
  return {
    _id,
    read,
    _schemaName: 'Project',
    currentLegislationYear: 'legislation_2018',
    legislationYearList: [2018],
    name: 'STALE TOP-LEVEL NAME',
    region: '',
    projectCAC: true,
    cacEmail: 'cac@example.gov.bc.ca',
    legislation_2018: { ...content, region: 'Thompson-Nicola', sector: 'Energy-Electricity', ...blockOverrides },
    ...topOverrides
  };
}

/** A raw Eagle document, as eagle-api stores it. */
function eagleDocument(overrides = {}) {
  return {
    _id: DOC_EAGLE_ID,
    project: PROJECT_EAGLE_ID,
    displayName: 'Application',
    documentFileName: 'application.pdf',
    internalURL: 'docs/application.pdf',
    internalExt: '.pdf',
    type: '5cf00c03a266b7e1877504db',
    milestone: '5cf00c03a266b7e1877504ef',
    read: ['public', 'sysadmin'],
    ...overrides
  };
}

/** A project already in Cosmos: matched to Track, enriched by the wildfire sync. */
function storedProject(overrides = {}) {
  return {
    id: '207',
    eagleId: PROJECT_EAGLE_ID,
    trackProjectId: 207,
    isPublished: true,
    read: ['public', 'sysadmin', 'staff'],
    sources: {
      track: { track_project_id: 207, name: 'Nicomen Wind Energy', epic_guid: PROJECT_EAGLE_ID },
      eagle: { _id: PROJECT_EAGLE_ID, name: 'Nicomen Wind Energy' },
      wildfire: {
        activeCountWithin50km: 2,
        nearestDistanceKm: 12.4,
        firesOfNoteNearby: 1,
        lastCalculatedAt: '2026-08-23T00:00:00.000Z'
      }
    },
    ...overrides
  };
}

test('PUT /eagle/projects/:eagleId', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('every other source block survives the push', async () => {
    // The trap the seed hit: a Cosmos upsert replaces the item and the merge rebuilds only
    // track/eagle, so anything else under `sources` is gone unless it is carried across. Nothing
    // can rebuild the wildfire aggregate — the sync is on demand and the feed is not historical.
    const existing = storedProject();
    t.mock.method(projects, 'getByEagleId', async () => existing);
    let written;
    t.mock.method(projects, 'upsert', async (item) => { written = item; return item; });

    const res = mockRes();
    await projectController.upsertFromEagle({
      params: { eagleId: PROJECT_EAGLE_ID }, query: {},
      body: { doc: eagleProject({ name: 'Nicomen Wind Energy Project' }) }, user: STAFF
    }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { id: '207', action: 'upsert' });
    assert.deepStrictEqual(written.sources.wildfire, existing.sources.wildfire,
      'the wildfire aggregate is not rebuildable and must survive a push');
    assert.strictEqual(written.sources.eagle.name, 'Nicomen Wind Energy Project',
      'the pushed record replaces the stored Eagle payload');
    assert.strictEqual(written.sources.track, existing.sources.track,
      'the Track payload is untouched by an Eagle push');
    // Identity comes from the merge: the Track id when matched, never the Eagle one.
    assert.strictEqual(written.id, '207');
    assert.strictEqual(written.name, 'Nicomen Wind Energy',
      'Track keeps precedence over the pushed name');
  });

  await t.test('an unmatched project is keyed eagle-<eagleId>', async () => {
    t.mock.method(projects, 'getByEagleId', async () => null);
    let written;
    t.mock.method(projects, 'upsert', async (item) => { written = item; return item; });

    const res = mockRes();
    await projectController.upsertFromEagle({
      params: { eagleId: PROJECT_EAGLE_ID }, query: {},
      body: { doc: eagleProject() }, user: STAFF
    }, res);

    assert.strictEqual(res.body.id, `eagle-${PROJECT_EAGLE_ID}`);
    assert.strictEqual(written.sourceSystem, 'eagle');
    assert.strictEqual(written.isPublished, true, 'derived from the pushed read[]');
  });

  await t.test('a visibility flip cascades onto the documents; a rename does not', async () => {
    const existing = storedProject();
    t.mock.method(projects, 'getByEagleId', async () => existing);
    t.mock.method(projects, 'upsert', async (item) => item);
    const indexWrites = [];
    t.mock.method(aiSearch, 'writeAcls', async (index, rows) => {
      indexWrites.push({ index, rows }); return rows.length;
    });
    const cascaded = [];
    t.mock.method(documents, 'setAclForProject', async (_access, projectId, read) => {
      cascaded.push({ projectId, read });
      return { succeeded: 1, failed: 0, rows: [{ id: DOC_EAGLE_ID, read, isPublished: false }] };
    });

    // Unpublished upstream: the pushed record no longer carries `public`.
    const res = mockRes();
    await projectController.upsertFromEagle({
      params: { eagleId: PROJECT_EAGLE_ID }, query: {},
      body: { doc: eagleProject({ read: ['sysadmin', 'staff'] }) }, user: STAFF
    }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(cascaded.length, 1, 'the document ACL cascade ran');
    assert.deepStrictEqual(cascaded[0], { projectId: '207', read: ['sysadmin', 'staff'] });
    assert.strictEqual(indexWrites.length, 2, 'the project row, then the documents that landed');
    assert.deepStrictEqual(indexWrites[0].rows,
      [{ id: '207', read: ['sysadmin', 'staff'], isPublished: false }]);

    // A rename at the same visibility touches neither.
    cascaded.length = 0;
    indexWrites.length = 0;
    await projectController.upsertFromEagle({
      params: { eagleId: PROJECT_EAGLE_ID }, query: {},
      body: { doc: eagleProject({ name: 'Renamed' }) }, user: STAFF
    }, mockRes());

    assert.strictEqual(cascaded.length, 0, 'a rename is not a visibility change');
    assert.strictEqual(indexWrites.length, 0);
  });

  await t.test('a partially failed cascade 500s and still indexes the rows that landed', async () => {
    t.mock.method(projects, 'getByEagleId', async () => storedProject());
    t.mock.method(projects, 'upsert', async (item) => item);
    const indexWrites = [];
    t.mock.method(aiSearch, 'writeAcls', async (index, rows) => {
      indexWrites.push({ index, rows }); return rows.length;
    });
    t.mock.method(documents, 'setAclForProject', async () => ({
      succeeded: 1, failed: 1, failedIds: ['d2'],
      rows: [{ id: 'd1', read: ['sysadmin'], isPublished: false }, { id: 'd2', read: ['sysadmin'], isPublished: false }]
    }));

    const res = mockRes();
    await projectController.upsertFromEagle({
      params: { eagleId: PROJECT_EAGLE_ID }, query: {},
      body: { doc: eagleProject({ read: ['sysadmin', 'staff'] }) }, user: STAFF
    }, res);

    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(indexWrites[1].rows, [{ id: 'd1', read: ['sysadmin'], isPublished: false }],
      'only the rows Cosmos accepted reach the index');
  });

  // The live defect, 2026-08-25: the push carries the RAW Mongo doc, whose content sits under
  // `legislation_2018`, so `eagle-6a5920eaf0b65c54e12eb20a` landed on test with no name at all.
  await t.test('the raw Mongo legislation block is flattened onto the row', async () => {
    t.mock.method(projects, 'getByEagleId', async () => null);
    let written;
    t.mock.method(projects, 'upsert', async (item) => { written = item; return item; });

    const res = mockRes();
    await projectController.upsertFromEagle({
      params: { eagleId: PROJECT_EAGLE_ID }, query: {},
      body: { doc: rawMongoProject() }, user: STAFF
    }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(written.name, 'Nicomen Wind Energy');
    assert.strictEqual(written.description, 'A wind farm near Nicomen');
    assert.strictEqual(written.projectState, 'Under Construction');
    assert.strictEqual(written.sourceSystem, 'eagle');
    assert.strictEqual(written.id, `eagle-${PROJECT_EAGLE_ID}`);

    // Top-level-only fields are carried over the block, not lost with it.
    assert.deepStrictEqual(written.read, ['public', 'sysadmin', 'staff']);
    assert.strictEqual(written.isPublished, true);
    assert.strictEqual(written.cacEmail, 'cac@example.gov.bc.ca');
  });

  await t.test('a stale top-level copy does not shadow the legislation block', async () => {
    // `name` and `region` exist in both places on a real project and the top-level copy is the
    // stale one — so the block has to win, which rules out a plain `{...block, ...doc}`.
    t.mock.method(projects, 'getByEagleId', async () => null);
    let written;
    t.mock.method(projects, 'upsert', async (item) => { written = item; return item; });

    await projectController.upsertFromEagle({
      params: { eagleId: PROJECT_EAGLE_ID }, query: {},
      body: { doc: rawMongoProject() }, user: STAFF
    }, mockRes());

    assert.strictEqual(written.name, 'Nicomen Wind Energy');
    assert.strictEqual(written.region, 'Thompson-Nicola');
  });

  await t.test('an already-flat search-shaped doc is untouched', async () => {
    t.mock.method(projects, 'getByEagleId', async () => null);
    let written;
    t.mock.method(projects, 'upsert', async (item) => { written = item; return item; });

    await projectController.upsertFromEagle({
      params: { eagleId: PROJECT_EAGLE_ID }, query: {},
      body: { doc: eagleProject({ region: 'Thompson-Nicola' }) }, user: STAFF
    }, mockRes());

    assert.strictEqual(written.name, 'Nicomen Wind Energy');
    assert.strictEqual(written.region, 'Thompson-Nicola');
  });

  await t.test('a body whose doc._id disagrees with the path is a 400 and no write', async () => {
    t.mock.method(projects, 'getByEagleId', async () => { throw new Error('must not be read'); });
    let upserts = 0;
    t.mock.method(projects, 'upsert', async () => { upserts++; });

    for (const body of [{ doc: eagleProject({ _id: 'somethingelse' }) }, {}, { doc: null }]) {
      const res = mockRes();
      await projectController.upsertFromEagle({
        params: { eagleId: PROJECT_EAGLE_ID }, query: {}, body, user: STAFF
      }, res);
      assert.strictEqual(res.statusCode, 400);
    }
    assert.strictEqual(upserts, 0);
  });
});

test('PUT /eagle/documents/:eagleId', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('extraction state is carried off the stored row, never off the push', async () => {
    // A Cosmos upsert replaces the item, so losing these orphans the chunks and re-queues the
    // document through the GPU. Eagle's own `contentExtracted` is true on records with no chunks
    // behind them, which is why it is not a fallback.
    t.mock.method(projects, 'getByEagleId', async () => storedProject());
    t.mock.method(documents, 'getById', async () => ({
      id: DOC_EAGLE_ID, projectId: '207', isPublished: true, read: ['public', 'sysadmin'],
      contentExtracted: true, contentExtractedAt: '2026-08-01T00:00:00.000Z',
      contentPageCount: 42, contentExtractionError: null
    }));
    let written;
    t.mock.method(documents, 'upsert', async (item) => { written = item; return item; });

    const res = mockRes();
    await documentController.upsertFromEagle({
      params: { eagleId: DOC_EAGLE_ID }, query: {},
      body: { doc: eagleDocument({ contentExtracted: false }) }, user: STAFF
    }, res);

    assert.deepStrictEqual(res.body, { id: DOC_EAGLE_ID, projectId: '207', action: 'upsert' });
    assert.strictEqual(written.contentExtracted, true);
    assert.strictEqual(written.contentExtractedAt, '2026-08-01T00:00:00.000Z');
    assert.strictEqual(written.contentPageCount, 42);
  });

  await t.test('read[] is the document\'s own ACL intersected with its project\'s', async () => {
    t.mock.method(projects, 'getByEagleId', async () => storedProject({
      read: ['public', 'sysadmin', 'staff']
    }));
    t.mock.method(documents, 'getById', async () => null);
    let written;
    t.mock.method(documents, 'upsert', async (item) => { written = item; return item; });

    await documentController.upsertFromEagle({
      params: { eagleId: DOC_EAGLE_ID }, query: {},
      body: { doc: eagleDocument({ read: ['public', 'project-team'] }) }, user: STAFF
    }, mockRes());

    assert.deepStrictEqual(written.read, ['public'],
      'project-team is not on the project, so the document cannot carry it');
    assert.strictEqual(written.isPublished, true);

    // And the ceiling holds: a private project cannot host a public document.
    projects.getByEagleId.mock.mockImplementation(async () => storedProject({
      isPublished: false, read: ['sysadmin', 'staff']
    }));
    await documentController.upsertFromEagle({
      params: { eagleId: DOC_EAGLE_ID }, query: {},
      body: { doc: eagleDocument({ read: ['public', 'sysadmin'] }) }, user: STAFF
    }, mockRes());

    assert.deepStrictEqual(written.read, ['sysadmin']);
    assert.strictEqual(written.isPublished, false);
    assert.deepStrictEqual(written.ownRead, ['public', 'sysadmin'],
      'the unconstrained Eagle ACL is what the cascade restores from on re-publish');
  });

  await t.test('a document that moved project leaves no row in the old partition', async () => {
    t.mock.method(projects, 'getByEagleId', async () => storedProject({ id: 'NEWPROJ' }));
    t.mock.method(documents, 'getById', async () => ({
      id: DOC_EAGLE_ID, projectId: 'OLDPROJ', isPublished: true, read: ['public', 'sysadmin']
    }));
    t.mock.method(documents, 'upsert', async (item) => item);
    const deletes = [];
    t.mock.method(documents, 'deleteById', async (id, projectId) => {
      deletes.push([id, projectId]);
    });

    await documentController.upsertFromEagle({
      params: { eagleId: DOC_EAGLE_ID }, query: {},
      body: { doc: eagleDocument() }, user: STAFF
    }, mockRes());

    assert.deepStrictEqual(deletes, [[DOC_EAGLE_ID, 'OLDPROJ']],
      'the upsert landed in the new partition; the old row would keep the old ACL');

    // Same partition: nothing to clean up.
    deletes.length = 0;
    documents.getById.mock.mockImplementation(async () => ({
      id: DOC_EAGLE_ID, projectId: 'NEWPROJ', isPublished: true, read: ['public', 'sysadmin']
    }));
    await documentController.upsertFromEagle({
      params: { eagleId: DOC_EAGLE_ID }, query: {},
      body: { doc: eagleDocument() }, user: STAFF
    }, mockRes());

    assert.strictEqual(deletes.length, 0);
  });

  await t.test('the pushed labels resolve the List ObjectIds, and both are stored', async () => {
    t.mock.method(projects, 'getByEagleId', async () => storedProject());
    t.mock.method(documents, 'getById', async () => null);
    let written;
    t.mock.method(documents, 'upsert', async (item) => { written = item; return item; });

    await documentController.upsertFromEagle({
      params: { eagleId: DOC_EAGLE_ID }, query: {},
      body: {
        doc: eagleDocument(),
        labels: { type: 'Application', milestone: 'Application Review', projectPhase: 'Pre-EA' }
      },
      user: STAFF
    }, mockRes());

    assert.strictEqual(written.type, 'Application');
    assert.strictEqual(written.typeId, '5cf00c03a266b7e1877504db');
    assert.strictEqual(written.milestone, 'Application Review');
    // No label for a ref keeps the raw id rather than losing the reference.
    assert.strictEqual(written.documentAuthorType, null);
  });

  await t.test('a document with no parent project in DEMI is a 404 and no write', async () => {
    t.mock.method(projects, 'getByEagleId', async () => null);
    let upserts = 0;
    t.mock.method(documents, 'upsert', async () => { upserts++; });

    const res = mockRes();
    await documentController.upsertFromEagle({
      params: { eagleId: DOC_EAGLE_ID }, query: {},
      body: { doc: eagleDocument() }, user: STAFF
    }, res);

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(upserts, 0, 'never seed an orphan document');
  });

  await t.test('a visibility flip writes the index ACL; a rename does not', async () => {
    t.mock.method(projects, 'getByEagleId', async () => storedProject());
    t.mock.method(documents, 'getById', async () => ({
      id: DOC_EAGLE_ID, projectId: '207', isPublished: true, read: ['public', 'sysadmin']
    }));
    t.mock.method(documents, 'upsert', async (item) => item);
    const indexWrites = [];
    t.mock.method(aiSearch, 'writeAcls', async (index, rows) => {
      indexWrites.push(rows); return rows.length;
    });

    await documentController.upsertFromEagle({
      params: { eagleId: DOC_EAGLE_ID }, query: {},
      body: { doc: eagleDocument({ read: ['sysadmin'] }) }, user: STAFF
    }, mockRes());

    assert.strictEqual(indexWrites.length, 1);
    assert.deepStrictEqual(indexWrites[0],
      [{ id: DOC_EAGLE_ID, read: ['sysadmin'], isPublished: false }]);

    indexWrites.length = 0;
    await documentController.upsertFromEagle({
      params: { eagleId: DOC_EAGLE_ID }, query: {},
      body: { doc: eagleDocument({ displayName: 'Application (revised)' }) }, user: STAFF
    }, mockRes());

    assert.strictEqual(indexWrites.length, 0, 'a metadata edit does not move the ACL');
  });

  await t.test('a body whose doc._id disagrees with the path is a 400 and no write', async () => {
    t.mock.method(projects, 'getByEagleId', async () => { throw new Error('must not be read'); });
    let upserts = 0;
    t.mock.method(documents, 'upsert', async () => { upserts++; });

    const res = mockRes();
    await documentController.upsertFromEagle({
      params: { eagleId: DOC_EAGLE_ID }, query: {},
      body: { doc: eagleDocument({ _id: 'somethingelse' }) }, user: STAFF
    }, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(upserts, 0);
  });
});

test('the mirror routes are behind authMiddleware + requireWrite', async (t) => {
  // The handlers read and write through systemAccess(), so no ACL predicate protects them — the
  // route chain is the whole gate. access-coverage.test.js asserts the chain from the router
  // source; this runs the two middlewares to prove what the chain buys.
  await t.test('both routes declare the chain', () => {
    const mirror = routeChains().filter(r => r.path.startsWith('/eagle/'));
    assert.strictEqual(mirror.length, 2);
    for (const r of mirror) {
      assert.match(r.chain, /\bauthMiddleware\b/);
      assert.match(r.chain, /\brequireWrite\b/);
    }
  });

  await t.test('an unauthenticated push is 401', () => {
    const res = mockRes();
    let nexted = false;
    authMiddleware({ header: () => undefined }, res, () => { nexted = true; });
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(nexted, false);
  });

  await t.test('a read-only credential is 403', () => {
    const res = mockRes();
    let nexted = false;
    requireWrite(
      { user: { preferred_username: 'demi-service-read', realm_access: { roles: ['public'] } } },
      res, () => { nexted = true; }
    );
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(nexted, false);
  });
});
