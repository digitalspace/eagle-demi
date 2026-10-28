'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { run } = require('../../src/scripts/date-assessment-phases');
const projectsRepository = require('../../src/repositories/projects');
const documentsRepository = require('../../src/repositories/documents');
const periodsRepository = require('../../src/repositories/comment-periods');
const listsRepository = require('../../src/repositories/lists');
const { logger } = require('../../src/utils/logger');
const fx = require('../fixtures/act-assessments');

const posted = (phase, datePosted, extra = {}) =>
  ({ id: `doc-${phase.id}-${datePosted}`, projectPhaseId: phase.id, datePosted, read: ['public'], ...extra });

const PUBLIC_REVIEW = posted(fx.PHASES.applicationReview, '2010-03-02T00:00:00.000Z');
const REFERRAL = '2011-01-10T00:00:00.000Z';

/**
 * Repositories over one stored project. `upsert` throws `failWith` on the first `failTimes` calls;
 * `listed` is the row the run starts from, when it differs from the stored one.
 */
function fakeDeps(row, documents, { failWith, failTimes = Infinity, listed, periods = [] } = {}) {
  const store = { row, upserts: [], rereads: 0, failures: 0 };
  const assertSystem = (access) => assert.strictEqual(access && access.tier, 'privileged',
    'the pass must read as systemAccess(), or it misses rows');
  store.deps = {
    projects: {
      async listVisible(access) { assertSystem(access); return { items: [listed || store.row] }; },
      async getById(access) { assertSystem(access); store.rereads++; return store.row; },
      async upsert(next, { etag }) {
        if (failWith && store.failures++ < failTimes) throw Object.assign(new Error('etag moved'), { code: failWith });
        store.upserts.push({ next, etag });
        store.row = { ...next, _etag: `${etag}+` };
      }
    },
    documents: {
      async projectedRowsForProject(access) { assertSystem(access); return documents; }
    },
    periods: {
      async listEveryByProject(_id, access) { assertSystem(access); return periods; }
    },
    lists: {
      async listEveryOfKind(kind, access) { assertSystem(access); return kind === 'List' ? fx.PHASE_ROWS : []; }
    }
  };
  return store;
}

const stages = (row) => row.documentPhases.map(phase => phase.stage);

test('date-assessment-phases run', async (t) => {
  t.beforeEach(() => {
    t.mock.method(logger, 'info', () => {});
    t.mock.method(logger, 'warn', () => {});
    t.mock.method(logger, 'error', () => {});
  });
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a non-public document does not date a phase', async () => {
    const store = fakeDeps({ ...fx.only2002(), _etag: 'e1' },
      [PUBLIC_REVIEW, posted(fx.PHASES.referral, REFERRAL, { read: ['staff'] })]);
    await run({ live: true, deps: store.deps });

    assert.deepStrictEqual(stages(store.upserts[0].next), ['Application Review']);
  });

  await t.test('a document whose vis dials datePosted below 4 is skipped', async () => {
    const store = fakeDeps({ ...fx.only2002(), _etag: 'e1' },
      [PUBLIC_REVIEW, posted(fx.PHASES.referral, REFERRAL, { vis: { datePosted: 2 } })]);
    await run({ live: true, deps: store.deps });

    assert.deepStrictEqual(stages(store.upserts[0].next), ['Application Review']);
  });

  await t.test('a comment period whose label is dialled below 4 dates without the label', async () => {
    const period = { id: 'cp1', dateStarted: '2010-04-01T00:00:00.000Z', informationLabel: 'Draft',
      read: ['public'], vis: { informationLabel: 2 } };
    const store = fakeDeps({ ...fx.only2002(), _etag: 'e1' }, [], { periods: [period] });
    await run({ live: true, deps: store.deps });

    const [entry] = store.upserts[0].next.documentPhases;
    assert.deepStrictEqual([entry.commentPeriodId, entry.label], ['cp1', null]);
  });

  await t.test('a write rebuilt after a lost race files documents by the reread row\'s Act blocks', async () => {
    const document = posted(fx.PHASES.preApplication, '2003-05-01T00:00:00.000Z');
    const store = fakeDeps({ ...fx.movedFrom1996('2004-06-01T00:00:00.000Z'), _etag: 'e2' }, [document],
      { failWith: 412, failTimes: 1, listed: { ...fx.movedFrom1996(null), _etag: 'e1' } });
    await run({ live: true, deps: store.deps });

    assert.deepStrictEqual(store.upserts[0].next.documentPhases.map(phase => phase.legislationYear), [1996]);
  });

  await t.test('a written row carries the derived fields on its etag', async () => {
    const store = fakeDeps({ ...fx.only2002(), _etag: 'e1' }, [PUBLIC_REVIEW]);
    const summary = await run({ live: true, deps: store.deps });

    const [{ next, etag }] = store.upserts;
    assert.strictEqual(etag, 'e1');
    assert.ok(next.assessments.length && Array.isArray(next.phaseIds) && 'activeWork' in next);
    assert.deepStrictEqual([summary.written, summary.unchanged, summary.failures], [1, 0, 0]);
  });

  await t.test('unchanged derived fields are not written', async () => {
    const store = fakeDeps({ ...fx.only2002(), _etag: 'e1' }, [PUBLIC_REVIEW]);
    await run({ live: true, deps: store.deps });
    const again = await run({ live: true, deps: store.deps });

    assert.strictEqual(store.upserts.length, 1);
    assert.deepStrictEqual([again.projects, again.written, again.unchanged], [1, 0, 1]);
  });

  await t.test('dry run writes nothing', async () => {
    const store = fakeDeps({ ...fx.only2002(), _etag: 'e1' }, [PUBLIC_REVIEW]);
    const summary = await run({ deps: store.deps });

    assert.strictEqual(store.upserts.length, 0);
    assert.deepStrictEqual([summary.mode, summary.written], ['dry-run', 1]);
  });

  await t.test('an etag conflict is counted, not thrown', async () => {
    const store = fakeDeps({ ...fx.only2002(), _etag: 'e1' }, [PUBLIC_REVIEW], { failWith: 412 });
    const summary = await run({ live: true, deps: store.deps });

    assert.ok(store.rereads > 0, 'a lost race rebuilds off the stored row');
    assert.deepStrictEqual([summary.written, summary.failures], [0, 1]);
  });

  await t.test('the summary line names every count', async () => {
    const info = t.mock.method(logger, 'info', () => {});
    await run({ deps: fakeDeps({ ...fx.only2002(), _etag: 'e1' }, []).deps });

    assert.match(info.mock.calls[0].arguments[0], /projects=1 written=1 unchanged=0 failures=0$/);
  });
});

// Every other test injects fakes, so only this one sees a method the real repositories lack.
test('the repositories the pass reads by default have every method it calls', () => {
  const calls = [[projectsRepository, ['listVisible', 'getById', 'upsert']],
    [documentsRepository, ['projectedRowsForProject']],
    [periodsRepository, ['listEveryByProject']],
    [listsRepository, ['listEveryOfKind']]];
  const missing = calls.flatMap(([repository, methods]) =>
    methods.filter(method => typeof repository[method] !== 'function'));
  assert.deepStrictEqual(missing, []);
});
