'use strict';

// Native comment period and comment reads, driven through the real handlers and repositories over a
// fake Cosmos that applies the role arm and the equality and IN clauses of each query, so what a
// caller may see is observed in the response.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const querystring = require('node:querystring');

const periodsController = require('../../../src/controllers/native/comment-periods');
const commentsController = require('../../../src/controllers/native/comments');
const cosmos = require('../../../src/db/cosmos-nosql');
const audit = require('../../../src/utils/audit');
const projects = require('../../../src/repositories/projects');
const { makeRes } = require('../../../src/http/router');
const { recordEvents } = require('../../helpers/record-events');

const STAFF = { realm_access: { roles: ['staff'] } };

const PERIOD_EAGLE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

const CONTAINERS = {
  commentPeriods: [
    { id: 'cp1', eagleId: PERIOD_EAGLE_ID, projectId: 'p1', read: ['public'], instructions: 'Open period' },
    { id: 'cp-staff', projectId: 'p1', read: ['staff'], instructions: 'Staff only' }
  ],
  // Two public comments, three staff-only; `author` on an unattributed comment is level 2.
  comments: [
    { id: 'c1', periodId: 'cp1', projectId: 'p1', read: ['public'], eaoStatus: 'Published', comment: 'Fish', author: 'Pat Hidden', isAnonymous: true },
    { id: 'c2', periodId: 'cp1', projectId: 'p1', read: ['public'], eaoStatus: 'Published', comment: 'Roads', author: 'Lee', isAnonymous: false },
    { id: 'c3', periodId: 'cp1', projectId: 'p1', read: ['staff'], eaoStatus: 'Pending', comment: 'Noise' },
    { id: 'c4', periodId: 'cp1', projectId: 'p1', read: ['staff'], eaoStatus: 'Rejected', comment: 'Spam' },
    { id: 'c5', periodId: 'cp1', projectId: 'p1', read: ['staff'], eaoStatus: 'Deferred', comment: 'Later' }
  ]
};

const PROJECT = { id: 'p1', name: 'Site C', eagleId: 'bbbbbbbbbbbbbbbbbbbbbbbb', read: ['public'] };

function param(spec, name) {
  const found = spec.parameters.find(p => p.name === name);
  return found && found.value;
}

/** Rows of `container` the query admits: its role arm, `c.f = @p` and `c.f IN (@p, ...)` clauses. */
function admitted(container, spec) {
  const roles = spec.parameters.filter(p => p.name.startsWith('@role')).map(p => p.value);
  const tests = [];
  for (const [, field, name] of spec.query.matchAll(/c\.(\w+) = (@\w+)/g)) {
    tests.push(row => row[field] === param(spec, name));
  }
  for (const [, field, names] of spec.query.matchAll(/c\.(\w+) IN \(([@\w, ]+)\)/g)) {
    const values = names.split(', ').map(name => param(spec, name));
    tests.push(row => values.includes(row[field]));
  }
  return CONTAINERS[container]
    .filter(row => row.read.some(r => roles.includes(r)))
    .filter(row => tests.every(match => match(row)));
}

function fakeCosmos(t) {
  const specs = [];
  t.mock.method(cosmos, 'query', async (container, spec) => {
    specs.push(spec);
    const rows = admitted(container, spec);
    return { items: spec.query.includes('COUNT(1)') ? [rows.length] : rows };
  });
  t.mock.method(cosmos, 'queryFirst', async (container, spec) => {
    specs.push(spec);
    return admitted(container, spec)[0] || null;
  });
  t.mock.method(projects, 'listRowsByIds', async () => [structuredClone(PROJECT)]);
  return specs;
}

async function call(handler, qs, { user, id } = {}) {
  const req = { query: querystring.parse(qs), params: { id }, headers: {}, header: () => undefined, user };
  const res = makeRes('test');
  await handler(req, res);
  return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : undefined };
}

test('comment period summary', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const summary = periodsController.getCommentPeriodSummary;

  await t.test('anonymous counts only the comments it may read, per eaoStatus', async (t) => {
    fakeCosmos(t);
    const res = await call(summary, '', { id: 'cp1' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, {
      id: 'cp1', total: 2, eaoStatus: { Pending: 0, Published: 2, Rejected: 0, Deferred: 0 }
    });
  });

  await t.test('staff counts every status', async (t) => {
    fakeCosmos(t);
    const res = await call(summary, '', { id: 'cp1', user: STAFF });
    assert.deepStrictEqual(res.body.eaoStatus, { Pending: 1, Published: 2, Rejected: 1, Deferred: 1 });
    assert.strictEqual(res.body.total, 5);
    assert.strictEqual(res.headers['cache-control'], 'private, no-store');
  });

  await t.test('the period is found by its Eagle id too', async (t) => {
    fakeCosmos(t);
    const res = await call(summary, '', { id: PERIOD_EAGLE_ID });
    assert.strictEqual(res.body.id, 'cp1');
  });

  await t.test('a period the caller cannot read is a 404 and nothing is counted', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call(summary, '', { id: 'cp-staff' });
    assert.strictEqual(res.status, 404);
    assert.ok(!specs.some(spec => spec.query.includes('COUNT(1)')));
  });

  await t.test('a query parameter is refused', async (t) => {
    fakeCosmos(t);
    assert.strictEqual((await call(summary, 'eaoStatus=Pending', { id: 'cp1' })).status, 400);
  });
});

test('native comment periods', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const list = periodsController.getCommentPeriods;

  await t.test('project= filters projectId and joins the project name', async (t) => {
    fakeCosmos(t);
    const res = await call(list, 'project=p1');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.map(row => [row.id, row.projectName]), [['cp1', 'Site C']]);
  });

  await t.test('the field spelling projectId is not a parameter', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call(list, 'projectId=p1');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'unknown parameter: projectId');
    assert.strictEqual(specs.length, 0);
  });

  await t.test('repeated status values are ORed into one clause', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call(list, 'status=open&status=closed');
    assert.strictEqual(res.status, 200);
    const query = specs[0].query;
    assert.match(query, /c\.dateStarted <= @now AND .* OR \(c\.dateCompleted < @now/);
    assert.match(query, /NOT \(IS_BOOL\(c\.isDeleted\) AND c\.isDeleted = true\)/);
  });

  await t.test('an unknown status is refused before any read', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call(list, 'status=archived');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(specs.length, 0);
  });

  await t.test('a repeated project is refused', async (t) => {
    fakeCosmos(t);
    const res = await call(list, 'project=p1&project=p2');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'parameter given more than once: project');
  });
});

test('native comments', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const list = commentsController.getComments;
  const get = commentsController.getComment;

  await t.test('anonymous by-id leaves out an unattributed author', async (t) => {
    fakeCosmos(t);
    const res = await call(get, '', { id: 'c1' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.comment, 'Fish');
    assert.strictEqual(res.body.projectName, 'Site C');
    assert.ok(!('author' in res.body), JSON.stringify(res.body));
  });

  await t.test('staff by-id reads the same author', async (t) => {
    fakeCosmos(t);
    const res = await call(get, '', { id: 'c1', user: STAFF });
    assert.strictEqual(res.body.author, 'Pat Hidden');
  });

  await t.test('a comment the caller cannot read is a 404', async (t) => {
    fakeCosmos(t);
    assert.strictEqual((await call(get, '', { id: 'c3' })).status, 404);
  });

  await t.test('period= filters periodId and eaoStatus may repeat', async (t) => {
    fakeCosmos(t);
    const res = await call(list, 'period=cp1&eaoStatus=Pending&eaoStatus=Rejected', { user: STAFF });
    assert.deepStrictEqual(res.body.map(row => row.id).sort(), ['c3', 'c4']);
  });

  await t.test('the field spellings periodId and projectId are not parameters', async (t) => {
    const specs = fakeCosmos(t);
    const period = await call(list, 'periodId=cp1');
    const project = await call(list, 'projectId=p1');
    assert.strictEqual(period.body.error, 'unknown parameter: periodId');
    assert.strictEqual(project.body.error, 'unknown parameter: projectId');
    assert.strictEqual(specs.length, 0);
  });

  await t.test('project= filters projectId', async (t) => {
    const specs = fakeCosmos(t);
    assert.strictEqual((await call(list, 'project=p1')).status, 200);
    const listSpec = specs.find(spec => !spec.query.includes('COUNT(1)'));
    assert.match(listSpec.query, /c\.projectId = @nf0/);
  });

  await t.test('count=true on a hidden field is refused for anonymous, with no read', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call(list, 'author=Pat&count=true');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.headers['x-total-count'], undefined);
    assert.strictEqual(specs.length, 0);
  });

  await t.test('q matches the comment text only, never the author', async (t) => {
    const specs = fakeCosmos(t);
    await call(list, 'q=Pat', { user: STAFF });
    const listSpec = specs.find(spec => !spec.query.includes('COUNT(1)'));
    assert.match(listSpec.query, /CONTAINS\(c\.comment, @nq, true\)/);
    assert.doesNotMatch(listSpec.query, /CONTAINS\(c\.author/);
  });

  await t.test('q on comments is not recorded as a search event', async (t) => {
    fakeCosmos(t);
    const events = recordEvents(t);
    await call(list, 'q=Pat', { user: STAFF });
    assert.deepStrictEqual(await events(audit.EVENTS_STREAM), []);
  });
});

test('read audit', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const READS = [
    [commentsController.getComments, '', undefined],
    [commentsController.getComment, '', 'c1'],
    [periodsController.getCommentPeriods, '', undefined],
    [periodsController.getCommentPeriod, '', 'cp1'],
    [periodsController.getCommentPeriodSummary, '', 'cp1']
  ];

  await t.test('anonymous reads leave no audit row', async (t) => {
    fakeCosmos(t);
    const events = recordEvents(t);
    for (const [handler, qs, id] of READS) await call(handler, qs, { id });
    assert.deepStrictEqual(await events(audit.AUDIT_STREAM), []);
  });

  await t.test('authenticated reads leave one audit row each', async (t) => {
    fakeCosmos(t);
    const events = recordEvents(t);
    for (const [handler, qs, id] of READS) await call(handler, qs, { id, user: STAFF });
    const rows = await events(audit.AUDIT_STREAM);
    assert.deepStrictEqual(rows.map(row => [row.Action, row.TargetId || null]), [
      ['comments.list', null],
      ['comments.read', 'c1'],
      ['commentPeriods.list', null],
      ['commentPeriods.read', 'cp1'],
      ['commentPeriods.summary', 'cp1']
    ]);
  });
});
