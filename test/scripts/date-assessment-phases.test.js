'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { run } = require('../../src/scripts/date-assessment-phases');
const { logger } = require('../../src/utils/logger');
const fx = require('../fixtures/act-assessments');

const posted = (phase, datePosted, extra = {}) =>
  ({ id: `doc-${phase.id}-${datePosted}`, projectPhaseId: phase.id, datePosted, read: ['public'], ...extra });

const PUBLIC_REVIEW = posted(fx.PHASES.applicationReview, '2010-03-02T00:00:00.000Z');
const REFERRAL = '2011-01-10T00:00:00.000Z';

/** Repositories over one stored project; `upsert` throws `failWith` on every call when given. */
function fakeDeps(row, documents, { failWith } = {}) {
  const store = { row, upserts: [], rereads: 0 };
  const assertSystem = (access) => assert.strictEqual(access && access.tier, 'privileged',
    'the pass must read as systemAccess(), or it misses rows');
  store.deps = {
    projects: {
      async listVisible(access) { assertSystem(access); return { items: [store.row] }; },
      async getById(access) { assertSystem(access); store.rereads++; return store.row; },
      async upsert(next, { etag }) {
        if (failWith) throw Object.assign(new Error('etag moved'), { code: failWith });
        store.upserts.push({ next, etag });
        store.row = { ...next, _etag: `${etag}+` };
      }
    },
    documents: {
      async projectedRowsForProject(access) { assertSystem(access); return documents; }
    },
    periods: {
      async listEveryByProject(_id, access) { assertSystem(access); return []; }
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
