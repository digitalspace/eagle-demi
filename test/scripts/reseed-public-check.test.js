'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { PROD_API, TEST_ORIGIN, makeRequest, residue, verify } = require('../../scripts/reseed-public-check');

const KEEP = '6abf251529e23409d1307085';
const KEEP_ROW = { id: `eagle-${KEEP}`, name: 'Pacific Link', tags: ['West Coast Oil Pipeline'], shortUrl: '/s/pacific-link', shortLinkCustom: false };

/**
 * Serves search pages keyed by `<base>|<dataset>` and plain JSON keyed by URL path. Anything not
 * listed answers 404, so a test sees only the world it built.
 */
function fakeFetch(world) {
  return async (url) => {
    const u = new URL(url);
    const dataset = u.searchParams.get('dataset');
    if (dataset) {
      const key = `${u.href.startsWith(PROD_API) ? 'prod' : 'test'}|${dataset}`;
      const rows = world.search[key] || [];
      const size = Math.min(Number(u.searchParams.get('pageSize')), world.pageCap ?? Infinity);
      const start = Number(u.searchParams.get('pageNum')) * size;
      // `world.meta[key]` replaces the page's meta; undefined drops the field from the JSON.
      const meta = world.meta && key in world.meta ? world.meta[key] : [{ searchResultsTotal: rows.length }];
      return Response.json([{ searchResults: rows.slice(start, start + size), meta }]);
    }
    if (u.pathname.endsWith('/download')) return new Response('x', { status: 206 });
    const body = world.paths[u.pathname];
    return body === undefined ? new Response('', { status: 404 }) : Response.json(body);
  };
}

/** A post-seed world where every verify check passes; each test overrides one thing. */
function passingWorld() {
  const shared = (prefix) => [{ _id: `${prefix}1` }, { _id: `${prefix}2` }];
  return {
    search: {
      'prod|Project': [{ _id: 'p1' }, { _id: 'p2' }],
      'test|Project': [{ _id: 'p1', trackProjectId: '1' }, { _id: 'p2', trackProjectId: '2' }],
      'prod|Document': [{ _id: 'd1' }, { _id: 'd2' }, { _id: 'd3' }],
      'test|Document': [{ _id: 'd1' }, { _id: 'd2' }, { _id: 'd3' }],
      'prod|RecentActivity': shared('u'), 'test|RecentActivity': shared('u'),
      'prod|ProjectNotification': shared('n'), 'test|ProjectNotification': shared('n'),
      'prod|CommentPeriod': shared('c'), 'test|CommentPeriod': shared('c')
    },
    paths: {
      [`/demi-projects/${KEEP}`]: KEEP_ROW,
      '/demi-search/config': { EXTENDED_PROJECT_PAGES: { [KEEP]: 'pacific-link' } }
    }
  };
}

const BASELINE = { keepIds: [KEEP], keepRows: { [KEEP]: KEEP_ROW }, extendedProjectPages: { [KEEP]: 'pacific-link' } };

const runVerify = (world) => verify({ request: makeRequest(fakeFetch(world)), baseline: BASELINE });
const check = (result, name) => result.checks.find(c => c.name === name);

test('request refuses DELETE to the prod host', async () => {
  let sent = 0;
  const request = makeRequest(async () => { sent++; return new Response(''); });

  await assert.rejects(request(`${PROD_API}/search?dataset=Project`, { method: 'DELETE' }), /refused DELETE/);
  assert.strictEqual(sent, 0, 'the refused request must never reach fetch');
});

test('request lets DELETE through to the test host', async () => {
  // Without this, a guard that refuses every DELETE would pass the test above and break S6.
  const request = makeRequest(async () => new Response(null, { status: 204 }));

  const res = await request(`${TEST_ORIGIN}/demi/api/updates/u9`, { method: 'DELETE' });
  assert.strictEqual(res.status, 204);
});

test('residue drops rows of a kept project', async () => {
  const world = passingWorld();
  world.search['test|RecentActivity'] = [
    { _id: 'u1' },
    { _id: 'u-kept', headline: 'Pacific Link open house', project: { _id: KEEP, name: 'Pacific Link' } },
    { _id: 'u-stray', headline: 'Test News', project: { _id: 'p9', name: 'ABC test project' } }
  ];

  const result = await residue({ request: makeRequest(fakeFetch(world)), keepIds: [KEEP] });

  const updates = result.datasets.RecentActivity;
  assert.deepStrictEqual(updates.testOnly.map(r => r._id), ['u-stray']);
  assert.deepStrictEqual(updates.keptSkipped, ['u-kept']);
  assert.strictEqual(updates.testOnly[0].title, 'Test News');
});

test('residue reads every page when the API caps the page size', async () => {
  // Both APIs cap the page size. Reading one page would list every row past it as test-only.
  const world = passingWorld();
  const rows = [{ _id: 'u1' }, { _id: 'u2' }, { _id: 'u3' }];
  world.search['prod|RecentActivity'] = rows;
  world.search['test|RecentActivity'] = rows;
  world.pageCap = 2;

  const result = await residue({ request: makeRequest(fakeFetch(world)), keepIds: [KEEP] });

  assert.deepStrictEqual(result.datasets.RecentActivity.testOnly, []);
  assert.strictEqual(result.datasets.RecentActivity.prod, 3);
});

test('residue reads an empty dataset whose meta is [] as zero rows', async () => {
  // eagle-api's $facet answers meta: [] when the dataset has no rows.
  const world = passingWorld();
  world.search['test|RecentActivity'] = [];
  world.meta = { 'test|RecentActivity': [] };

  const result = await residue({ request: makeRequest(fakeFetch(world)), keepIds: [KEEP] });

  assert.strictEqual(result.datasets.RecentActivity.test, 0);
});

test('residue reads an empty dataset with no meta as zero rows', async () => {
  const world = passingWorld();
  world.search['test|RecentActivity'] = [];
  world.meta = { 'test|RecentActivity': undefined };

  const result = await residue({ request: makeRequest(fakeFetch(world)), keepIds: [KEEP] });

  assert.strictEqual(result.datasets.RecentActivity.test, 0);
});

test('verify fails when a prod project id is missing on test', async () => {
  const world = passingWorld();
  world.search['test|Project'] = [{ _id: 'p1', trackProjectId: '1' }];

  const result = await runVerify(world);

  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(check(result, 'prodProjectsOnTest').detail.missing, ['p2']);
});

test('verify passes a test-only project in the keep list or Track-only', async () => {
  const world = passingWorld();
  world.search['test|Project'].push(
    { _id: KEEP, id: `eagle-${KEEP}`, trackProjectId: null, name: 'Pacific Link' },
    { _id: 'hackney', id: '118', trackProjectId: '118', name: 'Hackney Wind' }
  );

  const result = await runVerify(world);

  assert.strictEqual(check(result, 'testOnlyProjectsExplained').pass, true);
  assert.strictEqual(result.ok, true);
});

test('verify fails a test-only Eagle project that is neither kept nor Track-only', async () => {
  // The other half of the rule above: a check that passes every test-only project is no check.
  const world = passingWorld();
  world.search['test|Project'].push({ _id: 'abc', id: 'eagle-abc', trackProjectId: null, name: 'ABC test project' });

  const result = await runVerify(world);

  assert.deepStrictEqual(check(result, 'testOnlyProjectsExplained').detail.unexplained, [{ _id: 'abc', name: 'ABC test project' }]);
});

test('verify fails when a kept project\'s tags differ from the baseline', async () => {
  const world = passingWorld();
  world.paths[`/demi-projects/${KEEP}`] = { ...KEEP_ROW, tags: [] };

  const result = await runVerify(world);

  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(check(result, `keepRow:${KEEP}`).detail.changed, ['tags']);
});
