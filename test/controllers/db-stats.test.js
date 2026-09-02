'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const dbController = require('../../src/controllers/db');
const projectsRepo = require('../../src/repositories/projects');
const documentsRepo = require('../../src/repositories/documents');
const boundariesRepo = require('../../src/repositories/boundaries');

function mockRes() {
  const res = {
    body: null,
    statusCode: 200,
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; }
  };
  return res;
}

/**
 * Every count the handler issues. The document counts are answered off the OPTS, so a stat wired
 * to the wrong call fails rather than reading the same number three times.
 */
function mockCounts(t, { projects, eagleOnly, centroid, documents, extracted, errors, boundaries }) {
  t.mock.method(projectsRepo, 'countVisible', async () => projects);
  t.mock.method(projectsRepo, 'countEagleOnlyIds', async () => eagleOnly);
  t.mock.method(projectsRepo, 'countWithCentroid', async () => centroid);
  t.mock.method(boundariesRepo, 'countVisible', async () => boundaries);
  t.mock.method(documentsRepo, 'countVisible', async (access, opts = {}) => {
    if (opts.extracted === true) return extracted;
    if (opts.extractionError === true) return errors;
    return documents;
  });
}

test('GET /db/stats', async (t) => {
  await t.test('reports the unlinked project count', async () => {
    // An Eagle project with no Track counterpart is RETAINED and FLAGGED by decision (TODO F17),
    // so the only place its number surfaces is here. Measured 2026-08-23: 393 total, 382 Track.
    mockCounts(t, {
      projects: 393, eagleOnly: 11, centroid: 300,
      documents: 60578, extracted: 40000, errors: 12, boundaries: 281
    });

    const res = mockRes();
    await dbController.getDbStats({}, res);

    assert.strictEqual(res.body.stats.projects, 393);
    assert.strictEqual(res.body.stats.trackProjects, 382);
    assert.strictEqual(res.body.stats.unlinkedProjects, 11);
  });

  await t.test('the unlinked count is measured, not derived from a filtered list read', async () => {
    // `sourceSystem` IS the flag, so the number comes off the same predicate the reconcile uses.
    // The total must stay unfiltered, or the delta compares two different corpora.
    mockCounts(t, {
      projects: 393, eagleOnly: 11, centroid: 0, documents: 0, extracted: 0, errors: 0, boundaries: 0
    });
    let countVisibleOpts = 'not called';
    t.mock.method(projectsRepo, 'countVisible', async (access, opts) => {
      countVisibleOpts = opts;
      return 393;
    });

    await dbController.getDbStats({}, mockRes());

    assert.strictEqual(countVisibleOpts, undefined, 'the total is an unfiltered count');
  });

  await t.test('zero unlinked projects is reported, not omitted', async () => {
    // The healthy state. Omitting the key on 0 would make "none" and "not measured" identical —
    // the same distinction the search envelope draws with `total: null`.
    mockCounts(t, {
      projects: 382, eagleOnly: 0, centroid: 0, documents: 0, extracted: 0, errors: 0, boundaries: 0
    });

    const res = mockRes();
    await dbController.getDbStats({}, res);

    assert.strictEqual(res.body.stats.unlinkedProjects, 0);
    assert.ok('unlinkedProjects' in res.body.stats);
  });

  await t.test('the existing shape is unchanged', async () => {
    // Anything reading this endpoint keys on these; the discriminator pair in particular is how a
    // deploy is told apart from the legacy Mongo build.
    mockCounts(t, {
      projects: 1, eagleOnly: 0, centroid: 0, documents: 2, extracted: 0, errors: 0, boundaries: 3
    });

    const res = mockRes();
    await dbController.getDbStats({}, res);

    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.database, 'demi');
    assert.strictEqual(res.body.driver, 'azure-cosmos-nosql');
    assert.strictEqual(res.body.stats.documents, 2);
    assert.strictEqual(res.body.stats.boundaries, 3);
  });

  await t.test('the ingest counts surface under their own keys', async () => {
    // All seven values are distinct, so a stat wired to the wrong count fails here rather than
    // reporting a plausible number. `documentsExtracted` in particular must not be the total.
    mockCounts(t, {
      projects: 393, eagleOnly: 11, centroid: 300,
      documents: 60578, extracted: 40000, errors: 12, boundaries: 281
    });

    const res = mockRes();
    await dbController.getDbStats({}, res);

    assert.strictEqual(res.body.stats.projectsWithCentroid, 300);
    assert.strictEqual(res.body.stats.documentsExtracted, 40000);
    assert.strictEqual(res.body.stats.documentsExtractionErrors, 12);
    assert.strictEqual(res.body.stats.documents, 60578, 'the total stays unfiltered');
  });
});
