'use strict';

/**
 * `GET /search?dataset=CommentPeriod&and[status]=open` — the home page's engagement rail.
 *
 * THE ONLY CROSS-PARTITION LIST this container has. Every other read binds a parent and passes
 * `partitionKey`, which is what keeps an ACL bug in those reads bounded to one project; this one
 * sweeps every partition, so the caller's visibility predicate is the whole defence and the cases
 * below check it by looking at the SQL the request actually emitted.
 *
 * Harness, stub points and row fixtures: `test/helpers/search-reads.js`.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  PERIOD_EAGLE_ID, PUBLIC_ACL, PRIVATE_ACL, PROJECT_ROW,
  stubCosmos, specsFor, boundValues, get, getAsStaff, periodRow
} = require('../helpers/search-reads');

const OPEN = '/api/search?dataset=CommentPeriod&and%5Bstatus%5D=open';

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

/**
 * The stub honours a `partitionKey` but not a WHERE clause, so a date predicate has to be read out
 * of the emitted SQL rather than out of the rows served. This runs the real criterion over the
 * fixtures the way Cosmos would, which is what makes "excludes the closed one" an assertion about
 * the query instead of about the stub.
 */
function applyOpenPredicate(spec, rows) {
  const now = boundValues(spec).find(v => /^\d{4}-\d\d-\d\dT/.test(v));
  assert.ok(now, 'the open read must bind a single @now, not interpolate one');
  assert.match(spec.query, /c\.dateStarted <= @now AND c\.dateCompleted >= @now/);
  return rows.filter(r => r.dateStarted <= now && r.dateCompleted >= now);
}

test('GET /search?dataset=CommentPeriod&and[status]=open', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('the predicate admits the open period and neither of its neighbours', async () => {
    const rows = [NOT_STARTED, OPEN_NOW, CLOSED];
    const seen = stubCosmos(t, { projects: [PROJECT_ROW], commentPeriods: rows });

    const { status, body } = await get(OPEN);

    assert.strictEqual(status, 200);
    const [read] = specsFor(seen, 'commentPeriods');
    assert.deepStrictEqual(applyOpenPredicate(read, rows).map(r => r.id), [PERIOD_EAGLE_ID],
      'a period that has not started, and one that has closed, are both outside the window');
    // Soonest to close first: the rail's whole ordering claim, and a key `SORTABLE` already allows.
    assert.match(read.query, /ORDER BY c\.dateCompleted ASC$/);
  });

  await t.test('it is cross-partition, and capped rather than paged', async () => {
    const seen = stubCosmos(t, { projects: [PROJECT_ROW], commentPeriods: [OPEN_NOW] });

    await get(`${OPEN}&pageSize=7`);

    const [{ options }] = seen.filter(s => s.container === 'commentPeriods');
    assert.strictEqual(options.partitionKey, undefined,
      '"open" is not a property of any one project, so this read cannot bind a parent');
    // An absent maxItemCount puts cosmos.query on the fetchAll path, which drains every partition.
    assert.strictEqual(options.maxItemCount, 7);
  });

  await t.test('the caller ACL reaches Cosmos on the open read and on the closed count', async () => {
    const seen = stubCosmos(t, { projects: [PROJECT_ROW], commentPeriods: [OPEN_NOW] });

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

    const anon = stubCosmos(t, { projects: [PROJECT_ROW], commentPeriods: rows });
    await get(OPEN);
    const anonAcl = boundValues(specsFor(anon, 'commentPeriods')[0]);
    t.mock.restoreAll();

    const staff = stubCosmos(t, { projects: [PROJECT_ROW], commentPeriods: rows });
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
    const seen = stubCosmos(t,
      { projects: [PROJECT_ROW], commentPeriods: [OPEN_NOW] }, { commentPeriods: 4 });

    const { body } = await get(OPEN);

    // A SECOND MEASUREMENT, not a second total: `count` is the open rows, `closedCount` is what
    // shut recently, and the envelope keeps them apart.
    assert.strictEqual(body[0].closedCount, 4);
    assert.strictEqual(body[0].count, 1);
    assert.strictEqual(body[0].meta[0].searchResultsTotal, 1);

    const specs = specsFor(seen, 'commentPeriods');
    const openRead = specs.find(s => /dateStarted/.test(s.query));
    const count = specs.find(s => /COUNT\(1\)/.test(s.query));
    assert.match(count.query, /c\.dateCompleted >= @since AND c\.dateCompleted < @closedNow/);

    const bound = Object.fromEntries((count.parameters || []).map(p => [p.name, p.value]));
    const openBound = Object.fromEntries((openRead.parameters || []).map(p => [p.name, p.value]));
    const since = Date.parse(bound['@since']);
    const now = Date.parse(bound['@closedNow']);
    // BOTH EDGES, EXACT. `since` and `now` both derive from the ONE `new Date()` `openPeriods`
    // captures, so the window is exactly 30 days — not "close to" 30 days, which is what a second
    // `new Date()` call milliseconds later would have allowed.
    assert.strictEqual(now - since, 30 * 86400000, `window was ${(now - since) / 86400000} days`);
    // ...and `@closedNow` is the LITERAL SAME instant as the open read's `@now`: one shared capture,
    // not two `new Date()` calls a moment apart — the invariant `countClosedSince`'s doc claims.
    assert.strictEqual(bound['@closedNow'], openBound['@now']);
  });

  await t.test('closedCount is omitted by every branch that did not measure one', async () => {
    stubCosmos(t, { projects: [PROJECT_ROW], commentPeriods: [OPEN_NOW] });

    const { body } = await get(
      `/api/search?dataset=CommentPeriod&and%5B_id%5D=${PERIOD_EAGLE_ID}`);

    assert.ok(!('closedCount' in body[0]),
      'a key that is sometimes a number and sometimes absent must never be a silent zero');
  });

  await t.test('status is reported applied, not dropped', async () => {
    stubCosmos(t, { projects: [PROJECT_ROW], commentPeriods: [OPEN_NOW] });

    const { body } = await get(OPEN);

    assert.strictEqual(body[0].meta[0].dropped, undefined,
      'a filter the branch consumed must not also be reported as ignored');
  });

  await t.test('each open row carries its project name', async () => {
    stubCosmos(t, { projects: [PROJECT_ROW], commentPeriods: [OPEN_NOW] });

    const { body } = await get(OPEN);

    const [row] = body[0].searchResults;
    assert.strictEqual(row.projectName, PROJECT_ROW.name);
    assert.strictEqual(row.project, PROJECT_ROW.eagleId);
  });

  await t.test('a row whose project does not resolve keeps the row and omits the name', async () => {
    stubCosmos(t, { projects: [], commentPeriods: [OPEN_NOW] });

    const { body } = await get(OPEN);

    const [row] = body[0].searchResults;
    assert.strictEqual(row._id, PERIOD_EAGLE_ID, 'the period is still answered');
    assert.ok(!('projectName' in row), 'a name that was not read must not be made up');
  });

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
    const seen = stubCosmos(t, { projects: [PROJECT_ROW], commentPeriods: [OPEN_NOW, CLOSED] });

    const { status, body } = await get(
      '/api/search?dataset=CommentPeriod&and%5Bstatus%5D=closed');

    assert.strictEqual(status, 400);
    assert.match(body.error, /and\[status\]/);
    assert.deepStrictEqual(specsFor(seen, 'commentPeriods'), [],
      'and it is refused before any read is made');
  });

  await t.test('an empty status is refused too, not read as "no filter"', async () => {
    const { status } = await get('/api/search?dataset=CommentPeriod&and%5Bstatus%5D=');
    assert.strictEqual(status, 400);
  });
});
