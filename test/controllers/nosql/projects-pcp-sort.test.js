'use strict';

// `GET /projects` `pcp` filter and `eacDecisionSort` sort. Cosmos is faked at `query`; the fake runs
// each emitted comment-period status clause over the period fixtures, so the assertions are about
// the SQL the request built, not about the fake.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const querystring = require('node:querystring');

const projectController = require('../../../src/controllers/nosql/project');
const commentPeriodController = require('../../../src/controllers/native/comment-periods');
const { counts } = require('../../../src/controllers/native/counts');
const projectsRepo = require('../../../src/repositories/projects');
const aiSearch = require('../../../src/search/ai-search');
const cosmos = require('../../../src/db/cosmos-nosql');
const { makeRes } = require('../../../src/http/router');
const { get } = require('../../helpers/search-reads');

const DAY = 86400000;
const daysOut = days => new Date(Date.now() + days * DAY).toISOString();

const period = (id, projectId, started, completed, read = ['public']) =>
  ({ id, projectId, dateStarted: daysOut(started), dateCompleted: daysOut(completed), read });

const OPEN_P1 = period('cp-open', 'p1', -3, 10);
const CLOSED_P2 = period('cp-closed', 'p2', -40, -5);
const UPCOMING_P3 = period('cp-upcoming', 'p3', 20, 50);

const PROJECTS = ['p1', 'p2', 'p3'].map(id => ({ id, name: `Mine ${id}`, read: ['public'] }));

function bound(spec) {
  return Object.fromEntries(spec.parameters.map(p => [p.name, p.value]));
}

/** The status clauses `PCP_CLAUSES` emits, each run over a period the way Cosmos would. */
const STATUS_RULES = [
  ['(c.dateStarted <= @now AND (c.dateCompleted >= @now OR (c.dateCompleted >= @closingDayStart AND c.dateCompleted < @closingDayEnd)))',
    (r, b) => r.dateStarted <= b['@now'] && r.dateCompleted >= b['@now']],
  ['(c.dateStarted > @now AND IS_STRING(c.dateCompleted))', (r, b) => r.dateStarted > b['@now']],
  ['(c.dateCompleted < @now AND NOT (c.dateCompleted >= @closingDayStart AND c.dateCompleted < @closingDayEnd) AND IS_STRING(c.dateStarted))',
    (r, b) => r.dateCompleted < b['@now']],
  ['(c.dateStarted > @now AND c.dateStarted <= @in7Days)',
    (r, b) => r.dateStarted > b['@now'] && r.dateStarted <= b['@in7Days']]
];

/** A row is readable when the spec binds one of its `read[]` roles. */
function readable(spec, row) {
  const values = spec.parameters.flatMap(p => [].concat(p.value));
  return row.read.some(role => values.includes(role));
}

/** Fakes the index and both containers; records every Cosmos spec by container. */
function fakeStores(t, periods, { ranked = PROJECTS } = {}) {
  const seen = { commentPeriods: [], projects: [] };
  const searches = [];
  t.mock.method(aiSearch, 'searchProjects', async (opts) => {
    searches.push(opts);
    return { count: ranked.length, items: ranked.map(row => ({ id: row.id })) };
  });
  t.mock.method(cosmos, 'query', async (container, spec) => {
    seen[container].push(spec);
    const b = bound(spec);
    if (container === 'commentPeriods') {
      const rules = STATUS_RULES.filter(([clause]) => spec.query.includes(clause));
      const ids = periods
        .filter(r => readable(spec, r) && rules.some(([, match]) => match(r, b)))
        .map(r => r.projectId);
      return { items: [...new Set(ids)] };
    }
    const allowed = prefix => {
      const ids = spec.parameters.filter(p => p.name.startsWith(prefix)).map(p => p.value);
      return row => !spec.query.includes(`${prefix}0`) || ids.includes(row.id);
    };
    const pcpNone = / AND false\b|\(false\)|WHERE false\b/.test(spec.query);
    const rows = pcpNone ? [] : PROJECTS.filter(allowed('@pcp')).filter(allowed('@xid'));
    return spec.query.includes('COUNT(1)') ? { items: [rows.length] } : { items: structuredClone(rows) };
  });
  return { seen, searches };
}

async function invoke(handler, qs) {
  const req = { query: querystring.parse(qs), params: {}, headers: {}, header: () => undefined };
  const res = makeRes('test');
  await handler(req, res);
  return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : undefined };
}

const ids = res => res.body.map(row => row.id);

test('GET /projects pcp', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('pcp=open&pcp=closed returns the projects with either', async (t) => {
    const { seen } = fakeStores(t, [OPEN_P1, CLOSED_P2, UPCOMING_P3]);
    const res = await invoke(projectController.getProjects, 'pcp=open&pcp=closed');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(ids(res), ['p1', 'p2']);
    assert.strictEqual(seen.commentPeriods.length, 1, 'one period read for both statuses');
  });

  await t.test('pcp=pending matches a period starting in 3 days and not one starting in 10', async (t) => {
    fakeStores(t, [period('cp-3', 'p1', 3, 30), period('cp-10', 'p2', 10, 40)]);
    const res = await invoke(projectController.getProjects, 'pcp=pending');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(ids(res), ['p1']);
  });

  await t.test('an unknown pcp value is a 400 before any read', async (t) => {
    const { seen } = fakeStores(t, [OPEN_P1]);
    const res = await invoke(projectController.getProjects, 'pcp=open&pcp=soon');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'pcp takes open, upcoming, closed, pending');
    assert.strictEqual(seen.commentPeriods.length + seen.projects.length, 0);
  });

  await t.test('no matching period gives no rows and a zero count', async (t) => {
    fakeStores(t, [OPEN_P1]);
    const res = await invoke(projectController.getProjects, 'pcp=pending&count=true');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, []);
    assert.strictEqual(res.headers['x-total-count'], '0');
  });

  await t.test('an unpublished period does not qualify its project for an anonymous caller', async (t) => {
    fakeStores(t, [OPEN_P1, period('cp-staff', 'p2', -1, 5, ['staff'])]);
    const res = await invoke(projectController.getProjects, 'pcp=open');
    assert.deepStrictEqual(ids(res), ['p1']);
  });

  await t.test('with q, pcp narrows the ranked ids', async (t) => {
    const { searches } = fakeStores(t, [CLOSED_P2]);
    const res = await invoke(projectController.getProjects, 'q=mine&pcp=closed');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(searches.length, 1);
    assert.deepStrictEqual(ids(res), ['p2']);
  });

  await t.test('/counts?kind=projects refuses pcp', async (t) => {
    fakeStores(t, [OPEN_P1]);
    const res = await invoke(counts, 'kind=projects&pcp=open');
    assert.strictEqual(res.status, 400);
  });
});

test('pending is a pcp value only', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('/comment-periods?status=pending is a 400', async (t) => {
    fakeStores(t, []);
    const res = await invoke(commentPeriodController.getCommentPeriods, 'status=pending');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'status takes open, upcoming, closed');
  });

  await t.test('compat /search refuses and[status]=pending', async () => {
    const { status, body } = await get('/api/search?dataset=CommentPeriod&and%5Bstatus%5D=pending');
    assert.strictEqual(status, 400);
    assert.match(body.error, /and\[status\] must be one of open, upcoming, closed/);
  });
});

test('eacDecisionSort', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  /** The item an etag upsert hands to Cosmos. */
  async function written(t, project) {
    let item;
    t.mock.method(cosmos, 'upsert', async (_container, i) => { item = i; return i; });
    await projectsRepo.upsert(project, { etag: '"0x1"' });
    return item;
  }

  await t.test('sort=eacDecisionSort keeps a row with no decision, which still stores and returns null', async (t) => {
    const row = await written(t, { id: 'p9', name: 'Undecided', eacDecision: null, read: ['public'] });
    assert.strictEqual(row.eacDecision, null, 'filling eacDecision would render an empty decision');
    assert.strictEqual(row.eacDecisionSort, null);

    const queries = [];
    t.mock.method(cosmos, 'query', async (_container, spec) => {
      queries.push(spec);
      return { items: [structuredClone(row)] };
    });
    const res = await invoke(projectController.getProjects, 'sort=-eacDecisionSort');
    assert.strictEqual(res.status, 200);
    assert.match(queries[0].query, /ORDER BY c\.eacDecisionSort DESC$/);
    assert.strictEqual(res.body[0].eacDecision, null);
    assert.strictEqual(res.body[0].eacDecisionSort, null);
  });

  await t.test('an upsert that renames the decision rewrites a stale eacDecisionSort', async (t) => {
    const row = await written(t, {
      id: 'p9', eacDecision: { _id: 'E2', name: 'Not Approved' }, eacDecisionSort: 'Approved'
    });
    assert.strictEqual(row.eacDecisionSort, 'Not Approved');
  });

  await t.test('a decision without a string name sorts as null', async (t) => {
    const row = await written(t, { id: 'p9', eacDecision: 'E2' });
    assert.strictEqual(row.eacDecisionSort, null);
    assert.strictEqual(row.eacDecision, 'E2');
  });
});

test('currentPhaseName always holds a name, so the phase sort keeps the row', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const cases = [
    ['null', null, { _id: null, name: null }],
    ['a bare id', 'P1', { _id: 'P1', name: null }],
    ['a ref without name', { _id: 'P1' }, { _id: 'P1', name: null }]
  ];
  for (const [label, phase, expected] of cases) {
    await t.test(`${label} becomes ${JSON.stringify(expected)}`, () => {
      assert.deepStrictEqual(projectsRepo.sortFieldFills({ currentPhaseName: phase }).currentPhaseName, expected);
    });
  }

  await t.test('a ref whose name is null is left alone', () => {
    assert.strictEqual(
      projectsRepo.sortFieldFills({ currentPhaseName: { _id: 'P1', name: null } }).currentPhaseName, undefined);
  });
});
