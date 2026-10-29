'use strict';

// `GET /projects` on the native list contract: the projects kind spec, driven through the real
// handler with the index faked at `searchProjects` and Cosmos at `query`.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const querystring = require('node:querystring');

require('../../../src/search/native-index');
const projectController = require('../../../src/controllers/nosql/project');
const organizations = require('../../../src/controllers/native/organizations');
const documentController = require('../../../src/controllers/nosql/document');
const updates = require('../../../src/controllers/native/updates');
const notifications = require('../../../src/controllers/native/notifications');
const aiSearch = require('../../../src/search/ai-search');
const cosmos = require('../../../src/db/cosmos-nosql');
const audit = require('../../../src/utils/audit');
const { makeRes } = require('../../../src/http/router');
const { recordEvents } = require('../../helpers/record-events');
const { swaggerParams, repeatableNames, queryNames } = require('../../helpers/swagger-params');
const { evaluate } = require('../../helpers/updates-store');
const { parseNativeQuery, nativeCriteria } = require('../../../src/helpers/native-query');

const ROWS = [{ id: 'p1', name: 'Mine One', read: ['public'] }, { id: 'p2', name: 'Mine Two', read: ['public'] }];

/** Fakes both stores and records what each was asked. */
function fakeStores(t) {
  const searches = [];
  const queries = [];
  t.mock.method(aiSearch, 'searchProjects', async (opts) => {
    searches.push(opts);
    return { count: 2, items: ROWS.map(row => ({ id: row.id })) };
  });
  t.mock.method(cosmos, 'query', async (container, spec) => {
    queries.push(spec);
    return spec.query.includes('COUNT(1)') ? { items: [ROWS.length] } : { items: structuredClone(ROWS) };
  });
  return { searches, queries };
}

function param(spec, name) {
  const found = spec.parameters.find(p => p.name === name);
  return found && found.value;
}

// The three List-ref filters as the query names them, and the id each asks for.
const REF_FILTERS = 'eacDecision=E1&currentPhaseName=P1&CEAAInvolvement=C1';
const DECIDED_2020 = 'decisionDateStart=2020-01-01&decisionDateEnd=2020-12-31';
const REF_FIELDS = { eacDecision: 'E1', currentPhaseName: 'P1', CEAAInvolvement: 'C1' };

/** Every List-ref filter and both decision-date edges, each inside the anonymous dial on its top-level field. */
function assertNarrowed(sql) {
  Object.entries(REF_FIELDS).forEach(([field, value], i) => {
    const clause = `((NOT IS_DEFINED(c.vis["${field}"]) OR c.vis["${field}"] >= 4) AND c.${field}._id = @nf${i})`;
    assert.ok(sql.query.includes(clause), `no ${clause} in ${sql.query}`);
    assert.strictEqual(param(sql, `@nf${i}`), value);
  });
  assert.ok(sql.query.includes('c.vis["decisionDate"]'), sql.query);
  assert.ok(sql.query.includes('c.decisionDate >= @nr0') && sql.query.includes('c.decisionDate <= @nr1'), sql.query);
  assert.strictEqual(param(sql, '@nr0'), '2020-01-01T00:00:00.000Z');
  assert.strictEqual(param(sql, '@nr1'), '2020-12-31T23:59:59.999Z');
}

// Every filter eagle-admin's project list multi-selects: query name, stored field, index column.
const REPEATABLE = [
  { name: 'projectType', field: 'projectType', column: 'type', values: ['Mines', 'Industrial'] },
  { name: 'region', field: 'region', column: 'region', values: ['Peace', 'Cariboo'] },
  { name: 'projectState', field: 'projectState', column: 'status', values: ['Active', 'Closed'] },
  { name: 'proponentName', field: 'proponentName', column: 'proponent', values: ['BC Hydro', 'Teck'] },
  { name: 'eacDecision', field: 'eacDecision._id', column: 'eacDecisionId', values: ['E1', 'E2'] },
  { name: 'currentPhaseName', field: 'currentPhaseName._id', column: 'currentPhaseNameId', values: ['P1', 'P2'] },
  { name: 'CEAAInvolvement', field: 'CEAAInvolvement._id', column: 'ceaaInvolvementId', values: ['C1', 'C2'] }
];

/** `field` matches either value, inside the anonymous dial on its top-level field. */
function assertEither(sql, field, values) {
  const top = field.split('.')[0];
  const clause = `((NOT IS_DEFINED(c.vis["${top}"]) OR c.vis["${top}"] >= 4) AND c.${field} IN (@nf0_0, @nf0_1))`;
  assert.ok(sql.query.includes(clause), `no ${clause} in ${sql.query}`);
  assert.deepStrictEqual([param(sql, '@nf0_0'), param(sql, '@nf0_1')], values);
}

/** A search-service failure whose body quotes the `$filter`, ACL clause included. */
function serviceFailure(status) {
  return Object.assign(
    new Error(`HTTP ${status} Invalid expression: search.in(acl, 'public,staff', ',') [req-1]`),
    { status, searchService: true });
}

async function call(qs) {
  const req = { query: querystring.parse(qs), params: {}, headers: {}, header: () => undefined };
  const res = makeRes('test');
  await projectController.getProjects(req, res);
  return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : undefined };
}

test('GET /projects native list', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a keyword list logs one search event for the projects kind', async (t) => {
    fakeStores(t);
    const events = recordEvents(t);

    const res = await call('q=mine&count=true');
    assert.strictEqual(res.status, 200);

    const [search] = await events(audit.EVENTS_STREAM);
    assert.strictEqual(search.EventName, 'search');
    assert.strictEqual(search.SearchTerm, 'mine');
    assert.strictEqual(search.Detail.kind, 'projects');
  });

  await t.test('continuationToken is refused; paging is by page', async (t) => {
    fakeStores(t);
    const res = await call('continuationToken=abc');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /unknown parameter: continuationToken/);
  });

  await t.test('a filter not marked repeatable given twice is refused before any read', async (t) => {
    const { searches, queries } = fakeStores(t);
    const res = await call('regionalDistrict=Peace%20River&regionalDistrict=Cariboo');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'parameter given more than once: regionalDistrict');
    assert.strictEqual(searches.length + queries.length, 0);
  });

  await t.test('more than 100 values for one filter are refused before any read', async (t) => {
    const { searches, queries } = fakeStores(t);
    const many = Array.from({ length: 101 }, (_, i) => `region=r${i}`).join('&');
    const res = await call(many);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'region takes at most 100 values');
    assert.strictEqual(searches.length + queries.length, 0);
  });

  await t.test('a value repeated past the cap counts once', async (t) => {
    const { queries } = fakeStores(t);
    const res = await call(Array.from({ length: 150 }, () => 'region=Peace').join('&'));
    assert.strictEqual(res.status, 200);
    assert.ok(queries[0].query.includes('c.region = @nf0'), queries[0].query);
    assert.strictEqual(param(queries[0], '@nf0'), 'Peace');
  });

  await t.test('a search-service 400 answers a fixed message, never the service body', async (t) => {
    fakeStores(t);
    t.mock.method(aiSearch, 'searchProjects', async () => { throw serviceFailure(400); });
    const res = await call('q=mine');
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(res.body, { error: 'The search service could not run this query.' });
  });

  await t.test('any other search-service failure is a 502 with a fixed message', async (t) => {
    fakeStores(t);
    t.mock.method(aiSearch, 'searchProjects', async () => { throw serviceFailure(403); });
    const res = await call('q=mine');
    assert.strictEqual(res.status, 502);
    assert.deepStrictEqual(res.body, { error: 'The search service is unavailable.' });
  });

  for (const { name, field, column, values } of REPEATABLE) {
    const qs = values.map(value => `${name}=${encodeURIComponent(value)}`).join('&');

    await t.test(`${name} given twice matches either value in Cosmos`, async (t) => {
      const { searches, queries } = fakeStores(t);
      const res = await call(`${qs}&count=true`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(searches.length, 0);
      assert.strictEqual(queries.length, 2);
      assertEither(queries[0], field, values);
      assertEither(queries[1], field, values);
    });

    await t.test(`${name} given twice with q matches either value in the index, and Cosmos re-checks`, async (t) => {
      const { searches, queries } = fakeStores(t);
      const res = await call(`q=mine&${qs}`);
      assert.strictEqual(res.status, 200);
      assert.ok(searches[0].filter.includes(`search.in(${column}, '${values.join(',')}', ',')`), searches[0].filter);
      assertEither(queries[0], field, values);
    });
  }

  // DEMI holds Track's spelling for Track-backed projects and Eagle's for Eagle-only ones, so a
  // type in either spelling must reach both. Literals written out, not read from the alias table.
  await t.test('a project type in either spelling matches both spellings in Cosmos', async (t) => {
    const { searches, queries } = fakeStores(t);
    const res = await call('projectType=Energy-Electricity&projectType=Tourist%20Destination%20Resort&count=true');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(searches.length, 0);
    for (const sql of queries) {
      assert.ok(sql.query.includes('c.projectType IN (@nf0_0, @nf0_1, @nf0_2, @nf0_3)'), sql.query);
      assert.deepStrictEqual([0, 1, 2, 3].map(i => param(sql, `@nf0_${i}`)), [
        'Energy-Electricity', 'Energy - Electricity', 'Tourist Destination Resort', 'Tourist Destination Resorts'
      ]);
    }
  });

  await t.test('a project type in either spelling matches both spellings in the index, and Cosmos re-checks', async (t) => {
    const { searches, queries } = fakeStores(t);
    const res = await call('q=mine&projectType=Energy%20-%20Petroleum%20%26%20Natural%20Gas');
    assert.strictEqual(res.status, 200);
    assert.ok(searches[0].filter.includes(
      "search.in(type, 'Energy - Petroleum & Natural Gas,Energy-Petroleum & Natural Gas', ',')"), searches[0].filter);
    assert.ok(queries[0].query.includes('c.projectType IN (@nf0_0, @nf0_1)'), queries[0].query);
    assert.deepStrictEqual([param(queries[0], '@nf0_0'), param(queries[0], '@nf0_1')],
      ['Energy - Petroleum & Natural Gas', 'Energy-Petroleum & Natural Gas']);
  });

  await t.test('the 100-value cap counts the values sent, not the spellings they expand to', async (t) => {
    const { queries } = fakeStores(t);
    const sent = ['Energy-Electricity', ...Array.from({ length: 99 }, (_, i) => `t${i}`)];
    const res = await call(sent.map(v => `projectType=${encodeURIComponent(v)}`).join('&'));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(param(queries[0], '@nf0_1'), 'Energy - Electricity');
    assert.strictEqual(param(queries[0], '@nf0_100'), 't98');
  });

  await t.test('a proponent name with a comma splits into eq terms, not a search.in list', async (t) => {
    const { searches } = fakeStores(t);
    const res = await call('q=mine&proponentName=Teck%2C%20Inc.&proponentName=BC%20Hydro');
    assert.strictEqual(res.status, 200);
    assert.ok(searches[0].filter.includes("(proponent eq 'Teck, Inc.' or proponent eq 'BC Hydro')"), searches[0].filter);
  });

  await t.test('with no q, List-ref filters and decision-date edges narrow the Cosmos read', async (t) => {
    const { searches, queries } = fakeStores(t);
    const res = await call(`${REF_FILTERS}&${DECIDED_2020}&count=true`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(searches.length, 0);
    assert.strictEqual(queries.length, 2);
    for (const sql of queries) assertNarrowed(sql);
  });

  await t.test('with q, the index filters on its id and date columns and Cosmos re-checks each', async (t) => {
    const { searches, queries } = fakeStores(t);
    const res = await call(`q=mine&${REF_FILTERS}&${DECIDED_2020}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(searches.length, 1);
    const { filter } = searches[0];
    for (const clause of [
      "(eacDecisionId eq 'E1')", "(currentPhaseNameId eq 'P1')", "(ceaaInvolvementId eq 'C1')",
      '(decisionDate ge 2020-01-01T00:00:00.000Z)', '(decisionDate le 2020-12-31T23:59:59.999Z)'
    ]) {
      assert.ok(filter.includes(clause), `index filter lacks ${clause}: ${filter}`);
    }
    assert.strictEqual(queries.length, 1);
    assertNarrowed(queries[0]);
  });

  await t.test('the stored path is not a query name; the field name is', async (t) => {
    const { queries } = fakeStores(t);
    const res = await call('eacDecision._id=E1');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'unknown parameter: eacDecision._id');
    assert.strictEqual(queries.length, 0);
  });

  await t.test('a decision-date edge that is not a calendar day is refused', async (t) => {
    const { queries } = fakeStores(t);
    const res = await call('decisionDateEnd=2020-02-30');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'decisionDateEnd takes one day as YYYY-MM-DD');
    assert.strictEqual(queries.length, 0);
  });
});

// A Track-only row: upsert writes its absent phase as `{_id: null, name: null}`, so the phase sort keeps it.
const NO_PHASE = { id: 'p3', name: 'Lng Three', currentPhaseName: { _id: null, name: null }, read: ['public'] };

/** `fakeStores` with `rows` in Cosmos, which honours a `CONTAINS(c.name, @nc0, true)` clause as Cosmos would. */
function fakeNameMatch(t, rows) {
  const searches = [];
  const queries = [];
  t.mock.method(aiSearch, 'searchProjects', async (opts) => {
    searches.push(opts);
    return { count: rows.length, items: rows.map(row => ({ id: row.id })) };
  });
  t.mock.method(cosmos, 'query', async (container, spec) => {
    queries.push(spec);
    const text = spec.query.includes('CONTAINS(c.name, @nc0, true)') ? param(spec, '@nc0').toLowerCase() : '';
    const matched = rows.filter(row => row.name.toLowerCase().includes(text));
    return spec.query.includes('COUNT(1)') ? { items: [matched.length] } : { items: structuredClone(matched) };
  });
  return { searches, queries };
}

test('GET /projects sector, last-updated and name filters', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const QS = 'sector=a&sector=b&sort=-dateUpdated&dateUpdatedStart=2026-01-01&nameContains=lng&count=true';

  await t.test('sector given twice, a last-updated edge and a name text narrow the Cosmos read and count', async (t) => {
    const { searches, queries } = fakeNameMatch(t, [...ROWS, NO_PHASE]);
    const res = await call(QS);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(searches.length, 0);
    assert.deepStrictEqual(res.body.map(row => row.id), ['p3']);
    assert.strictEqual(res.headers['x-total-count'], '1');
    assert.strictEqual(queries.length, 2);
    for (const sql of queries) {
      assert.ok(sql.query.includes(
        '((NOT IS_DEFINED(c.vis["sector"]) OR c.vis["sector"] >= 4) AND c.sector IN (@nf0_0, @nf0_1))'), sql.query);
      assert.deepStrictEqual([param(sql, '@nf0_0'), param(sql, '@nf0_1')], ['a', 'b']);
      assert.ok(sql.query.includes(
        '((NOT IS_DEFINED(c.vis["dateUpdated"]) OR c.vis["dateUpdated"] >= 4) AND c.dateUpdated >= @nr0)'), sql.query);
      assert.strictEqual(param(sql, '@nr0'), '2026-01-01T00:00:00.000Z');
      assert.ok(sql.query.includes('((NOT IS_DEFINED(c.vis["name"]) OR c.vis["name"] >= 4) AND CONTAINS(c.name, @nc0, true))'),
        sql.query);
      assert.strictEqual(param(sql, '@nc0'), 'lng');
    }
    assert.match(queries.find(sql => !sql.query.includes('COUNT(1)')).query, /ORDER BY c\.dateUpdated DESC/);
  });

  await t.test('the last-updated end edge takes the whole day', async (t) => {
    const { queries } = fakeStores(t);
    const res = await call('dateUpdatedEnd=2026-03-31');
    assert.strictEqual(res.status, 200);
    assert.ok(queries[0].query.includes('c.dateUpdated <= @nr0'), queries[0].query);
    assert.strictEqual(param(queries[0], '@nr0'), '2026-03-31T23:59:59.999Z');
  });

  await t.test('with q, the Cosmos re-read keeps only rows whose name holds the text', async (t) => {
    const { searches, queries } = fakeNameMatch(t, ROWS);
    const res = await call('q=mine&nameContains=TWO');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(searches[0].keywords, 'mine');
    assert.deepStrictEqual(res.body.map(row => row.id), ['p2']);
    assert.ok(!queries[0].query.includes('@nq'), `the keyword was re-matched in Cosmos: ${queries[0].query}`);
  });

  await t.test('sort=currentPhaseName.name orders on the phase name and keeps a row with no phase', async (t) => {
    const { queries } = fakeNameMatch(t, [NO_PHASE, ...ROWS]);
    const res = await call('sort=currentPhaseName.name');
    assert.strictEqual(res.status, 200);
    assert.match(queries[0].query, /ORDER BY c\.currentPhaseName\.name ASC$/);
    assert.deepStrictEqual(res.body[0].currentPhaseName, { _id: null, name: null });
  });

  await t.test('sort=currentPhaseName.name with q orders the re-read on the phase name and keeps a row with no phase', async (t) => {
    const { searches, queries } = fakeNameMatch(t, [NO_PHASE, ...ROWS]);
    const res = await call('q=mine&sort=-currentPhaseName.name');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(searches.length, 1);
    assert.match(queries[0].query, /ORDER BY c\.currentPhaseName\.name DESC$/);
    assert.deepStrictEqual(res.body.map(row => row.id), ['p3', 'p1', 'p2']);
  });

  await t.test('the stored phase object is not a sort key; its name is', async (t) => {
    const { queries } = fakeStores(t);
    const res = await call('sort=currentPhaseName');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'cannot sort on: currentPhaseName');
    assert.strictEqual(queries.length, 0);
  });

  for (const key of ['dateUpdated', 'proponentName', 'projectType', 'sector', 'region']) {
    await t.test(`sort=${key} orders the Cosmos read on ${key}`, async (t) => {
      const { queries } = fakeStores(t);
      const res = await call(`sort=${key}`);
      assert.strictEqual(res.status, 200);
      assert.match(queries[0].query, new RegExp(`ORDER BY c\\.${key} ASC$`));
    });
  }
});

// Cariboo's shape: the current block is 2018, and `phaseIds` also holds the phase its 2002 block reached.
const PHASED = [
  { id: 'cariboo', currentPhaseName: { _id: 'ph2018' }, phaseIds: ['ph2002', 'ph2018'] },
  { id: 'new', currentPhaseName: { _id: 'ph2018' }, phaseIds: ['ph2018'] },
  { id: 'dialled', currentPhaseName: { _id: 'ph2018' }, phaseIds: ['ph2002', 'ph2018'], vis: { phaseIds: 2 } },
  { id: 'unbuilt', currentPhaseName: { _id: 'ph2002' } }
];

/** The PHASED rows the projects kind's criteria for `query` keep, for an anonymous caller. */
function phaseMatches(query) {
  const parsed = parseNativeQuery(projectController.projectsKind, query, null);
  assert.ok(!parsed.error, parsed.error);
  const { criteria } = nativeCriteria(projectController.projectsKind, parsed, null);
  const params = Object.fromEntries(criteria.flatMap(c => c.params).map(p => [p.name, p.value]));
  return PHASED.filter(row => criteria.every(c => evaluate(c.clause, row, params))).map(row => row.id);
}

test('phaseIds filter matches a project whose 2002 block held the phase', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('one phase id keeps the row whose older block held it, not one that never did', () => {
    assert.deepStrictEqual(phaseMatches({ phaseIds: 'ph2002' }), ['cariboo']);
  });

  await t.test('several phase ids keep a row holding any of them', () => {
    assert.deepStrictEqual(phaseMatches({ phaseIds: ['ph1996', 'ph2002'] }), ['cariboo']);
  });

  await t.test('currentPhaseName still matches the current block only', () => {
    assert.deepStrictEqual(phaseMatches({ currentPhaseName: 'ph2002' }), ['unbuilt']);
  });

  await t.test('with q, the index filter and the Cosmos re-read both ask for any of the phases', async (t) => {
    const { searches, queries } = fakeStores(t);
    const res = await call('q=mine&phaseIds=a&phaseIds=b');
    assert.strictEqual(res.status, 200);
    assert.ok(searches[0].filter.includes("(phaseIds/any(p: search.in(p, 'a,b', ',')))"), searches[0].filter);
    assert.ok(queries[0].query.includes('((NOT IS_DEFINED(c.vis["phaseIds"]) OR c.vis["phaseIds"] >= 4) AND ' +
      'EXISTS(SELECT VALUE p FROM p IN c.phaseIds WHERE p IN (@na0_0, @na0_1)))'), queries[0].query);
    assert.deepStrictEqual([param(queries[0], '@na0_0'), param(queries[0], '@na0_1')], ['a', 'b']);
  });
});

const LIST_ROUTES = [
  ['/api/projects', projectController.projectsKind],
  ['/api/organizations', organizations.SPEC],
  ['/api/documents', documentController.documentsKind],
  ['/api/updates', updates.SPEC],
  ['/api/notifications', notifications.SPEC]
];

test('swagger lists exactly the query parameters each list route answers to', async (t) => {
  for (const [route, spec] of LIST_ROUTES) {
    await t.test(route, () => {
      assert.deepStrictEqual([...swaggerParams(route).keys()].sort(), queryNames(spec));
    });
  }
});

test('swagger declares every repeatable filter as an exploded array', async (t) => {
  for (const [route, spec] of LIST_ROUTES) {
    await t.test(route, () => {
      const params = swaggerParams(route);
      const notArrays = repeatableNames(spec).filter(name =>
        !/type: array/.test(params.get(name) || '') || !/explode: true/.test(params.get(name) || ''));
      assert.deepStrictEqual(notArrays, []);
    });
  }
});

test('swagger offers each sort key both ways, and no other', async (t) => {
  for (const [route, spec] of LIST_ROUTES) {
    await t.test(route, () => {
      const offered = swaggerParams(route).get('sort').match(/enum: \[([^\]]*)\]/)[1].split(/,\s*/);
      assert.deepStrictEqual(offered.sort(), spec.sortKeys.flatMap(key => [key, `-${key}`]).sort());
    });
  }
});
