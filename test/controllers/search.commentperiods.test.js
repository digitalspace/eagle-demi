'use strict';

/**
 * `GET /search?dataset=CommentPeriod` with no project — the home page's `open` rail and the search
 * page's paged list.
 *
 * Both sweep every partition, so the caller's visibility predicate is the whole defence and the
 * cases below check it by looking at the SQL the request actually emitted.
 *
 * Harness, stub points and row fixtures: `test/helpers/search-reads.js`.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { logger } = require('../../src/utils/logger');
const {
  PROJECT_EAGLE_ID, PERIOD_EAGLE_ID, PUBLIC_ACL, PRIVATE_ACL, PROJECT_ROW,
  stubCosmos, stubPeriods, specsFor, boundValues, bound, get, getAsStaff, periodRow
} = require('../helpers/search-reads');

const OPEN = '/api/search?dataset=CommentPeriod&and%5Bstatus%5D=open';
const LIST = '/api/search?dataset=CommentPeriod';

/** `days` from now, as the mirror stores a date. */
const daysOut = (days) => new Date(Date.now() + days * 86400000).toISOString();

/**
 * Three periods on the same project, one in each state — the whole point of the filter.
 *
 * The dates are relative to the run, not fixed strings: a fixture pinned to 2026 stops testing
 * anything the day the window moves past it, and "open" is a question about now.
 */
const NOT_STARTED = periodRow({
  id: 'CP-future', eagleId: 'CP-future',
  dateStarted: daysOut(3), dateCompleted: daysOut(30)
});
const OPEN_NOW = periodRow({
  id: PERIOD_EAGLE_ID,
  dateStarted: daysOut(-3), dateCompleted: daysOut(10)
});
const CLOSED = periodRow({
  id: 'CP-past', eagleId: 'CP-past',
  dateStarted: daysOut(-40), dateCompleted: daysOut(-5)
});
const STATE_ROWS = [NOT_STARTED, OPEN_NOW, CLOSED];

/** A period with no start date: eagle-public's `getStatusCode` gives it no status at all. */
const UNDATED = periodRow({ id: 'CP-undated', eagleId: 'CP-undated', dateStarted: null });

/**
 * The stub honours a `partitionKey` but not a WHERE clause, so a date predicate has to be read out
 * of the emitted SQL rather than out of the rows served. This runs the real criterion over the
 * fixtures the way Cosmos would, which is what makes "excludes the closed one" an assertion about
 * the query instead of about the stub.
 */
function applyOpenPredicate(spec, rows) {
  const { '@now': now, '@closingDayStart': dayStart, '@closingDayEnd': dayEnd } = bound(spec);
  assert.ok(now && dayStart && dayEnd, 'the open read must bind @now and the closing day, not interpolate them');
  assert.match(spec.query, /c\.dateStarted <= @now AND \(c\.dateCompleted >= @now OR \(c\.dateCompleted >= @closingDayStart AND c\.dateCompleted < @closingDayEnd\)\)/);
  return rows.filter(r => r.dateStarted <= now &&
    (r.dateCompleted >= now || (r.dateCompleted >= dayStart && r.dateCompleted < dayEnd)));
}

/** Runs the emitted status clause over the fixtures the way Cosmos would; `null` never compares. */
function applyStatusPredicate(spec, rows) {
  const { '@now': now, '@closingDayStart': dayStart, '@closingDayEnd': dayEnd } = bound(spec);
  assert.ok(now, 'the status clause must bind a single @now');
  const cmp = (a, op, b) => typeof a === 'string' && typeof b === 'string' &&
    (op === '>' ? a > b : a < b);
  if (/c\.dateStarted > @now AND IS_STRING\(c\.dateCompleted\)/.test(spec.query)) {
    return rows.filter(r => cmp(r.dateStarted, '>', now) && typeof r.dateCompleted === 'string');
  }
  if (/c\.dateCompleted < @now AND NOT \(c\.dateCompleted >= @closingDayStart AND c\.dateCompleted < @closingDayEnd\) AND IS_STRING\(c\.dateStarted\)/.test(spec.query)) {
    assert.ok(dayStart && dayEnd, 'the closed clause must bind the closing day');
    return rows.filter(r => cmp(r.dateCompleted, '<', now) && typeof r.dateStarted === 'string' &&
      !(r.dateCompleted >= dayStart && r.dateCompleted < dayEnd));
  }
  throw new Error(`no status clause in: ${spec.query}`);
}

/** Runs the emitted keyword clause over the fixtures: label substring, or a name-matched project. */
function applyKeywordPredicate(spec, rows) {
  assert.match(spec.query,
    /\(CONTAINS\(c\.informationLabel, @keywords, true\) OR ARRAY_CONTAINS\(@keywordProjects, c\.projectId\)\)/);
  const params = bound(spec);
  const text = params['@keywords'].toLowerCase();
  return rows.filter(r => r.informationLabel.toLowerCase().includes(text) ||
    params['@keywordProjects'].includes(r.projectId));
}

test('GET /search?dataset=CommentPeriod&and[status]=open', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('the predicate admits the open period and neither of its neighbours', async () => {
    const seen = stubPeriods(t, STATE_ROWS);

    const { status } = await get(OPEN);

    assert.strictEqual(status, 200);
    const [read] = specsFor(seen, 'commentPeriods');
    assert.deepStrictEqual(applyOpenPredicate(read, STATE_ROWS).map(r => r.id), [PERIOD_EAGLE_ID],
      'a period that has not started, and one that has closed, are both outside the window');
    // Soonest to close first: the rail's whole ordering claim, and a key `SORTABLE` already allows.
    assert.match(read.query, /ORDER BY c\.dateCompleted ASC$/);
  });

  await t.test('it is cross-partition, and capped rather than paged', async () => {
    const seen = stubPeriods(t, [OPEN_NOW]);

    await get(`${OPEN}&pageSize=7`);

    const [{ options }] = seen.filter(s => s.container === 'commentPeriods');
    assert.strictEqual(options.partitionKey, undefined,
      '"open" is not a property of any one project, so this read cannot bind a parent');
    // An absent maxItemCount puts cosmos.query on the fetchAll path, which drains every partition.
    assert.strictEqual(options.maxItemCount, 7);
  });

  await t.test('the caller ACL reaches Cosmos on the open read and on the closed count', async () => {
    const seen = stubPeriods(t, [OPEN_NOW]);

    await get(OPEN);

    const specs = specsFor(seen, 'commentPeriods');
    assert.strictEqual(specs.length, 2, 'the list and the count are two reads');
    for (const spec of specs) {
      assert.ok(boundValues(spec).includes('public'),
        'the anonymous ACL must be in every cross-partition predicate');
    }
  });

  // A cross-partition read is where an ACL slip stops being one project's problem, so this is the
  // case that matters most: the same URL, two callers, two different corpora.
  await t.test('a private period is withheld from the public and answered to staff', async () => {
    const privatePeriod = periodRow({
      id: 'CP-private', eagleId: 'CP-private',
      dateStarted: daysOut(-1), dateCompleted: daysOut(5),
      read: PRIVATE_ACL, isPublished: false
    });
    const rows = [OPEN_NOW, privatePeriod];

    const anon = stubPeriods(t, rows);
    await get(OPEN);
    const anonAcl = boundValues(specsFor(anon, 'commentPeriods')[0]);
    t.mock.restoreAll();

    const staff = stubPeriods(t, rows);
    const staffRes = await getAsStaff(t, OPEN);

    assert.strictEqual(staffRes.status, 200);
    const staffAcl = boundValues(specsFor(staff, 'commentPeriods')[0]);
    assert.ok(anonAcl.includes('public'), 'the anonymous read asks for public rows');
    assert.ok(!anonAcl.includes('staff'),
      'and must not carry a role it did not present — that is the whole isolation');
    assert.ok(staffAcl.includes('staff'), 'the staff credential widens the predicate');
    // The rows are the same fixtures; only the predicate differs, which is the point.
    assert.ok(PUBLIC_ACL.includes('public') && !PRIVATE_ACL.includes('public'),
      'the fixture pair is only meaningful while one of them is non-public');
  });

  await t.test('the closed count is a 30-day window that stops at now', async () => {
    const seen = stubPeriods(t, [OPEN_NOW], { commentPeriods: 4 });

    const { body } = await get(OPEN);

    // A SECOND MEASUREMENT, not a second total: `count` is the open rows, `closedCount` is what
    // shut recently, and the envelope keeps them apart.
    assert.strictEqual(body[0].closedCount, 4);
    assert.strictEqual(body[0].count, 1);
    assert.strictEqual(body[0].meta[0].searchResultsTotal, 1);

    const specs = specsFor(seen, 'commentPeriods');
    const openRead = specs.find(s => /dateStarted/.test(s.query));
    const count = specs.find(s => /COUNT\(1\)/.test(s.query));
    assert.match(count.query, /\(\(c\.dateCompleted < @now AND NOT .*\)\) AND \(c\.dateCompleted >= @since\)$/);
    assert.match(count.query, /NOT \(IS_BOOL\(c\.isDeleted\) AND c\.isDeleted = true\)/);

    const countBound = bound(count);
    const openBound = bound(openRead);
    const since = Date.parse(countBound['@since']);
    const now = Date.parse(countBound['@now']);
    // BOTH EDGES, EXACT. `since` and `now` both derive from the ONE `new Date()` `openPeriods`
    // captures, so the window is exactly 30 days — not "close to" 30 days, which is what a second
    // `new Date()` call milliseconds later would have allowed.
    assert.strictEqual(now - since, 30 * 86400000, `window was ${(now - since) / 86400000} days`);
    // ...and the count's `@now` and closing day are the LITERAL SAME as the open read's: one shared
    // capture, not two `new Date()` calls a moment apart — the invariant `countClosedSince`'s doc claims.
    for (const name of ['@now', '@closingDayStart', '@closingDayEnd']) {
      assert.strictEqual(countBound[name], openBound[name], name);
    }
  });

  await t.test('closedCount is omitted by every branch that did not measure one', async () => {
    stubPeriods(t, [OPEN_NOW]);

    const { body } = await get(
      `/api/search?dataset=CommentPeriod&and%5B_id%5D=${PERIOD_EAGLE_ID}`);

    assert.ok(!('closedCount' in body[0]),
      'a key that is sometimes a number and sometimes absent must never be a silent zero');
  });

  await t.test('status is reported applied, not dropped', async () => {
    stubPeriods(t, [OPEN_NOW]);

    const { body } = await get(OPEN);

    assert.strictEqual(body[0].meta[0].dropped, undefined,
      'a filter the branch consumed must not also be reported as ignored');
  });

  await t.test('each open row carries its project name', async () => {
    stubPeriods(t, [OPEN_NOW]);

    const { body } = await get(OPEN);

    const [row] = body[0].searchResults;
    assert.strictEqual(row.projectName, PROJECT_ROW.name);
    assert.strictEqual(row.project, PROJECT_ROW.eagleId);
  });

  await t.test('a privileged caller keeps a row whose project does not resolve, with no name', async () => {
    stubCosmos(t, { projects: [], commentPeriods: [OPEN_NOW] });

    const { body } = await getAsStaff(t, OPEN, ['sysadmin']);

    const [row] = body[0].searchResults;
    assert.strictEqual(row._id, PERIOD_EAGLE_ID, 'the period is still answered');
    assert.ok(!('projectName' in row), 'a name that was not read must not be made up');
  });

  // A failed publish cascade leaves a public period under a project the caller cannot read. The
  // total is the rows answered, not the rows read, or the page promises rows it never sends.
  const OPEN_TOO = periodRow({ id: 'CP-2', eagleId: 'CP-2', dateStarted: daysOut(-2), dateCompleted: daysOut(4) });
  for (const [name, path] of [['the rail', OPEN], ['an _id read', `${LIST}&and%5B_id%5D=${PERIOD_EAGLE_ID}`]]) {
    await t.test(`the public never sees a period whose project it cannot read: ${name}`, async () => {
      stubCosmos(t, { projects: [], notifications: [], commentPeriods: [OPEN_NOW, OPEN_TOO] });
      const warn = t.mock.method(logger, 'warn', () => {});

      const { status, body } = await get(path);

      assert.strictEqual(status, 200);
      assert.deepStrictEqual(body[0].searchResults, []);
      assert.strictEqual(body[0].count, 0);
      assert.strictEqual(body[0].meta[0].searchResultsTotal, 0);
      const withheld = warn.mock.calls.filter(c => /CommentPeriod withheld/.test(c.arguments[0]));
      assert.strictEqual(withheld.length, 1, 'one warning per request, not one per row');
    });
  }

  await t.test('project names come from one read for the page, not one per row', async () => {
    const other = { id: '208', eagleId: 'P-208', name: 'Bear Creek Quarry', read: PUBLIC_ACL };
    const rows = [
      OPEN_NOW,
      periodRow({ id: 'CP-2', eagleId: 'CP-2', projectId: '208',
        dateStarted: daysOut(-2), dateCompleted: daysOut(4) }),
      periodRow({ id: 'CP-3', eagleId: 'CP-3', projectId: '207',
        dateStarted: daysOut(-2), dateCompleted: daysOut(6) })
    ];
    const seen = stubCosmos(t, { projects: [PROJECT_ROW, other], commentPeriods: rows });

    const { body } = await get(OPEN);

    assert.deepStrictEqual(body[0].searchResults.map(r => r.projectName),
      [PROJECT_ROW.name, other.name, PROJECT_ROW.name]);
    assert.strictEqual(specsFor(seen, 'projects').length, 1,
      'three rows over two projects are still one projects read');
  });

  // AN UNKNOWN STATUS IS THE DANGEROUS ONE: falling through would answer the whole corpus under a
  // 200, which reads exactly like "every period matches your filter".
  await t.test('an unknown status is a 400, never a full corpus', async () => {
    const seen = stubPeriods(t, [OPEN_NOW, CLOSED]);

    const { status, body } = await get(
      '/api/search?dataset=CommentPeriod&and%5Bstatus%5D=finished');

    assert.strictEqual(status, 400);
    assert.match(body.error, /and\[status\] must be one of open, upcoming, closed/);
    assert.deepStrictEqual(specsFor(seen, 'commentPeriods'), [],
      'and it is refused before any read is made');
  });

  await t.test('an empty status is refused too, not read as "no filter"', async () => {
    const { status } = await get('/api/search?dataset=CommentPeriod&and%5Bstatus%5D=');
    assert.strictEqual(status, 400);
  });
});

test('GET /search?dataset=CommentPeriod with no project lists every period', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const ROWS = ['CP-a', 'CP-b', 'CP-c', 'CP-d'].map(id => periodRow({ id, eagleId: id }));

  await t.test('it is paged, and searchResultsTotal is the whole list', async () => {
    const seen = stubPeriods(t, ROWS, { commentPeriods: 9 });

    const { status, body } = await get(`${LIST}&pageNum=1&pageSize=2`);

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body[0].searchResults.map(r => r._id), ['CP-c', 'CP-d']);
    assert.strictEqual(body[0].meta[0].searchResultsTotal, 9);
    const read = seen.find(s => s.container === 'commentPeriods' && !/COUNT\(1\)/.test(s.spec.query));
    assert.strictEqual(read.options.partitionKey, undefined, 'no project, so no partition');
    assert.match(read.spec.query, / OFFSET @skip LIMIT @size$/);
    assert.deepStrictEqual([bound(read.spec)['@skip'], bound(read.spec)['@size']], [2, 2]);
  });

  await t.test('rows carry their Eagle project id and project name', async () => {
    stubPeriods(t, [OPEN_NOW]);

    const { body } = await get(LIST);

    assert.strictEqual(body[0].searchResults[0].project, PROJECT_ROW.eagleId);
    assert.strictEqual(body[0].searchResults[0].projectName, PROJECT_ROW.name);
  });

  await t.test('the anonymous ACL reaches the list and the count, and staff widens it', async () => {
    const anon = stubPeriods(t, ROWS);
    await get(LIST);
    const [anonRead, anonCount] = specsFor(anon, 'commentPeriods');
    t.mock.restoreAll();
    const staff = stubPeriods(t, ROWS);
    await getAsStaff(t, LIST);
    const [staffRead] = specsFor(staff, 'commentPeriods');

    assert.ok(boundValues(anonRead).includes('public'));
    assert.ok(!boundValues(anonRead).includes('staff'), 'no role the caller did not present');
    assert.ok(boundValues(anonCount).includes('public'), 'the total uses the same predicate');
    assert.ok(boundValues(staffRead).includes('staff'));
  });

  await t.test('keywords match the period label or the project name, not the corpus', async () => {
    const other = periodRow({ id: 'CP-other', eagleId: 'CP-other', projectId: '208',
      informationLabel: 'Draft terms' });
    const labelled = periodRow({ id: 'CP-label', eagleId: 'CP-label', projectId: '208',
      informationLabel: 'Wind farm open house' });
    const rows = [OPEN_NOW, other, labelled];
    const quarry = { id: '208', eagleId: 'P-208', name: 'Bear Creek Quarry', read: PUBLIC_ACL };
    const seen = stubCosmos(t, { projects: [PROJECT_ROW, quarry], commentPeriods: rows });

    // Quoted, as eagle-api allowed: the quotes are stripped before matching.
    const { status } = await get(`${LIST}&keywords=%22WIND%22`);

    assert.strictEqual(status, 200);
    const [read, count] = specsFor(seen, 'commentPeriods');
    assert.deepStrictEqual(bound(read)['@keywordProjects'], ['207'], 'only the project named "wind"');
    assert.deepStrictEqual(applyKeywordPredicate(read, rows).map(r => r.id),
      [PERIOD_EAGLE_ID, 'CP-label'],
      'OPEN_NOW via its project name, CP-label via its own label, CP-other by neither');
    assert.deepStrictEqual(applyKeywordPredicate(count, rows).map(r => r.id),
      [PERIOD_EAGLE_ID, 'CP-label']);
  });

  await t.test('the project-name lookup runs under the caller ACL', async () => {
    const seen = stubPeriods(t, [OPEN_NOW]);

    await get(`${LIST}&keywords=wind`);

    const [lookup] = specsFor(seen, 'projects');
    assert.match(lookup.query, /CONTAINS\(c\.name, @name, true\)/);
    assert.ok(boundValues(lookup).includes('public'),
      'a private project name must not pull its periods into a public answer');
  });

  for (const [status, expected] of [['upcoming', ['CP-future']], ['closed', ['CP-past']]]) {
    await t.test(`status=${status} admits only ${expected}, on the list and the count`, async () => {
      const rows = [...STATE_ROWS, UNDATED];
      const seen = stubPeriods(t, rows);

      const res = await get(`${LIST}&and%5Bstatus%5D=${status}`);

      assert.strictEqual(res.status, 200);
      const [read, count] = specsFor(seen, 'commentPeriods');
      assert.deepStrictEqual(applyStatusPredicate(read, rows).map(r => r.id), expected);
      assert.deepStrictEqual(applyStatusPredicate(count, rows).map(r => r.id), expected);
      assert.strictEqual(res.body[0].meta[0].dropped, undefined, 'status is applied, not dropped');
    });
  }

  // The search tab sends `open` with `sortBy` always and keywords often; the rail sends neither. The
  // tab must get the paged, keyword-filtered list, not the capped rail that ignores both.
  const OPEN_LABELLED = periodRow({ id: 'CP-open-label', eagleId: 'CP-open-label', projectId: '208',
    informationLabel: 'Wind farm open house', dateStarted: daysOut(-1), dateCompleted: daysOut(9) });
  const OPEN_OTHER = periodRow({ id: 'CP-open-other', eagleId: 'CP-open-other', projectId: '208',
    informationLabel: 'Draft terms', dateStarted: daysOut(-1), dateCompleted: daysOut(9) });
  const TAB_ROWS = [...STATE_ROWS, OPEN_LABELLED, OPEN_OTHER];

  /** The list read and count, each narrowed to open periods matching `wind`, as Cosmos would. */
  function assertOpenKeywordList(seen) {
    const [read, count] = specsFor(seen, 'commentPeriods');
    for (const spec of [read, count]) {
      assert.deepStrictEqual(
        applyKeywordPredicate(spec, applyOpenPredicate(spec, TAB_ROWS)).map(r => r.id),
        [PERIOD_EAGLE_ID, 'CP-open-label'],
        'open AND (label or project name): neither neighbour, nor the open period matching neither');
    }
    return read;
  }

  await t.test('status=open with sortBy is the paged list, with keywords applied', async () => {
    const seen = stubPeriods(t, TAB_ROWS, { commentPeriods: 9 });

    const { status, body } = await get(
      `${OPEN}&sortBy=-dateStarted&keywords=wind&pageNum=1&pageSize=2`);

    assert.strictEqual(status, 200);
    const read = assertOpenKeywordList(seen);
    assert.match(read.query, /ORDER BY c\.dateStarted DESC OFFSET @skip LIMIT @size$/);
    assert.deepStrictEqual([bound(read)['@skip'], bound(read)['@size']], [2, 2], 'paged');
    assert.strictEqual(body[0].meta[0].searchResultsTotal, 9, 'the whole list, not the page');
    assert.ok(!('closedCount' in body[0]), 'the rail count belongs to the rail read only');
  });

  await t.test('status=open with sortBy and no keywords is the list, not the rail', async () => {
    const seen = stubPeriods(t, TAB_ROWS, { commentPeriods: 9 });

    const { body } = await get(`${OPEN}&sortBy=-dateStarted`);

    const [read] = specsFor(seen, 'commentPeriods');
    assert.deepStrictEqual(applyOpenPredicate(read, TAB_ROWS).map(r => r.id),
      [PERIOD_EAGLE_ID, 'CP-open-label', 'CP-open-other']);
    assert.match(read.query, /ORDER BY c\.dateStarted DESC OFFSET @skip LIMIT @size$/);
    assert.strictEqual(body[0].meta[0].searchResultsTotal, 9);
  });

  await t.test('status=open with keywords and no sortBy is the list too', async () => {
    const seen = stubPeriods(t, TAB_ROWS, { commentPeriods: 9 });

    const { body } = await get(`${OPEN}&keywords=wind`);

    assertOpenKeywordList(seen);
    assert.strictEqual(body[0].meta[0].searchResultsTotal, 9);
    assert.ok(!('closedCount' in body[0]));
  });

  for (const [sortBy, order, meaning] of [
    [undefined, 'c.dateStarted DESC', 'newest start first, the default'],
    ['%2BdateStarted', 'c.dateStarted ASC', 'oldest start first'],
    ['-dateCompleted', 'c.dateCompleted DESC', 'latest close first'],
    ['%2BdateCompleted', 'c.dateCompleted ASC', 'soonest close first']
  ]) {
    await t.test(`sortBy=${sortBy === undefined ? '(none)' : decodeURIComponent(sortBy)} is ${meaning}`, async () => {
      const seen = stubPeriods(t, ROWS);
      await get(sortBy === undefined ? LIST : `${LIST}&sortBy=${sortBy}`);
      const { query } = specsFor(seen, 'commentPeriods')[0];
      assert.ok(query.endsWith(`ORDER BY ${order} OFFSET @skip LIMIT @size`), query);
    });
  }
});

test('GET /search/counts carries a CommentPeriod total', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('it is the list predicate counted under the caller ACL', async () => {
    const seen = stubPeriods(t, [OPEN_NOW], { commentPeriods: 6 });

    const { status, body } = await get('/api/search/counts?datasets=CommentPeriod&keywords=wind');

    assert.strictEqual(status, 200);
    assert.strictEqual(body[0].counts.CommentPeriod, 6);
    const [count] = specsFor(seen, 'commentPeriods');
    assert.match(count.query, /COUNT\(1\)/);
    assert.ok(boundValues(count).includes('public'));
    assert.deepStrictEqual(applyKeywordPredicate(count, [OPEN_NOW]).map(r => r.id), [PERIOD_EAGLE_ID]);
  });
});

test('the unscoped CommentPeriod list: paging, limits and routing', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  // DEMI holds ~1200 periods; a page past row 1000 must still be answered.
  const MANY = Array.from({ length: 1200 }, (_, i) => {
    const id = `CP-${String(i).padStart(4, '0')}`;
    return periodRow({ id, eagleId: id });
  });

  await t.test('a page past row 1000 is answered from the whole list', async () => {
    const seen = stubPeriods(t, MANY);

    const { status, body } = await getAsStaff(t, `${LIST}&pageNum=11&pageSize=100`);

    assert.strictEqual(status, 200);
    assert.strictEqual(body[0].searchResults.length, 100);
    assert.strictEqual(body[0].searchResults[0]._id, 'CP-1100');
    assert.strictEqual(body[0].searchResults[99]._id, 'CP-1199');
    assert.strictEqual(body[0].meta[0].searchResultsTotal, 1200);
    const [read] = specsFor(seen, 'commentPeriods');
    assert.deepStrictEqual([bound(read)['@skip'], bound(read)['@size']], [1100, 100]);
  });

  await t.test('a page past the end is empty and the total still stands', async () => {
    stubPeriods(t, MANY);

    const { body } = await getAsStaff(t, `${LIST}&pageNum=50&pageSize=100`);

    assert.deepStrictEqual(body[0].searchResults, []);
    assert.strictEqual(body[0].meta[0].searchResultsTotal, 1200);
  });

  await t.test('a staff pageSize over 1000 is clamped to 1000', async () => {
    const seen = stubPeriods(t, MANY);

    const { body } = await getAsStaff(t, `${LIST}&pageSize=2000`);

    assert.strictEqual(bound(specsFor(seen, 'commentPeriods')[0])['@size'], 1000);
    assert.strictEqual(body[0].searchResults.length, 1000);
  });

  await t.test('an anonymous pageSize over its cap is refused, not truncated', async () => {
    const seen = stubPeriods(t, MANY);

    const over = await get(`${LIST}&pageSize=101`);
    assert.strictEqual(over.status, 400);
    assert.match(over.body.error, /pageSize above 100 requires an authenticated request/);
    assert.deepStrictEqual(specsFor(seen, 'commentPeriods'), [], 'refused before any read');

    const atCap = await get(`${LIST}&pageSize=100`);
    assert.strictEqual(atCap.status, 200);
    assert.strictEqual(atCap.body[0].searchResults.length, 100);
  });

  await t.test('the open rail refuses an anonymous pageSize over the cap too', async () => {
    stubPeriods(t, [OPEN_NOW]);
    const { status } = await get(`${OPEN}&pageSize=500`);
    assert.strictEqual(status, 400);
  });

  await t.test('deleted periods are excluded from the list and the count', async () => {
    const seen = stubPeriods(t, [OPEN_NOW]);

    await get(LIST);

    const [read, count] = specsFor(seen, 'commentPeriods');
    for (const spec of [read, count]) {
      assert.match(spec.query, /NOT \(IS_BOOL\(c\.isDeleted\) AND c\.isDeleted = true\)/);
    }
  });

  await t.test('open plus pageNum, with no sortBy, is the paged list, not the rail', async () => {
    const seen = stubPeriods(t, STATE_ROWS);

    const { body } = await get(`${OPEN}&pageNum=1&pageSize=2`);

    const [read] = specsFor(seen, 'commentPeriods');
    assert.deepStrictEqual([bound(read)['@skip'], bound(read)['@size']], [2, 2]);
    assert.ok(!('closedCount' in body[0]), 'the rail count belongs to the rail read only');
  });

  await t.test('open with an empty or quotes-only keyword is still the rail', async () => {
    for (const extra of ['&keywords=', '&q=%22%22']) {
      stubPeriods(t, [OPEN_NOW], { commentPeriods: 3 });
      const { body } = await get(`${OPEN}${extra}`);
      assert.strictEqual(body[0].closedCount, 3, `${extra} is the rail`);
      t.mock.restoreAll();
    }
  });

  await t.test('q is an alias for keywords on the list', async () => {
    const seen = stubPeriods(t, [OPEN_NOW]);

    await get(`${LIST}&q=wind`);

    assert.strictEqual(bound(specsFor(seen, 'commentPeriods')[0])['@keywords'], 'wind');
  });

  await t.test('a one-character keyword matches labels only, with no project-name read', async () => {
    const seen = stubPeriods(t, [OPEN_NOW]);

    await get(`${LIST}&keywords=w`);

    assert.deepStrictEqual(specsFor(seen, 'projects').filter(s => /CONTAINS\(c\.name/.test(s.query)), []);
    const [read] = specsFor(seen, 'commentPeriods');
    assert.strictEqual(bound(read)['@keywords'], 'w');
    assert.deepStrictEqual(bound(read)['@keywordProjects'], []);
  });

  await t.test('a repeated status is refused, not narrowed to the first', async () => {
    const seen = stubPeriods(t, [OPEN_NOW]);

    const { status, body } = await get(`${LIST}&and%5Bstatus%5D=open&and%5Bstatus%5D=closed`);

    assert.strictEqual(status, 400);
    assert.match(body.error, /and\[status\] takes one value/);
    assert.deepStrictEqual(specsFor(seen, 'commentPeriods'), []);
  });

  await t.test('an unusable sortBy is reported dropped and the default order applies', async () => {
    const seen = stubPeriods(t, [OPEN_NOW]);

    const { body } = await get(`${LIST}&sortBy=-score`);

    assert.deepStrictEqual(body[0].meta[0].dropped, { filter: [], sort: ['score'] });
    assert.match(specsFor(seen, 'commentPeriods')[0].query, /ORDER BY c\.dateStarted DESC/);
  });

  await t.test('status beside a project filter is reported dropped', async () => {
    stubPeriods(t, [OPEN_NOW]);

    const { status, body } = await get(
      `${LIST}&and%5Bproject%5D=${PROJECT_EAGLE_ID}&and%5Bstatus%5D=open`);

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body[0].meta[0].dropped.filter, ['status']);
  });

  await t.test('the badge and the list bind the same keyword for "wind  farm"', async () => {
    const list = stubPeriods(t, [OPEN_NOW]);
    await get(`${LIST}&keywords=wind%20%20farm`);
    const listCount = specsFor(list, 'commentPeriods').find(s => /COUNT\(1\)/.test(s.query));
    t.mock.restoreAll();

    const badge = stubPeriods(t, [OPEN_NOW]);
    await get('/api/search/counts?datasets=CommentPeriod&keywords=wind%20%20farm');
    const [badgeCount] = specsFor(badge, 'commentPeriods');

    assert.strictEqual(bound(listCount)['@keywords'], 'wind farm');
    assert.strictEqual(bound(badgeCount)['@keywords'], bound(listCount)['@keywords']);
    assert.deepStrictEqual(bound(badgeCount)['@keywordProjects'], bound(listCount)['@keywordProjects']);
  });
});

// eagle-public's `closesAt`: a `dateCompleted` at exactly Pacific midnight stays open to the end of
// that Pacific day. The server must label the same rows the page does.
test('the closing day follows the Pacific calendar, as eagle-public does', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const closing = (id, dateCompleted) =>
    periodRow({ id, eagleId: id, dateStarted: '2026-09-01T07:00:00.000Z', dateCompleted });
  // 11:00 PDT on 2026-09-22, whose Pacific midnight is 07:00Z.
  const NOW = '2026-09-22T18:00:00.000Z';
  const ROWS = [
    closing('today', '2026-09-22T07:00:00.000Z'),
    closing('today-no-ms', '2026-09-22T07:00:00Z'),
    closing('this-morning', '2026-09-22T09:00:00.000Z'),
    closing('yesterday', '2026-09-21T07:00:00.000Z'),
    closing('tomorrow', '2026-09-23T07:00:00.000Z')
  ];
  const at = (tt, iso) => tt.mock.timers.enable({ apis: ['Date'], now: new Date(iso) });

  await t.test('the list: open keeps midnight-today, closed takes yesterday and this morning', async (tt) => {
    at(tt, NOW);
    const open = stubPeriods(tt, ROWS);
    await get(`${OPEN}&sortBy=-dateStarted`);
    const [openRead, openCount] = specsFor(open, 'commentPeriods');
    for (const spec of [openRead, openCount]) {
      assert.deepStrictEqual(applyOpenPredicate(spec, ROWS).map(r => r.id), ['today', 'today-no-ms', 'tomorrow']);
    }
    tt.mock.restoreAll();

    const closed = stubPeriods(tt, ROWS);
    await get(`${LIST}&and%5Bstatus%5D=closed`);
    for (const spec of specsFor(closed, 'commentPeriods')) {
      assert.deepStrictEqual(applyStatusPredicate(spec, ROWS).map(r => r.id), ['this-morning', 'yesterday']);
    }
  });

  await t.test('the rail shows midnight-today and does not count it as recently closed', async (tt) => {
    at(tt, NOW);
    const seen = stubPeriods(tt, ROWS);

    await get(OPEN);

    const [read, count] = specsFor(seen, 'commentPeriods');
    assert.match(count.query, /COUNT\(1\)/);
    assert.deepStrictEqual(applyOpenPredicate(read, ROWS).map(r => r.id), ['today', 'today-no-ms', 'tomorrow']);
    assert.deepStrictEqual(applyStatusPredicate(count, ROWS).map(r => r.id), ['this-morning', 'yesterday']);
  });

  // 2026-11-01 falls back at 09:00Z: midnight that day is 00:00 PDT (07:00Z); 08:00Z is 01:00 PDT.
  await t.test('on the day DST ends, only the PDT midnight counts as the closing day', async (tt) => {
    at(tt, '2026-11-01T20:00:00.000Z');
    const rows = [closing('pdt-midnight', '2026-11-01T07:00:00.000Z'), closing('one-am', '2026-11-01T08:00:00.000Z')];
    const seen = stubPeriods(tt, rows);

    await get(OPEN);

    const [read, count] = specsFor(seen, 'commentPeriods');
    assert.deepStrictEqual(applyOpenPredicate(read, rows).map(r => r.id), ['pdt-midnight']);
    assert.deepStrictEqual(applyStatusPredicate(count, rows).map(r => r.id), ['one-am']);
  });
});
