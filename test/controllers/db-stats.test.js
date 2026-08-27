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

test('GET /db/stats', async (t) => {
  await t.test('reports the unlinked project count', async () => {
    // An Eagle project with no Track counterpart is RETAINED and FLAGGED by decision (TODO F17),
    // so the only place its number surfaces is here. Measured 2026-08-23: 393 total, 382 Track.
    t.mock.method(projectsRepo, 'countVisible', async () => 393);
    t.mock.method(projectsRepo, 'countEagleOnlyIds', async () => 11);
    t.mock.method(documentsRepo, 'countVisible', async () => 60578);
    t.mock.method(boundariesRepo, 'countVisible', async () => 281);

    const res = mockRes();
    await dbController.getDbStats({}, res);

    assert.strictEqual(res.body.stats.projects, 393);
    assert.strictEqual(res.body.stats.trackProjects, 382);
    assert.strictEqual(res.body.stats.unlinkedProjects, 11);
  });

  await t.test('the unlinked count is measured, not derived from a filtered list read', async () => {
    // `sourceSystem` IS the flag, so the number comes off the same predicate the reconcile uses.
    // The total must stay unfiltered, or the delta compares two different corpora.
    let countVisibleOpts = 'not called';
    t.mock.method(projectsRepo, 'countVisible', async (access, opts) => {
      countVisibleOpts = opts;
      return 393;
    });
    t.mock.method(projectsRepo, 'countEagleOnlyIds', async () => 11);
    t.mock.method(documentsRepo, 'countVisible', async () => 0);
    t.mock.method(boundariesRepo, 'countVisible', async () => 0);

    await dbController.getDbStats({}, mockRes());

    assert.strictEqual(countVisibleOpts, undefined, 'the total is an unfiltered count');
  });

  await t.test('zero unlinked projects is reported, not omitted', async () => {
    // The healthy state. Omitting the key on 0 would make "none" and "not measured" identical —
    // the same distinction the search envelope draws with `total: null`.
    t.mock.method(projectsRepo, 'countVisible', async () => 382);
    t.mock.method(projectsRepo, 'countEagleOnlyIds', async () => 0);
    t.mock.method(documentsRepo, 'countVisible', async () => 0);
    t.mock.method(boundariesRepo, 'countVisible', async () => 0);

    const res = mockRes();
    await dbController.getDbStats({}, res);

    assert.strictEqual(res.body.stats.unlinkedProjects, 0);
    assert.ok('unlinkedProjects' in res.body.stats);
  });

  await t.test('the existing shape is unchanged', async () => {
    // Anything reading this endpoint keys on these; the discriminator pair in particular is how a
    // deploy is told apart from the legacy Mongo build (eagle-demi/CLAUDE.md).
    t.mock.method(projectsRepo, 'countVisible', async () => 1);
    t.mock.method(projectsRepo, 'countEagleOnlyIds', async () => 0);
    t.mock.method(documentsRepo, 'countVisible', async () => 2);
    t.mock.method(boundariesRepo, 'countVisible', async () => 3);

    const res = mockRes();
    await dbController.getDbStats({}, res);

    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.database, 'demi');
    assert.strictEqual(res.body.driver, 'azure-cosmos-nosql');
    assert.strictEqual(res.body.stats.documents, 2);
    assert.strictEqual(res.body.stats.boundaries, 3);
  });
});
