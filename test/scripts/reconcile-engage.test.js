'use strict';

/**
 * reconcile-engage against a fake eagle-api, a fake ENGAGE API, an in-memory repository and a
 * recording enqueue. What matters is what is reported and what is re-queued: only `--repair`
 * queues, and only the rows Eagle disagrees with.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { logger } = require('../../src/utils/logger');
const { REPORT_ID, parseArgs, run } = require('../../src/scripts/reconcile-engage');

const API = 'https://eagle.example/api';
const ISSUER = 'https://login.example/auth/realms/eao-epic';
const ENGAGE = 'https://engage.example/api';
const EAGLE_PROJECT = '5cf00c03a266b7e1877504db';

const ENV = {
  SYNC_OUT_EAGLE_ENABLED: 'true',
  EAGLE_PROTECTED_API_BASE: API,
  EAGLE_KC_ISSUER: ISSUER,
  EAGLE_KC_CLIENT_ID: 'demi-sync-out',
  EAGLE_KC_CLIENT_SECRET: 'not-a-real-value',
  EAGLE_ENGAGE_MILESTONE: '5cf00c03a266b7e1877504aa'
};

function engageRow(overrides = {}) {
  return {
    id: 'engage-42',
    projectId: 'p-207',
    sourceSystem: 'engage',
    engagementId: 42,
    eagleProjectId: EAGLE_PROJECT,
    eagleId: 'cp-42',
    syncOut: { eagle: { status: 'sent', sentVersion: 1791478800000 } },
    sources: {
      engage: {
        start: '2026-10-10T07:00:00.000Z',
        end: '2026-11-10T07:00:00.000Z',
        metURL: 'https://engage.example/have-your-say',
        isPublished: true,
        isDeleted: false
      }
    },
    ...overrides
  };
}

/** What Eagle holds for `engageRow()`, field for field. */
const EAGLE_COPY = {
  _id: 'cp-42',
  dateStarted: '2026-10-10T07:00:00.000Z',
  dateCompleted: '2026-11-10T07:00:00.000Z',
  isPublished: true,
  metURL: 'https://engage.example/have-your-say'
};

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

/**
 * Fake fetch. `periods` maps an Eagle id to its record (absent = 200 []), `status` overrides one
 * id's HTTP status, `byProject` is the project list, `engagements` and `metadata` are ENGAGE's.
 */
function fakeFetch({ periods = { 'cp-42': EAGLE_COPY }, status = {}, byProject, engagements = [], metadata = {} } = {}) {
  const calls = [];
  const get = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    if (url === `${ISSUER}/protocol/openid-connect/token`) return json(200, { access_token: 'tok', expires_in: 300 });
    if (url.startsWith(`${API}/commentperiod?project=`)) {
      return json(200, byProject || Object.values(periods).map(p => ({ _id: p._id, metURL: p.metURL })));
    }
    const one = url.match(/^https:\/\/eagle\.example\/api\/commentperiod\/([^?]+)\?fields=/);
    if (one) {
      const id = decodeURIComponent(one[1]);
      if (status[id]) return json(status[id], null);
      return json(200, periods[id] ? [periods[id]] : []);
    }
    const list = url.match(/^https:\/\/engage\.example\/api\/engagements\/\?page=(\d+)&size=(\d+)$/);
    if (list) {
      const size = Number(list[2]);
      const start = (Number(list[1]) - 1) * size;
      return json(200, { items: engagements.slice(start, start + size), total: engagements.length });
    }
    const meta = url.match(/^https:\/\/engage\.example\/api\/engagementsmetadata\/(\d+)$/);
    if (meta) return json(200, { engagement_id: Number(meta[1]), project_id: metadata[meta[1]] ?? null });
    throw new Error(`unexpected fetch ${url}`);
  };
  return { get, calls };
}

/** One in-memory store of rows, written only through an etag-guarded upsert. */
function fakeRepo(rows) {
  const store = new Map(rows.map(row => [row.id, { ...structuredClone(row), _etag: 'e1' }]));
  return {
    store,
    listEveryEngage: async () => [...store.values()].map(row => structuredClone(row)),
    readForWrite: async id => (store.has(id) ? structuredClone(store.get(id)) : null),
    upsert: async (item, current) => {
      if (store.get(item.id)._etag !== current._etag) throw Object.assign(new Error('precondition'), { code: 412 });
      store.set(item.id, { ...structuredClone(item), _etag: 'e2' });
      return store.get(item.id);
    }
  };
}

function setup(t, { rows = [engageRow()], fetchOpts, engageApiBase = '', env = {} } = {}) {
  for (const [key, value] of Object.entries({ ...ENV, ...env })) {
    const before = process.env[key];
    process.env[key] = value;
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  }
  const logged = { info: [], warn: [], error: [] };
  for (const level of Object.keys(logged)) t.mock.method(logger, level, (msg) => logged[level].push(String(msg)));
  const repo = fakeRepo(rows);
  const fetcher = fakeFetch(fetchOpts);
  const queued = [];
  const stored = [];
  const deps = {
    commentPeriods: repo,
    fetch: fetcher.get,
    engageApiBase,
    enqueue: async (row) => { queued.push(String(row.id)); return ['eagle']; },
    cache: { put: async (id, doc) => { stored.push({ id, doc }); } }
  };
  return { deps, repo, queued, stored, logged, calls: fetcher.calls };
}

test('parseArgs', () => {
  assert.deepStrictEqual(parseArgs([]), { repair: false, store: false, limit: null });
  assert.deepStrictEqual(parseArgs(['--repair', '--store', '--limit', '5']), { repair: true, store: true, limit: 5 });
  assert.throws(() => parseArgs(['--limit', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--fix']), /unknown argument/);
});

test('DEMI vs Eagle', async (t) => {
  await t.test('a row Eagle matches is not drift and queues nothing, even with --repair', async (tt) => {
    const { deps, queued } = setup(tt);
    const report = await run({ repair: true, deps });

    assert.strictEqual(report.checked, 1);
    assert.deepStrictEqual(report.drift, []);
    assert.deepStrictEqual(report.neverSynced, []);
    assert.deepStrictEqual(report.missingInEagle, []);
    assert.deepStrictEqual(queued, []);
    assert.strictEqual(report.queued, 0);
  });

  await t.test('dates compare at the minute in UTC, whatever the offset written', async (tt) => {
    const { deps } = setup(tt, { fetchOpts: { periods: { 'cp-42': {
      ...EAGLE_COPY, dateStarted: '2026-10-10T00:00:42.123-07:00'
    } } } });
    const report = await run({ deps });
    assert.deepStrictEqual(report.drift, []);
  });

  await t.test('drift is reported field by field and re-queued only with --repair', async (tt) => {
    const fetchOpts = { periods: { 'cp-42': { ...EAGLE_COPY, dateCompleted: '2026-11-11T07:00:00.000Z', isPublished: false } } };
    const dry = setup(tt, { fetchOpts });
    const dryReport = await run({ deps: dry.deps });

    assert.deepStrictEqual(dryReport.drift, [{
      id: 'engage-42', engagementId: 42, eagleId: 'cp-42',
      fields: [
        { field: 'dateCompleted', demi: '2026-11-10T07:00:00.000Z', eagle: '2026-11-11T07:00:00.000Z' },
        { field: 'isPublished', demi: true, eagle: false }
      ]
    }]);
    assert.deepStrictEqual(dry.queued, []);
    assert.strictEqual(dry.repo.store.get('engage-42').syncOut.eagle.sentVersion, 1791478800000,
      'a dry run writes nothing');
    assert.ok(dry.logged.info.some(line => /drift engage-42 .*dateCompleted demi=/.test(line)));
  });

  await t.test('--repair clears the sent version, so the worker sends instead of skipping, then queues', async (tt) => {
    const fetchOpts = { periods: { 'cp-42': { ...EAGLE_COPY, metURL: 'https://engage.example/old' } } };
    const { deps, queued, repo } = setup(tt, { fetchOpts });
    const report = await run({ repair: true, deps });

    assert.deepStrictEqual(queued, ['engage-42']);
    assert.strictEqual(report.queued, 1);
    assert.strictEqual(repo.store.get('engage-42').syncOut.eagle.sentVersion, null);
    assert.strictEqual(repo.store.get('engage-42').syncOut.eagle.status, 'sent');
  });

  await t.test('a row with no eagleId is never-synced, and --repair queues it', async (tt) => {
    const { deps, queued, calls } = setup(tt, { rows: [engageRow({ eagleId: null, syncOut: undefined })] });
    const report = await run({ repair: true, deps });

    assert.deepStrictEqual(report.neverSynced, [{ id: 'engage-42', engagementId: 42, eagleId: null }]);
    assert.deepStrictEqual(queued, ['engage-42']);
    assert.ok(!calls.some(c => /\/commentperiod\/[^?]/.test(c.url)), 'nothing to look up in Eagle');
  });

  await t.test('an id Eagle does not hold is missing-in-eagle, whether it answers 404 or 200 []', async (tt) => {
    for (const fetchOpts of [{ periods: {} }, { status: { 'cp-42': 404 } }]) {
      const { deps, queued } = setup(tt, { fetchOpts });
      const report = await run({ repair: true, deps });
      assert.deepStrictEqual(report.missingInEagle, [{ id: 'engage-42', engagementId: 42, eagleId: 'cp-42' }]);
      assert.deepStrictEqual(queued, ['engage-42']);
    }
  });

  await t.test('any other Eagle error is a warning, never a repair', async (tt) => {
    const { deps, queued } = setup(tt, { fetchOpts: { status: { 'cp-42': 500 } } });
    const report = await run({ repair: true, deps });
    assert.deepStrictEqual(report.missingInEagle, []);
    assert.deepStrictEqual(queued, []);
    assert.match(report.warnings[0], /HTTP 500/);
  });

  await t.test('a deleted row Eagle still holds is drift; one Eagle no longer holds is clean', async (tt) => {
    const deletedRow = engageRow({ isDeleted: true });
    const held = setup(tt, { rows: [deletedRow] });
    assert.deepStrictEqual((await run({ deps: held.deps })).drift[0].fields,
      [{ field: 'isDeleted', demi: true, eagle: false }]);
    const gone = setup(tt, { rows: [deletedRow], fetchOpts: { periods: {} } });
    const report = await run({ repair: true, deps: gone.deps });
    assert.deepStrictEqual([report.drift, report.missingInEagle, gone.queued], [[], [], []]);
  });

  await t.test('two Eagle periods on one engagement URL under one project are a duplicate', async (tt) => {
    const { deps } = setup(tt, { fetchOpts: { byProject: [
      { _id: 'cp-42', metURL: EAGLE_COPY.metURL }, { _id: 'cp-43', metURL: EAGLE_COPY.metURL },
      { _id: 'cp-legacy', metURL: '' }, { _id: 'cp-other', metURL: '' }
    ] } });
    const report = await run({ deps });
    assert.deepStrictEqual(report.duplicates,
      [{ eagleProjectId: EAGLE_PROJECT, metURL: EAGLE_COPY.metURL, eagleIds: ['cp-42', 'cp-43'] }]);
  });

  await t.test('--repair with the Eagle consumer off queues nothing and says why', async (tt) => {
    const { deps, queued, repo } = setup(tt, { rows: [engageRow({ eagleId: null })], env: { SYNC_OUT_EAGLE_ENABLED: 'false' } });
    const report = await run({ repair: true, deps });
    assert.deepStrictEqual(queued, []);
    assert.ok(repo.store.get('engage-42').syncOut.eagle.sentVersion, 'no row written either');
    assert.ok(report.warnings.some(w => /SYNC_OUT_EAGLE_ENABLED/.test(w)));
  });

  await t.test('--limit caps the rows checked', async (tt) => {
    const { deps } = setup(tt, { rows: [engageRow(), engageRow({ id: 'engage-43', eagleId: null })] });
    const report = await run({ limit: 1, deps });
    assert.strictEqual(report.checked, 1);
  });
});

test('ENGAGE vs DEMI', async (t) => {
  await t.test('skipped with a warning when ENGAGE_API_BASE is unset', async (tt) => {
    const { deps, calls, logged } = setup(tt, { engageApiBase: '' });
    const report = await run({ deps });

    assert.ok(!calls.some(c => c.url.startsWith(ENGAGE)));
    assert.strictEqual(report.engageChecked, false);
    assert.ok(logged.warn.some(w => /ENGAGE_API_BASE is unset/.test(w)));
    assert.match(logged.info[0], /engageMissingInDemi=skipped demiMissingInEngage=skipped/);
  });

  await t.test('reports EPIC engagements DEMI lacks and published DEMI rows ENGAGE no longer lists', async (tt) => {
    // 150 engagements: two pages. 42 is in DEMI, 7 is an EPIC one DEMI lacks, the rest carry no project.
    const engagements = Array.from({ length: 150 }, (_, i) => ({ id: i + 1 }));
    const { deps } = setup(tt, {
      engageApiBase: `${ENGAGE}/`,
      rows: [
        engageRow(),
        engageRow({ id: 'engage-900', engagementId: 900, eagleId: null }),
        engageRow({ id: 'engage-901', engagementId: 901, eagleId: null,
          sources: { engage: { ...engageRow().sources.engage, isPublished: false } } })
      ],
      fetchOpts: { engagements, metadata: { 42: EAGLE_PROJECT, 7: '647e19af81de4d0022bf1d42' } }
    });
    const report = await run({ deps });

    assert.strictEqual(report.engageChecked, true);
    assert.deepStrictEqual(report.engageMissingInDemi, [{ engagementId: 7, projectId: '647e19af81de4d0022bf1d42' }]);
    // 901 is unpublished, and the anonymous list never carries those.
    assert.deepStrictEqual(report.demiMissingInEngage, [{ id: 'engage-900', engagementId: 900, eagleId: null }]);
  });
});

test('run logs one summary line, one per finding, and --store keeps the report', async (t) => {
  const { deps, stored, logged } = setup(t, { rows: [engageRow({ eagleId: null })] });
  const report = await run({ store: true, deps });

  assert.strictEqual(logged.info[0], '[reconcile-engage] checked=1 neverSynced=1 missingInEagle=0 drift=0 ' +
    'duplicates=0 engageMissingInDemi=skipped demiMissingInEngage=skipped queued=0');
  assert.match(logged.info[1], /never-synced engage-42 engagement=42/);
  assert.deepStrictEqual(stored, [{ id: REPORT_ID, doc: { body: report } }]);
});
