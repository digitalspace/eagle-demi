'use strict';

/**
 * `GET /search?dataset=RecentActivity` — the two reads the home page rebuild needs from this
 * container: one update by id, and the type filter on the keywordless path.
 *
 * Both were previously invisible failures rather than errors. `and[_id]` fell through to the list
 * branch and answered an arbitrary page, and `and[type]` was accepted and then reported under
 * `meta.dropped.filter` — a filter panel that quietly does nothing returns the whole corpus and
 * looks like a filter that matched everything.
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

const UPDATE_ID = '5f0e4a0c3f4b1a0021a1b2c1';

/** The three `type` values the live container holds, News being much the largest. */
const NEWS = updateRow({ id: UPDATE_ID, eagleId: UPDATE_ID, type: 'News' });
const PCP = updateRow({
  id: 'U-pcp', eagleId: 'U-pcp', type: 'Public Comment Period', pinned: false
});
const PN_PCP = updateRow({
  id: 'U-pnpcp', eagleId: 'U-pnpcp', type: 'Project Notification Public Comment Period',
  pinned: false
});

/** Every row this dataset's branch touches, so a reference resolves instead of dropping out. */
const rowsFor = (updates) => ({
  projects: [PROJECT_ROW], notifications: [notificationRow()], updates
});

test('GET /search?dataset=RecentActivity&and[_id]', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('answers the one update, in the shape the list branch answers with', async () => {
    stubCosmos(t, rowsFor([NEWS, PCP]));

    const { status, body } = await get(
      `/api/search?dataset=RecentActivity&and%5B_id%5D=${UPDATE_ID}`);

    assert.strictEqual(status, 200);
    assert.strictEqual(body[0].count, 1);
    assert.strictEqual(body[0].searchResults.length, 1);
    const [row] = body[0].searchResults;
    assert.strictEqual(row._id, UPDATE_ID);
    assert.strictEqual(row._schemaName, 'RecentActivity');
    // The references the News card binds. A point read that skipped `updateProjects` would answer
    // a row whose project is a bare Eagle id the template renders as nothing.
    assert.deepStrictEqual(row.project, { _id: PROJECT_ROW.eagleId, name: PROJECT_ROW.name, location: null });
    assert.strictEqual(body[0].meta[0].dropped, undefined, '_id was consumed, not ignored');
  });

  await t.test('the project carries its location, from the address it is stored under', async () => {
    stubCosmos(t, { ...rowsFor([NEWS]), projects: [{ ...PROJECT_ROW, address: 'Merritt, BC' }] });

    const { body } = await get(`/api/search?dataset=RecentActivity&and%5B_id%5D=${UPDATE_ID}`);

    assert.strictEqual(body[0].searchResults[0].project.location, 'Merritt, BC');
  });

  await t.test('the Updates fields reach a public caller', async () => {
    const fields = {
      category: 'Engagement',
      subject: null,
      shortHeadline: 'Comment period opens',
      summary: 'Have your say.',
      regions: ['Lower Mainland'],
      location: 'Merritt',
      engagementUrl: 'https://engage.eao.gov.bc.ca/nicomen',
      status: 'published',
      publishDate: '2026-09-01T00:00:00.000Z'
    };
    stubCosmos(t, rowsFor([updateRow({ id: UPDATE_ID, eagleId: UPDATE_ID, ...fields })]));

    const { body } = await get(`/api/search?dataset=RecentActivity&and%5B_id%5D=${UPDATE_ID}`);

    const [row] = body[0].searchResults;
    for (const [key, value] of Object.entries(fields)) assert.deepStrictEqual(row[key], value, key);
  });

  await t.test('attachments and the featured image resolve to names, under the caller\'s access', async () => {
    const doc = (id, name) => ({ id, projectId: '207', displayName: name, documentFileName: `${id}.pdf`, read: ['public'] });
    const seen = stubCosmos(t, {
      ...rowsFor([updateRow({
        id: UPDATE_ID, eagleId: UPDATE_ID,
        featuredImage: { document: 'D-img', alt: 'Site map' }, attachments: ['D-1', 'D-hidden']
      })]),
      // What Cosmos answers the caller: `D-hidden` is not public, so the ACL predicate leaves it out.
      documents: [doc('D-img', 'Site map'), doc('D-1', 'Plan')]
    });

    const { body } = await get(`/api/search?dataset=RecentActivity&and%5B_id%5D=${UPDATE_ID}`);

    const [row] = body[0].searchResults;
    assert.deepStrictEqual(row.attachments,
      [{ _id: 'D-1', id: 'D-1', displayName: 'Plan', documentFileName: 'D-1.pdf' }],
      'a document the caller cannot read drops out');
    assert.deepStrictEqual(row.featuredImage, {
      document: { _id: 'D-img', id: 'D-img', displayName: 'Site map', documentFileName: 'D-img.pdf' },
      alt: 'Site map'
    });
    const [lookup] = specsFor(seen, 'documents');
    assert.match(lookup.query, /c\.read/, 'the lookup carries the caller\'s ACL, never system access');
    assert.ok(boundValues(lookup).includes('public'));
    assert.deepStrictEqual(boundValues(lookup).filter(v => /^D-/.test(v)).sort(), ['D-1', 'D-hidden', 'D-img']);
  });

  await t.test('a featured image the caller cannot read answers null', async () => {
    stubCosmos(t, {
      ...rowsFor([updateRow({ id: UPDATE_ID, eagleId: UPDATE_ID, featuredImage: { document: 'D-img', alt: 'x' } })]),
      documents: []
    });

    const { body } = await get(`/api/search?dataset=RecentActivity&and%5B_id%5D=${UPDATE_ID}`);

    assert.strictEqual(body[0].searchResults[0].featuredImage, null);
  });

  await t.test('a scheduled update reads as missing to the public', async () => {
    stubCosmos(t, rowsFor([updateRow({
      id: UPDATE_ID, eagleId: UPDATE_ID, status: 'published', publishDate: '2999-01-01T00:00:00.000Z'
    })]));

    const { status, body } = await get(`/api/search?dataset=RecentActivity&and%5B_id%5D=${UPDATE_ID}`);

    assert.strictEqual(status, 200);
    assert.strictEqual(body[0].count, 0);
    assert.deepStrictEqual(body[0].searchResults, []);
  });

  await t.test('a point read is a read of the id partition, not a scan', async () => {
    const seen = stubCosmos(t, rowsFor([NEWS]));

    await get(`/api/search?dataset=RecentActivity&and%5B_id%5D=${UPDATE_ID}`);

    assert.deepStrictEqual(specsFor(seen, 'updates'), [],
      '`updates` is partitioned on /id, so one row costs a readItem and no query at all');
  });

  // A MISS IS 0, NOT A PAGE. Falling through to the list branch would answer the newest updates to
  // a caller who asked for one that does not exist — a `/updates/:id` route rendering the wrong
  // record with a 200.
  await t.test('an id nothing matches answers zero rows and a measured zero', async () => {
    stubCosmos(t, rowsFor([NEWS, PCP]));

    const { status, body } = await get(
      '/api/search?dataset=RecentActivity&and%5B_id%5D=0000000000000000000000ff');

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body[0].searchResults, []);
    assert.strictEqual(body[0].count, 0);
    assert.strictEqual(body[0].meta[0].searchResultsTotal, 0);
  });

  await t.test('a row this caller may not read is a miss, not a leak', async () => {
    stubCosmos(t, rowsFor([updateRow({ id: UPDATE_ID, read: ['staff', 'sysadmin'] })]));

    const { body } = await get(
      `/api/search?dataset=RecentActivity&and%5B_id%5D=${UPDATE_ID}`);

    assert.strictEqual(body[0].count, 0);
    assert.deepStrictEqual(body[0].searchResults, []);
  });

  await t.test('keywords beside an id do not send it to the index', async () => {
    stubCosmos(t, rowsFor([NEWS]));
    let called = 0;
    // The index has to be CONFIGURED for this to test anything: with an empty SEARCH_ENDPOINT every
    // keyword search falls back to Cosmos anyway, and the guard would pass while doing nothing.
    t.mock.method(aiSearch, 'config', () => ({ configured: true, activitiesIndex: 'activities' }));
    t.mock.method(aiSearch, 'searchActivities', async () => { called++; return { items: [], count: 0 }; });

    const { body } = await get(
      `/api/search?dataset=RecentActivity&keywords=application&and%5B_id%5D=${UPDATE_ID}`);

    assert.strictEqual(called, 0, 'a point read of one record has nothing for keywords to rank');
    assert.strictEqual(body[0].count, 1);
  });
});

test('GET /search?dataset=RecentActivity&and[type]', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('narrows the read AND its count, and is reported applied', async () => {
    const seen = stubCosmos(t, rowsFor([NEWS, PCP, PN_PCP]));

    const { status, body } = await get(
      '/api/search?dataset=RecentActivity&and%5Btype%5D=News');

    assert.strictEqual(status, 200);
    // THE WHOLE POINT: `type` used to come back under `meta.dropped.filter`.
    assert.strictEqual(body[0].meta[0].dropped, undefined);

    const specs = specsFor(seen, 'updates');
    assert.strictEqual(specs.length, 2, 'the page and its total are two reads');
    for (const spec of specs) {
      assert.match(spec.query, /c\.type IN \(@type0\)/,
        'a total built from a different predicate than the page describes rows the page cannot hold');
      assert.ok(boundValues(spec).includes('News'));
    }
  });

  await t.test('a multi-select is one IN over every value the caller named', async () => {
    const seen = stubCosmos(t, rowsFor([NEWS, PCP, PN_PCP]));

    // Comma-separated is how both frontends spell a multi-select, and the live values carry spaces.
    const { status } = await get('/api/search?dataset=RecentActivity' +
      '&and%5Btype%5D=News%2CProject%20Notification%20Public%20Comment%20Period');

    assert.strictEqual(status, 200);
    const [read] = specsFor(seen, 'updates');
    assert.match(read.query, /c\.type IN \(@type0, @type1\)/);
    const bound = boundValues(read);
    assert.ok(bound.includes('News'));
    assert.ok(bound.includes('Project Notification Public Comment Period'),
      'a value with spaces in it must arrive whole, not split on them');
  });

  await t.test('no type filter adds no type clause', async () => {
    const seen = stubCosmos(t, rowsFor([NEWS, PCP]));

    const { body } = await get('/api/search?dataset=RecentActivity');

    assert.strictEqual(body[0].searchResults.length, 2);
    for (const spec of specsFor(seen, 'updates')) {
      // `c.type IN`, not `c.type`: the projection names the column too, and a bare match on it
      // would pass whatever the WHERE clause said.
      assert.ok(!/c\.type IN|c\.type =|WHERE[^]*\bfalse\b/.test(spec.query),
        'an absent filter adds no clause, and is never the empty-list `false` one');
    }
  });

  // `and[type]=` with nothing after the `=` splits to zero values, the same as the key never being
  // sent — the index path (`eagleQuery.buildFilter`) already reads it that way, and `typeCriteria`
  // has to agree or the same URL means two different things depending on whether keywords are on.
  await t.test('an empty and[type]= adds no clause and is not reported applied', async () => {
    const seen = stubCosmos(t, rowsFor([NEWS, PCP]));

    const { body } = await get('/api/search?dataset=RecentActivity&and%5Btype%5D=');

    assert.strictEqual(body[0].searchResults.length, 2, 'an emptied filter matches everything');
    assert.strictEqual(body[0].meta[0].dropped, undefined, 'not dropped: it was read, just empty');
    for (const spec of specsFor(seen, 'updates')) {
      assert.ok(!/c\.type IN|c\.type =|WHERE[^]*\bfalse\b/.test(spec.query),
        'an emptied filter is not the empty-list `false` clause either');
    }
  });

  await t.test('it composes with a project filter rather than replacing it', async () => {
    const seen = stubCosmos(t, rowsFor([NEWS, PCP]));

    const { body } = await get('/api/search?dataset=RecentActivity' +
      `&and%5Bproject%5D=${PROJECT_ROW.eagleId}&and%5Btype%5D=News`);

    assert.strictEqual(body[0].meta[0].dropped, undefined, 'both keys were applied');
    const [read] = specsFor(seen, 'updates');
    assert.match(read.query, /c\.type IN/);
    // The EAGLE project id: `updates.projectId` holds the id eagle-api pushed, not the DEMI one.
    assert.ok(boundValues(read).includes(PROJECT_ROW.eagleId));
  });

  // The keyword path filters type through the `activities` index and must keep doing so — the
  // Cosmos branch is the fallback, not a second implementation of the same URL.
  await t.test('with keywords the index still answers, and the type goes into its $filter',
    async () => {
      stubCosmos(t, rowsFor([NEWS]));
      let sent = null;
      t.mock.method(aiSearch, 'config', () => ({ configured: true, activitiesIndex: 'activities' }));
      t.mock.method(aiSearch, 'searchActivities', async (opts) => {
        sent = opts;
        return { items: [{ id: UPDATE_ID }], count: 1 };
      });

      const { status, body } = await get(
        '/api/search?dataset=RecentActivity&keywords=application&and%5Btype%5D=News');

      assert.strictEqual(status, 200);
      assert.ok(sent, 'the index answered this page');
      assert.match(sent.filter, /type/);
      assert.strictEqual(body[0].meta[0].dropped, undefined);
    });
});
