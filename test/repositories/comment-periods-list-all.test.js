'use strict';

/**
 * The unscoped period list and the project-name lookup behind its keywords, asserted on the SQL
 * and options each emits, one level above `cosmos.queryPage`.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const commentPeriods = require('../../src/repositories/comment-periods');
const projects = require('../../src/repositories/projects');
const { catalogFor } = require('../../src/vis/catalog');
const { logger } = require('../../src/utils/logger');
const { TIER, MAX_PAGE_SIZE } = require('../../src/helpers/access-sql');
const { bound } = require('../helpers/search-reads');

const ANON = { tier: TIER.PUBLIC, roles: ['public'], projectScope: null, teams: [], level: 4 };

const whereOf = (spec) => spec.query.replace(/^SELECT .*? FROM c WHERE /, '').replace(/ ORDER BY .*$/, '');

/** Capture every `queryPage` and `query` call, answering `pageItems` and `countValue`. */
function capture(t, { pageItems = [], countValue = 0 } = {}) {
  const seen = { pages: [], queries: [] };
  t.mock.method(cosmos, 'queryPage', async (container, spec, options) => {
    seen.pages.push({ container, spec, options });
    return pageItems;
  });
  t.mock.method(cosmos, 'query', async (container, spec, options) => {
    seen.queries.push({ container, spec, options });
    return { items: [countValue] };
  });
  return seen;
}

test('commentPeriods.listAll', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('pages in the query with bound OFFSET and LIMIT, drained to the page size', async () => {
    const seen = capture(t);

    await commentPeriods.listAll(ANON, { pageNum: 11, pageSize: 100 });

    const [{ spec, options }] = seen.pages;
    assert.match(spec.query, / ORDER BY c\.dateStarted DESC OFFSET @skip LIMIT @size$/);
    assert.deepStrictEqual([bound(spec)['@skip'], bound(spec)['@size']], [1100, 100]);
    assert.deepStrictEqual(options, { size: 100, skip: 1100 }, 'the skip sizes the drain bound');
  });

  await t.test('pageSize is clamped to MAX_PAGE_SIZE', async () => {
    const seen = capture(t);

    await commentPeriods.listAll(ANON, { pageNum: 2, pageSize: 5000 });

    const [{ spec, options }] = seen.pages;
    assert.deepStrictEqual([bound(spec)['@skip'], bound(spec)['@size']], [2 * MAX_PAGE_SIZE, MAX_PAGE_SIZE]);
    assert.strictEqual(options.size, MAX_PAGE_SIZE);
  });

  await t.test('the count uses the same predicate as the page, deleted rows excluded in both', async () => {
    const seen = capture(t, { countValue: 7 });
    const filters = { status: 'closed', keywords: 'wind', keywordProjectIds: ['207'], now: new Date() };

    await commentPeriods.listAll(ANON, { ...filters, pageSize: 10 });
    const total = await commentPeriods.countAll(ANON, filters);

    assert.strictEqual(total, 7);
    const page = seen.pages[0].spec;
    const count = seen.queries[0].spec;
    assert.strictEqual(whereOf(count), whereOf(page));
    assert.match(whereOf(page), /NOT \(IS_BOOL\(c\.isDeleted\) AND c\.isDeleted = true\)/);
    assert.deepStrictEqual(bound(count)['@keywordProjects'], ['207']);
  });

  await t.test('a keyword on a label this caller cannot see is refused', async (tt) => {
    const entry = catalogFor('commentPeriods').informationLabel;
    const saved = entry.defaultVis;
    entry.defaultVis = 2;
    tt.after(() => { entry.defaultVis = saved; });
    capture(tt);

    await assert.rejects(() => commentPeriods.listAll(ANON, { keywords: 'wind' }),
      /cannot filter on a field this caller cannot see: informationLabel/);
    await assert.rejects(() => commentPeriods.countAll(ANON, { keywords: 'wind' }),
      /cannot filter on a field this caller cannot see: informationLabel/);
  });
});

test('the open rail and its closed count exclude deleted periods', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const seen = capture(t);
  const now = new Date();

  await commentPeriods.listOpen(ANON, { now });
  await commentPeriods.countClosedSince(ANON, new Date(now.getTime() - 86400000), now);

  assert.strictEqual(seen.queries.length, 2);
  for (const { spec } of seen.queries) {
    assert.match(spec.query, /NOT \(IS_BOOL\(c\.isDeleted\) AND c\.isDeleted = true\)/);
  }
});

test('startOfPacificDay is the Pacific midnight of the Pacific date, across DST', () => {
  const cases = [
    ['2026-09-22T18:00:00Z', '2026-09-22T07:00:00.000Z'], // PDT
    ['2026-09-22T06:59:59Z', '2026-09-21T07:00:00.000Z'], // still the 21st in Vancouver
    ['2026-01-15T23:00:00Z', '2026-01-15T08:00:00.000Z'], // PST
    ['2026-03-08T12:00:00Z', '2026-03-08T08:00:00.000Z'], // DST starts at 02:00: midnight was PST
    ['2026-11-01T12:00:00Z', '2026-11-01T07:00:00.000Z'], // DST ends at 02:00: midnight was PDT
    ['2026-11-02T12:00:00Z', '2026-11-02T08:00:00.000Z']
  ];
  for (const [now, midnight] of cases) {
    assert.strictEqual(commentPeriods.startOfPacificDay(new Date(now)).toISOString(), midnight, now);
  }
});

test('projects.listIdsByName', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('is bounded, asking one past the cap so a cut is measured', async () => {
    const seen = capture(t, { pageItems: ['207', 208] });

    const ids = await projects.listIdsByName(ANON, 'wind');

    assert.deepStrictEqual(ids, ['207', '208']);
    const [{ spec, options }] = seen.pages;
    assert.match(spec.query, /CONTAINS\(c\.name, @name, true\)/);
    assert.strictEqual(bound(spec)['@name'], 'wind');
    assert.deepStrictEqual(options, { size: projects.NAME_MATCH_MAX_IDS + 1 });
  });

  await t.test('a match past the cap is cut to the cap and logged', async () => {
    const many = Array.from({ length: projects.NAME_MATCH_MAX_IDS + 1 }, (_, i) => String(i));
    capture(t, { pageItems: many });
    const warn = t.mock.method(logger, 'warn', () => {});

    const ids = await projects.listIdsByName(ANON, 'a');

    assert.strictEqual(ids.length, projects.NAME_MATCH_MAX_IDS);
    assert.strictEqual(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /name match cut at its id cap/);
  });

  await t.test('a name this caller cannot see is refused', async (tt) => {
    const entry = catalogFor('projects').name;
    const saved = entry.defaultVis;
    entry.defaultVis = 2;
    tt.after(() => { entry.defaultVis = saved; });
    capture(tt);

    await assert.rejects(() => projects.listIdsByName(ANON, 'wind'),
      /cannot filter on a field this caller cannot see: name/);
  });
});
