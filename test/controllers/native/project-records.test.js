'use strict';

// `GET /project-records`. Cosmos is faked at `query` (rows in the SQL's ORDER BY, paged by maxItemCount
// and continuation), the indexes at `searchProjects` and `searchNotifications`.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const querystring = require('node:querystring');

const { getProjectRecords } = require('../../../src/controllers/native/project-records');
const projectController = require('../../../src/controllers/nosql/project');
const aiSearch = require('../../../src/search/ai-search');
const cosmos = require('../../../src/db/cosmos-nosql');
const { makeRes } = require('../../../src/http/router');
const { swaggerParams, queryNames } = require('../../helpers/swagger-params');
const { recordEvents } = require('../../helpers/record-events');
const audit = require('../../../src/utils/audit');
const { logger } = require('../../../src/utils/logger');

const STAFF = { realm_access: { roles: ['staff'] } };

const project = (id, name) => ({ id, name, read: ['public'] });
const notice = (id, name, extra = {}) =>
  ({ id, eagleId: id, name, type: 'Mines', decision: 'Referred', pcp: 'none', proponent: 'Teck', read: ['public'], ...extra });

// Merged by name: Alpha Bravo Charlie(n) | Delta Delta(n) Foxtrot | Golf(n) Hotel Juliet.
const PROJECTS = ['Alpha', 'Bravo', 'Delta', 'Foxtrot', 'Hotel', 'Juliet'].map((name, i) => project(`p${i + 1}`, name));
const NOTICES = [notice('n1', 'Charlie'), notice('n2', 'Delta'), notice('n3', 'Golf')];
const MERGED_IDS = ['p1', 'p2', 'n1', 'p3', 'n2', 'p4', 'n3', 'p5', 'p6'];

function byOrder(rows, sql) {
  const order = sql.match(/ORDER BY c\.(\w+) (ASC|DESC)/);
  if (!order) return rows;
  const [, field, dir] = order;
  const rank = v => (v == null ? '' : `~${v}`);
  const sorted = [...rows].sort((a, b) => (rank(a[field]) < rank(b[field]) ? -1 : rank(a[field]) > rank(b[field]) ? 1 : 0));
  return dir === 'DESC' ? sorted.reverse() : sorted;
}

const values = (spec, prefix) => spec.parameters.filter(p => p.name.startsWith(prefix)).map(p => p.value);

/**
 * Fakes the containers and both indexes; records each Cosmos spec by container. The role arm and the
 * `@xid`/`@pcp` id lists are applied; a comment-period read answers the project ids of `periods`.
 */
function fakeStores(t, { projects = PROJECTS, notices = NOTICES, periods = [] } = {}) {
  const seen = { projects: [], notifications: [], commentPeriods: [] };
  t.mock.method(aiSearch, 'searchProjects', async () => ({ count: projects.length, items: projects.map(({ id }) => ({ id })) }));
  t.mock.method(aiSearch, 'searchNotifications', async () => ({ count: notices.length, items: notices.map(({ id }) => ({ id })) }));
  t.mock.method(cosmos, 'query', async (container, spec, options = {}) => {
    (seen[container] = seen[container] || []).push(spec);
    const roles = values(spec, '@role');
    const admitted = row => roles.length === 0 || row.read.some(role => roles.includes(role));
    if (container === 'commentPeriods') return { items: [...new Set(periods.filter(admitted).map(row => row.projectId))] };
    let rows = (container === 'projects' ? projects : container === 'notifications' ? notices : []).filter(admitted);
    if (/ AND false\b|\(false\)|WHERE false\b/.test(spec.query)) rows = [];
    for (const prefix of ['@xid', '@pcp']) {
      const ids = values(spec, prefix);
      if (spec.query.includes(`${prefix}0`)) rows = rows.filter(row => ids.includes(row.id));
    }
    if (spec.query.includes('COUNT(1)')) return { items: [rows.length] };
    rows = byOrder(structuredClone(rows), spec.query);
    const from = Number(options.continuationToken || 0);
    const to = options.maxItemCount ? from + options.maxItemCount : rows.length;
    return { items: rows.slice(from, to), continuationToken: to < rows.length ? String(to) : undefined };
  });
  return seen;
}

async function call(qs, { user, handler = getProjectRecords } = {}) {
  const req = { query: querystring.parse(qs), params: {}, headers: {}, header: () => undefined, user };
  const res = makeRes('test');
  await handler(req, res);
  return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : undefined };
}

const kinds = body => body.map(row => row.recordKind);
const sqlOf = specs => specs.map(spec => spec.query).join('\n');
const paramValues = specs => specs.flatMap(spec => spec.parameters.map(p => p.value));

test('GET /project-records', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('name-sorted pages split a merged list with no row twice or missing, total P + N', async (t) => {
    fakeStores(t);
    const ids = [];
    for (const page of [1, 2, 3]) {
      const res = await call(`page=${page}&pageSize=3&count=true`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers['x-total-count'], '9');
      ids.push(...res.body.map(row => row.id));
    }
    assert.deepStrictEqual(ids, MERGED_IDS);
  });

  for (const qs of ['currentPhaseName=P1', 'eacDecision=E1', 'dateUpdatedStart=2020-01-01', 'phaseIds=a']) {
    await t.test(`${qs} is a project-only filter: no notification rows`, async (t) => {
      const seen = fakeStores(t);
      const res = await call(qs);
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(kinds(res.body), PROJECTS.map(() => 'project'));
      assert.strictEqual(seen.notifications.length, 0);
    });
  }

  await t.test('decision is notification-only: no project rows', async (t) => {
    const seen = fakeStores(t);
    const res = await call('decision=Referred');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.map(row => row.id), ['n1', 'n2', 'n3']);
    assert.strictEqual(seen.projects.length, 0);
    assert.match(sqlOf(seen.notifications), /c\.decision = @nf\d/);
  });

  await t.test('recordKind=notification lists notifications only', async (t) => {
    const seen = fakeStores(t);
    const res = await call('recordKind=notification&count=true');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(kinds(res.body), ['notification', 'notification', 'notification']);
    assert.strictEqual(res.headers['x-total-count'], '3');
    assert.strictEqual(seen.projects.length, 0);
  });

  await t.test('recordKind=project lists projects only, with no notification read', async (t) => {
    const seen = fakeStores(t);
    const res = await call('recordKind=project');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(kinds(res.body), PROJECTS.map(() => 'project'));
    assert.strictEqual(seen.notifications.length, 0);
  });

  await t.test('pcp=open narrows projects to open-period ids and notifications on their stored pcp', async (t) => {
    const seen = fakeStores(t, { periods: [{ id: 'cp1', projectId: 'p2', read: ['public'] }] });
    const res = await call('pcp=open');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.filter(row => row.recordKind === 'project').map(row => row.id), ['p2']);
    assert.strictEqual(seen.commentPeriods.length, 1);
    assert.match(sqlOf(seen.notifications), /c\.pcp = @nf\d/);
    assert.ok(paramValues(seen.notifications).includes('open'));
  });

  await t.test('pcp=open with no open period lists no projects; notifications still filter on pcp', async (t) => {
    const seen = fakeStores(t);
    const res = await call('pcp=open');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(kinds(res.body), NOTICES.map(() => 'notification'));
    assert.match(sqlOf(seen.notifications), /c\.pcp = @nf\d/);
  });

  await t.test('a staff-only notification is listed for staff, not for an anonymous caller', async (t) => {
    fakeStores(t, { notices: [...NOTICES, notice('n9', 'Echo', { read: ['staff'] })] });
    const anonymous = await call('recordKind=notification');
    assert.deepStrictEqual(anonymous.body.map(row => row.id), ['n1', 'n2', 'n3']);
    const staff = await call('recordKind=notification', { user: STAFF });
    assert.deepStrictEqual(staff.body.map(row => row.id), ['n1', 'n2', 'n9', 'n3']);
  });

  await t.test('a credential answer is never stored; an anonymous one sets no cache-control', async (t) => {
    fakeStores(t);
    assert.strictEqual((await call('', { user: STAFF })).headers['cache-control'], 'private, no-store');
    assert.strictEqual((await call('')).headers['cache-control'], undefined);
  });

  await t.test('a keyword list is logged as a search event', async (t) => {
    const events = recordEvents(t);
    fakeStores(t);
    assert.strictEqual((await call('q=mine&count=true')).status, 200);
    const rows = await events(audit.EVENTS_STREAM);
    assert.deepStrictEqual(rows.map(row => [row.EventName, row.SearchTerm, row.ResultCount]), [['search', 'mine', 9]]);
  });

  await t.test('shared filters land on the notification fields', async (t) => {
    const seen = fakeStores(t);
    const res = await call('projectType=Energy-Electricity&sector=Coal&proponentName=BC%20Hydro&region=Peace&nameContains=lake');
    assert.strictEqual(res.status, 200);
    const sql = sqlOf(seen.notifications);
    for (const field of ['subType', 'proponent', 'region']) assert.match(sql, new RegExp(`c\\.${field} = @nf\\d`));
    assert.match(sql, /c\.type IN \(@nf\d_0, @nf\d_1\)/);
    assert.match(sql, /CONTAINS\(c\.name, @nc0, true\)/);
    const values = paramValues(seen.notifications);
    for (const value of ['Energy-Electricity', 'Energy - Electricity', 'Coal', 'BC Hydro', 'Peace', 'lake']) {
      assert.ok(values.includes(value), `${value} not bound`);
    }
  });

  for (const [qs, error, label = qs] of [
    ['foo=1', /unknown parameter: foo/],
    ['ids=p1', /unknown parameter: ids/],
    ['pcp=none', /pcp takes/],
    ['recordKind=project&recordKind=document', /recordKind takes/],
    [`recordKind=project&${Array.from({ length: 101 }, (_, i) => `decision=d${i}`).join('&')}`, /decision takes at most 100/,
      'recordKind=project with 101 decision values']
  ]) {
    await t.test(`${label} is refused before any read`, async (t) => {
      const seen = fakeStores(t);
      const res = await call(qs);
      assert.strictEqual(res.status, 400);
      assert.match(res.body.error, error);
      assert.strictEqual(seen.projects.length + seen.notifications.length, 0);
    });
  }

  await t.test('a notification field its dial hides stays hidden; decision and pcp are answered', async (t) => {
    fakeStores(t, { projects: [], notices: [notice('n1', 'Charlie', { vis: { proponent: 1 } })] });
    const res = await call('');
    assert.strictEqual(res.status, 200);
    const [row] = res.body;
    assert.strictEqual(row.recordKind, 'notification');
    assert.ok(!Object.hasOwn(row, 'proponentName'), JSON.stringify(row));
    assert.strictEqual(row.decision, 'Referred');
    assert.strictEqual(row.pcp, 'none');
    assert.strictEqual(row.projectType, 'Mines');
    assert.ok(!Object.hasOwn(row, 'read') && !Object.hasOwn(row, 'vis'), JSON.stringify(row));
  });

  await t.test('a project field its dial hides stays hidden; its other catalogued fields are answered', async (t) => {
    const row = { ...project('p1', 'Alpha'), proponentName: 'Teck', sector: 'Coal', vis: { proponentName: 1 } };
    fakeStores(t, { projects: [row], notices: [] });
    const res = await call('');
    assert.strictEqual(res.status, 200);
    const [out] = res.body;
    assert.strictEqual(out.recordKind, 'project');
    assert.ok(!Object.hasOwn(out, 'proponentName') && !Object.hasOwn(out, 'vis'), JSON.stringify(out));
    assert.strictEqual(out.sector, 'Coal');
  });

  for (const sort of ['dateUpdated', '-dateUpdated']) {
    await t.test(`sort=${sort} lists every project, then notifications by name`, async (t) => {
      const seen = fakeStores(t);
      const res = await call(`sort=${sort}`);
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(kinds(res.body), [...PROJECTS.map(() => 'project'), ...NOTICES.map(() => 'notification')]);
      assert.deepStrictEqual(res.body.slice(6).map(row => row.name), ['Charlie', 'Delta', 'Golf']);
      assert.match(sqlOf(seen.notifications), /ORDER BY c\.name ASC/);
    });
  }

  await t.test('a keyword list merges by name, not by rank', async (t) => {
    fakeStores(t, { projects: [...PROJECTS].reverse(), notices: [...NOTICES].reverse() });
    const res = await call('q=mine');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.map(row => row.id), MERGED_IDS);
  });

  await t.test('a page past the 1000-row fetch is exact for a credential; anonymous stops at 2000 rows', async (t) => {
    const many = Array.from({ length: 1200 }, (_, i) => project(`p${i}`, `P${String(i).padStart(4, '0')}`));
    const notices = [notice('n1', 'P0500x'), notice('n2', 'P1050x'), notice('n3', 'Z')];
    fakeStores(t, { projects: many, notices });
    const expected = [...many, ...notices].map(row => row.name).sort().slice(1000, 1100);

    const res = await call('page=11&pageSize=100', { user: STAFF });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.map(row => row.name), expected);

    const anonymous = await call('page=21&pageSize=100');
    assert.strictEqual(anonymous.status, 400);
    assert.match(anonymous.body.error, /within 2000 rows/);
  });

  await t.test('a null-name notification is first ascending and last descending', async (t) => {
    fakeStores(t, { notices: [notice('n0', null)] });
    const up = await call('sort=name');
    assert.strictEqual(up.body[0].id, 'n0');
    const down = await call('sort=-name');
    assert.strictEqual(down.body.at(-1).id, 'n0');
    assert.strictEqual(down.body[0].id, 'p6');
  });

  await t.test('sort=-name lists the merge descending, the project first on a tied name', async (t) => {
    fakeStores(t);
    const res = await call('sort=-name');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.map(row => row.id), ['p6', 'p5', 'n3', 'p4', 'p3', 'n2', 'n1', 'p2', 'p1']);
  });

  await t.test('an oversize notification read warns once per process, not once per read', async (t) => {
    const modulePath = require.resolve('../../../src/controllers/native/project-records');
    const cached = require.cache[modulePath];
    delete require.cache[modulePath];
    t.after(() => { require.cache[modulePath] = cached; });
    const fresh = require(modulePath).getProjectRecords;

    const warnings = [];
    t.mock.method(logger, 'warn', (message, meta) => { warnings.push({ message, meta }); });
    fakeStores(t, { notices: Array.from({ length: 501 }, (_, i) => notice(`n${i}`, `N${String(i).padStart(3, '0')}`)) });
    for (let read = 0; read < 2; read++) assert.strictEqual((await call('', { handler: fresh })).status, 200);
    assert.deepStrictEqual(warnings.filter(({ message }) => message.startsWith('[project-records]')).map(({ meta }) => meta), [{ rows: 501 }]);
  });

  await t.test('a search-service failure on a keyword list answers as /projects does', async (t) => {
    fakeStores(t);
    const failure = () => Object.assign(new Error('HTTP 403 [req-1]'), { status: 403, searchService: true });
    t.mock.method(aiSearch, 'searchProjects', async () => { throw failure(); });
    const union = await call('q=mine');
    const projects = await call('q=mine', { handler: projectController.getProjects });
    assert.strictEqual(union.status, 502);
    assert.strictEqual(union.status, projects.status);
    assert.deepStrictEqual(union.body, projects.body);
  });
});

test('swagger lists exactly the query parameters /project-records answers to', () => {
  const answered = [...queryNames(projectController.projectsKind).filter(name => name !== 'ids'), 'recordKind', 'decision'];
  assert.deepStrictEqual([...swaggerParams('/api/project-records').keys()].sort(), answered.sort());
});
