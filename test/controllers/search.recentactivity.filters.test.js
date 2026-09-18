'use strict';

/**
 * `GET /search?dataset=RecentActivity` — the activities filter panel on the KEYWORDLESS page.
 *
 * "Documents attached" and the posted-on range were accepted, answered 200 and narrowed nothing:
 * the branch read the container by project and keywords only, and both keys came back under
 * `meta[0].dropped.filter`. A filter panel that quietly does nothing returns the whole corpus and
 * reads as a filter that matched everything, so the two assertions every case here makes are that
 * the SQL carries the clause and that the key is NOT reported dropped.
 *
 * The page and its total are asserted TOGETHER wherever both run: a total measured with a looser
 * predicate than the page describes rows the page cannot hold, and eagle-public pages against it.
 *
 * Harness, stub points and row fixtures: `test/helpers/search-reads.js`.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const aiSearch = require('../../src/search/ai-search');
const {
  PROJECT_ROW, stubCosmos, specsFor, boundValues, get, updateRow, notificationRow
} = require('../helpers/search-reads');

/** An update with an attachment, one with none stored and one stored as the empty string. */
const WITH_DOC = updateRow({ id: 'u-doc', eagleId: 'u-doc', dateAdded: '2026-09-10T18:00:00.000Z' });
const NO_DOC = updateRow({
  id: 'u-none', eagleId: 'u-none', documentUrl: null, pinned: false,
  dateAdded: '2026-09-05T12:00:00.000Z'
});
const EMPTY_DOC = updateRow({
  id: 'u-empty', eagleId: 'u-empty', documentUrl: '', pinned: false,
  dateAdded: '2026-08-31T23:00:00.000Z'
});

/** Every row this dataset's branch touches, so a reference resolves instead of dropping out. */
const rowsFor = (updates) => ({
  projects: [PROJECT_ROW], notifications: [notificationRow()], updates
});

/** The keys `meta[0].dropped.filter` named, or [] when the branch consumed everything. */
const droppedFilters = (body) => ((body[0].meta[0].dropped || {}).filter || []);

/**
 * `IS_DEFINED(c.documentUrl)`, not the bare column name: the PROJECTION names `c.documentUrl` on
 * every read, so a bare match would pass whatever the WHERE clause said.
 */
const PRESENCE = /IS_DEFINED\(c\.documentUrl\)/;
const FILLED = /\(\(IS_DEFINED\(c\.documentUrl\) AND NOT IS_NULL\(c\.documentUrl\)\) AND c\.documentUrl != ''\)/;
/** The same clause under a NOT — the complement, spelled by construction rather than by hand. */
const EMPTIED = /\(NOT \(\(IS_DEFINED\(c\.documentUrl\)/;

test('GET /search?dataset=RecentActivity&and[documentUrl]', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('true narrows the read AND its count to rows carrying a link', async () => {
    const seen = stubCosmos(t, rowsFor([WITH_DOC, NO_DOC, EMPTY_DOC]));

    const { status, body } = await get(
      '/api/search?dataset=RecentActivity&and%5BdocumentUrl%5D=true');

    assert.strictEqual(status, 200);
    // THE WHOLE POINT: `documentUrl` used to come back under `meta.dropped.filter`.
    assert.deepStrictEqual(droppedFilters(body), []);

    const specs = specsFor(seen, 'updates');
    assert.strictEqual(specs.length, 2, 'the page and its total are two reads');
    for (const spec of specs) {
      assert.match(spec.query, FILLED);
      assert.ok(!EMPTIED.test(spec.query), 'true must not ask the complement question');
    }
  });

  // `documentUrl: ''` is stored on some rows and the property is absent on others. Both are "no
  // attachment", the same pair `eagle-query`'s presenceTerm names on the index path.
  await t.test('false is the exact complement, so an empty string counts as no attachment',
    async () => {
      const seen = stubCosmos(t, rowsFor([WITH_DOC, NO_DOC, EMPTY_DOC]));

      const { body } = await get('/api/search?dataset=RecentActivity&and%5BdocumentUrl%5D=false');

      assert.deepStrictEqual(droppedFilters(body), []);
      for (const spec of specsFor(seen, 'updates')) {
        assert.match(spec.query, EMPTIED);
        assert.match(spec.query, /c\.documentUrl != ''/, 'the empty string is on the "none" side');
      }
    });

  // A URL is not a question this key can ask. Filtering on the value would make one key mean two
  // things depending on what was sent, so it is refused the way the index path refuses it.
  await t.test('a value that is not true or false is reported dropped, never guessed at', async () => {
    const seen = stubCosmos(t, rowsFor([WITH_DOC, NO_DOC]));

    const { status, body } = await get('/api/search?dataset=RecentActivity' +
      '&and%5BdocumentUrl%5D=https%3A%2F%2Fexample.test%2Fa.pdf');

    assert.strictEqual(status, 200);
    assert.ok(droppedFilters(body).includes('documentUrl'),
      'an unapplied key has to be named, or the page looks filtered when it is not');
    for (const spec of specsFor(seen, 'updates')) {
      assert.ok(!PRESENCE.test(spec.query), 'no clause was built from a value it cannot read');
    }
  });

  await t.test('an empty and[documentUrl]= adds no clause and is not reported dropped', async () => {
    const seen = stubCosmos(t, rowsFor([WITH_DOC, NO_DOC]));

    const { body } = await get('/api/search?dataset=RecentActivity&and%5BdocumentUrl%5D=');

    assert.strictEqual(body[0].searchResults.length, 2, 'a cleared checkbox matches everything');
    assert.deepStrictEqual(droppedFilters(body), [], 'not dropped: it was read, just empty');
    for (const spec of specsFor(seen, 'updates')) {
      assert.ok(!PRESENCE.test(spec.query));
    }
  });

  await t.test('no documentUrl filter adds no presence clause', async () => {
    const seen = stubCosmos(t, rowsFor([WITH_DOC, NO_DOC]));

    await get('/api/search?dataset=RecentActivity');

    for (const spec of specsFor(seen, 'updates')) {
      assert.ok(!PRESENCE.test(spec.query), 'a filter nobody asked for must not be applied');
    }
  });
});

test('GET /search?dataset=RecentActivity&and[dateAdded…]', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a start date is an inclusive lower bound on the whole UTC day', async () => {
    const seen = stubCosmos(t, rowsFor([WITH_DOC, NO_DOC, EMPTY_DOC]));

    const { status, body } = await get(
      '/api/search?dataset=RecentActivity&and%5BdateAddedStart%5D=2026-09-05');

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(droppedFilters(body), []);

    const specs = specsFor(seen, 'updates');
    assert.strictEqual(specs.length, 2, 'the page and its total are two reads');
    for (const spec of specs) {
      assert.match(spec.query, /c\.dateAdded >= @dateAddedFrom/);
      // MIDNIGHT, not the moment the request was parsed: an update posted at 00:30 that day is
      // inside a window the caller asked for by date.
      assert.ok(boundValues(spec).includes('2026-09-05T00:00:00.000Z'), boundValues(spec).join());
      assert.ok(!/dateAddedBefore/.test(spec.query), 'one edge is not a closed window');
    }
  });

  // The end date INCLUDES its own day, which is only true because the bound is the midnight after
  // it. `<= 2026-09-10T00:00:00Z` would hide every update posted during the day the caller named —
  // the same arithmetic `eagle-query`'s rangeTerm does for the index path.
  await t.test('an end date covers its own day, by bounding at the next midnight', async () => {
    const seen = stubCosmos(t, rowsFor([WITH_DOC]));

    const { body } = await get(
      '/api/search?dataset=RecentActivity&and%5BdateAddedEnd%5D=2026-09-10');

    assert.deepStrictEqual(droppedFilters(body), []);
    for (const spec of specsFor(seen, 'updates')) {
      assert.match(spec.query, /c\.dateAdded < @dateAddedBefore/);
      assert.ok(boundValues(spec).includes('2026-09-11T00:00:00.000Z'),
        'an update posted at 18:00 on the end date is inside the window the caller asked for');
    }
  });

  await t.test('both edges on one date are that single day', async () => {
    const seen = stubCosmos(t, rowsFor([WITH_DOC]));

    const { body } = await get('/api/search?dataset=RecentActivity' +
      '&and%5BdateAddedStart%5D=2026-09-10&and%5BdateAddedEnd%5D=2026-09-10');

    assert.deepStrictEqual(droppedFilters(body), []);
    const [read] = specsFor(seen, 'updates');
    assert.match(read.query, /c\.dateAdded >= @dateAddedFrom/);
    assert.match(read.query, /c\.dateAdded < @dateAddedBefore/);
    const bound = boundValues(read);
    assert.ok(bound.includes('2026-09-10T00:00:00.000Z'));
    assert.ok(bound.includes('2026-09-11T00:00:00.000Z'));
  });

  await t.test('a full ISO timestamp is read as its day, not as an instant', async () => {
    const seen = stubCosmos(t, rowsFor([WITH_DOC]));

    await get('/api/search?dataset=RecentActivity' +
      '&and%5BdateAddedStart%5D=2026-09-05T13%3A45%3A00.000Z');

    const [read] = specsFor(seen, 'updates');
    assert.ok(boundValues(read).includes('2026-09-05T00:00:00.000Z'),
      'the hours are dropped, so a date picker and a saved URL mean the same window');
  });

  await t.test('a date nothing can parse is reported dropped, not silently ignored', async () => {
    const seen = stubCosmos(t, rowsFor([WITH_DOC, NO_DOC]));

    const { status, body } = await get(
      '/api/search?dataset=RecentActivity&and%5BdateAddedStart%5D=last%20tuesday');

    assert.strictEqual(status, 200);
    assert.ok(droppedFilters(body).includes('dateAddedStart'));
    for (const spec of specsFor(seen, 'updates')) {
      assert.ok(!/dateAdded >=|dateAdded </.test(spec.query),
        'an unreadable date must not become a bound that hides rows');
    }
  });

  await t.test('an empty edge adds no clause and is not reported dropped', async () => {
    const seen = stubCosmos(t, rowsFor([WITH_DOC, NO_DOC]));

    const { body } = await get(
      '/api/search?dataset=RecentActivity&and%5BdateAddedStart%5D=&and%5BdateAddedEnd%5D=');

    assert.strictEqual(body[0].searchResults.length, 2, 'a cleared date box matches everything');
    assert.deepStrictEqual(droppedFilters(body), []);
    for (const spec of specsFor(seen, 'updates')) {
      assert.ok(!/dateAdded >=|dateAdded </.test(spec.query));
    }
  });

  await t.test('no date filter bounds nothing', async () => {
    const seen = stubCosmos(t, rowsFor([WITH_DOC, NO_DOC]));

    await get('/api/search?dataset=RecentActivity');

    for (const spec of specsFor(seen, 'updates')) {
      assert.ok(!/dateAdded >=|dateAdded </.test(spec.query));
      assert.match(spec.query, /ORDER BY c\.dateAdded DESC$|VALUE COUNT\(1\)/,
        'the default order is untouched by a filter that was never sent');
    }
  });
});

test('dataset=RecentActivity filters compose', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a project, an attachment and a window are one predicate, on both reads', async () => {
    const seen = stubCosmos(t, rowsFor([WITH_DOC, NO_DOC]), { updates: 1 });

    const { status, body } = await get('/api/search?dataset=RecentActivity' +
      `&and%5Bproject%5D=${PROJECT_ROW.eagleId}` +
      '&and%5BdocumentUrl%5D=true&and%5BdateAddedStart%5D=2026-09-01' +
      '&and%5BdateAddedEnd%5D=2026-09-30&pageSize=25');

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(droppedFilters(body), [], 'every key was applied');
    assert.strictEqual(body[0].count, 1);

    const specs = specsFor(seen, 'updates');
    assert.strictEqual(specs.length, 2);
    for (const spec of specs) {
      assert.match(spec.query, /c\.projectId = @projectId/);
      assert.match(spec.query, FILLED);
      assert.match(spec.query, /c\.dateAdded >= @dateAddedFrom/);
      assert.match(spec.query, /c\.dateAdded < @dateAddedBefore/);
      // The EAGLE project id: `updates.projectId` holds the id eagle-api pushed, not the DEMI one.
      assert.ok(boundValues(spec).includes(PROJECT_ROW.eagleId));
    }
  });

  // The keyword path filters both keys through the `activities` index and must keep doing so — the
  // Cosmos branch is the fallback for the keywordless page, not a second implementation of the URL.
  await t.test('with keywords the index still answers, and both keys go into its $filter',
    async () => {
      stubCosmos(t, rowsFor([WITH_DOC]));
      let sent = null;
      t.mock.method(aiSearch, 'config', () => ({ configured: true, activitiesIndex: 'activities' }));
      t.mock.method(aiSearch, 'searchActivities', async (opts) => {
        sent = opts;
        return { items: [{ id: 'u-doc' }], count: 1 };
      });

      const { status, body } = await get('/api/search?dataset=RecentActivity&keywords=application' +
        '&and%5BdocumentUrl%5D=true&and%5BdateAddedStart%5D=2026-09-05');

      assert.strictEqual(status, 200);
      assert.ok(sent, 'the index answered this page');
      assert.match(sent.filter, /documentUrl ne null/);
      assert.match(sent.filter, /dateAdded ge 2026-09-05T00:00:00\.000Z/);
      assert.deepStrictEqual(droppedFilters(body), []);
    });
});
