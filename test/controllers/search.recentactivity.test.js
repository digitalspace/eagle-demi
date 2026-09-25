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
  PROJECT_ROW, PRIVATE_ACL, stubCosmos, specsFor, boundValues, get, getAsStaff, updateRow, notificationRow
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
      alt: 'Site map', caption: null, credit: null
    });
    const [lookup] = specsFor(seen, 'documents');
    assert.match(lookup.query, /c\.read/, 'the lookup carries the caller\'s ACL, never system access');
    assert.ok(boundValues(lookup).includes('public'));
    assert.deepStrictEqual(boundValues(lookup).filter(v => /^D-/.test(v)).sort(), ['D-1', 'D-hidden', 'D-img']);
  });

  await t.test('the featured image carries its caption and credit', async () => {
    stubCosmos(t, {
      ...rowsFor([updateRow({
        id: UPDATE_ID, eagleId: UPDATE_ID,
        featuredImage: { document: 'D-img', alt: 'Site map', caption: 'Looking north', credit: 'EAO' }
      })]),
      documents: [{ id: 'D-img', projectId: '207', displayName: 'Site map', documentFileName: 'D-img.jpg', read: ['public'] }]
    });

    const { body } = await get(`/api/search?dataset=RecentActivity&and%5B_id%5D=${UPDATE_ID}`);

    const { caption, credit } = body[0].searchResults[0].featuredImage;
    assert.deepStrictEqual({ caption, credit }, { caption: 'Looking north', credit: 'EAO' });
  });

  await t.test('a featured image the caller cannot read answers null', async () => {
    stubCosmos(t, {
      ...rowsFor([updateRow({ id: UPDATE_ID, eagleId: UPDATE_ID, featuredImage: { document: 'D-img', alt: 'x' } })]),
      documents: []
    });

    const { body } = await get(`/api/search?dataset=RecentActivity&and%5B_id%5D=${UPDATE_ID}`);

    assert.strictEqual(body[0].searchResults[0].featuredImage, null);
  });

  await t.test('the gallery resolves to names in display order, not lookup order', async () => {
    const doc = (id) => ({ id, projectId: '207', displayName: `Photo ${id}`, documentFileName: `${id}.jpg`, read: ['public'] });
    stubCosmos(t, {
      ...rowsFor([updateRow({ id: UPDATE_ID, eagleId: UPDATE_ID, images: [
        { document: 'D-b', alt: 'Second upload, shown first', caption: 'Looking north', credit: 'EAO' },
        { document: 'D-a', alt: 'First upload', caption: null, credit: null }
      ] })]),
      documents: [doc('D-a'), doc('D-b')]
    });

    const { body } = await get(`/api/search?dataset=RecentActivity&and%5B_id%5D=${UPDATE_ID}`);

    assert.deepStrictEqual(body[0].searchResults[0].images, [
      {
        document: { _id: 'D-b', id: 'D-b', displayName: 'Photo D-b', documentFileName: 'D-b.jpg' },
        alt: 'Second upload, shown first', caption: 'Looking north', credit: 'EAO'
      },
      {
        document: { _id: 'D-a', id: 'D-a', displayName: 'Photo D-a', documentFileName: 'D-a.jpg' },
        alt: 'First upload', caption: null, credit: null
      }
    ]);
  });

  await t.test('a gallery image the caller cannot read drops out, and the rest keep their order', async () => {
    const doc = (id) => ({ id, projectId: '207', displayName: id, documentFileName: `${id}.jpg`, read: ['public'] });
    const seen = stubCosmos(t, {
      ...rowsFor([updateRow({ id: UPDATE_ID, eagleId: UPDATE_ID, images: [
        { document: 'D-3', alt: 'three' }, { document: 'D-hidden', alt: 'hidden' }, { document: 'D-1', alt: 'one' }
      ] })]),
      // What Cosmos answers the caller: `D-hidden` is not public, so the ACL predicate leaves it out.
      documents: [doc('D-1'), doc('D-3')]
    });

    const { body } = await get(`/api/search?dataset=RecentActivity&and%5B_id%5D=${UPDATE_ID}`);

    assert.deepStrictEqual(body[0].searchResults[0].images.map(image => image.alt), ['three', 'one']);
    const [lookup] = specsFor(seen, 'documents');
    assert.ok(boundValues(lookup).includes('public'), 'the lookup carries the caller\'s ACL');
    assert.ok(boundValues(lookup).includes('D-hidden'), 'the hidden image was asked for and refused');
  });

  await t.test('a row stored before the gallery answers no images key', async () => {
    stubCosmos(t, rowsFor([updateRow({ id: UPDATE_ID, eagleId: UPDATE_ID })]));

    const { body } = await get(`/api/search?dataset=RecentActivity&and%5B_id%5D=${UPDATE_ID}`);

    assert.ok(!('images' in body[0].searchResults[0]), 'no key, not an empty list');
  });

  // The document lookup is cross-partition, so it is sent in reads of at most 200 ids.
  await t.test('201 referenced documents are looked up in two reads, and all resolve', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `D-${i}`);
    const seen = stubCosmos(t, {
      ...rowsFor([updateRow({ id: UPDATE_ID, eagleId: UPDATE_ID, attachments: ids })]),
      documents: ids.map(id => ({ id, projectId: '207', displayName: id, documentFileName: `${id}.pdf`, read: ['public'] }))
    });

    const { body } = await get(`/api/search?dataset=RecentActivity&and%5B_id%5D=${UPDATE_ID}`);

    const idsPerRead = specsFor(seen, 'documents').map(spec => boundValues(spec).filter(v => /^D-/.test(v)).length);
    assert.deepStrictEqual(idsPerRead, [200, 1]);
    assert.strictEqual(body[0].searchResults[0].attachments.length, 201);
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

test('GET /search?dataset=RecentActivity — the parent gates its updates', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const HIDDEN_EAGLE_ID = '588511d0aaecd9001b8256ff';
  const UNPUBLISHED = { id: '208', eagleId: HIDDEN_EAGLE_ID, name: 'Unpublished Mine', read: PRIVATE_ACL };
  // Stored before the push capped by parent: Eagle's own public ACL, under a private project.
  const UNDER_UNPUBLISHED = updateRow({ id: 'u-hidden', eagleId: 'u-hidden', projectId: HIDDEN_EAGLE_ID });
  const CORPORATE = updateRow({ id: 'u-corp', eagleId: 'u-corp', projectId: null, pinned: false });

  const stubParents = (t, { updates, projects = [PROJECT_ROW, UNPUBLISHED], notifications = [notificationRow()] }) =>
    stubCosmos(t, { projects, notifications, updates });
  const ids = (body) => body[0].searchResults.map(r => r._id);

  await t.test('an anonymous caller sees no update of an unpublished project, and the count agrees', async () => {
    const seen = stubParents(t, { updates: [NEWS, UNDER_UNPUBLISHED, CORPORATE] });

    const { status, body } = await get('/api/search?dataset=RecentActivity');

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(ids(body), [UPDATE_ID, 'u-corp']);
    assert.strictEqual(body[0].count, 2, 'the total cannot be used to probe a hidden update');
    const [read, counted] = specsFor(seen, 'updates');
    for (const spec of [read, counted]) {
      assert.match(spec.query, /NOT ARRAY_CONTAINS\(@hiddenParents, c\.projectId\)/);
    }
  });

  await t.test('staff, who can read the project, see it', async () => {
    stubParents(t, { updates: [NEWS, UNDER_UNPUBLISHED, CORPORATE] });

    const { body } = await getAsStaff(t, '/api/search?dataset=RecentActivity');

    assert.deepStrictEqual(ids(body), [UPDATE_ID, 'u-hidden', 'u-corp']);
    assert.strictEqual(body[0].searchResults[1].project.name, 'Unpublished Mine');
  });

  await t.test('the point read answers nothing for it', async () => {
    stubParents(t, { updates: [UNDER_UNPUBLISHED] });

    const { body } = await get('/api/search?dataset=RecentActivity&and%5B_id%5D=u-hidden');

    assert.strictEqual(body[0].count, 0);
    assert.deepStrictEqual(body[0].searchResults, []);
  });

  await t.test('nor does the home-page strip, which fills from the rows it may show', async () => {
    const seen = stubParents(t, { updates: [UNDER_UNPUBLISHED, CORPORATE] });

    const { body } = await get('/api/search?dataset=RecentActivity&top=true');

    assert.ok(!ids(body).includes('u-hidden'));
    for (const spec of specsFor(seen, 'updates')) {
      assert.match(spec.query, /@hiddenParents/, 'excluded in the query, before the limit');
    }
  });

  await t.test('an update under a notification the caller cannot read is hidden too', async () => {
    const privateNotification = notificationRow({ id: HIDDEN_EAGLE_ID, eagleId: HIDDEN_EAGLE_ID, read: PRIVATE_ACL });
    stubParents(t, { updates: [UNDER_UNPUBLISHED, CORPORATE], projects: [PROJECT_ROW], notifications: [privateNotification] });

    const { body } = await get('/api/search?dataset=RecentActivity');

    assert.deepStrictEqual(ids(body), ['u-corp']);
  });

  await t.test('a public notification wins its id over a private Track project carrying it', async () => {
    const track = { id: '353', eagleId: HIDDEN_EAGLE_ID, name: 'Shadow Track Project', read: PRIVATE_ACL };
    stubParents(t, {
      updates: [UNDER_UNPUBLISHED],
      projects: [PROJECT_ROW, track],
      notifications: [notificationRow({ id: HIDDEN_EAGLE_ID, eagleId: HIDDEN_EAGLE_ID })]
    });

    const { body } = await get('/api/search?dataset=RecentActivity');

    assert.deepStrictEqual(ids(body), ['u-hidden']);
  });

  await t.test('a parent DEMI does not hold hides nothing, as in eagle-api', async () => {
    stubParents(t, { updates: [UNDER_UNPUBLISHED], projects: [PROJECT_ROW] });

    const { body } = await get('/api/search?dataset=RecentActivity');

    assert.deepStrictEqual(ids(body), ['u-hidden']);
  });

  await t.test('the parents are read once per request, not once per query', async () => {
    const seen = stubParents(t, { updates: [NEWS, UNDER_UNPUBLISHED] });

    await get('/api/search?dataset=RecentActivity');

    const scans = specsFor(seen, 'projects').filter(spec => /c\.read FROM c WHERE IS_DEFINED/.test(spec.query));
    assert.strictEqual(scans.length, 1, 'the page and its count share one lookup');
  });

  await t.test('with keywords, the index filter and its count exclude the hidden parent', async () => {
    stubParents(t, { updates: [NEWS] });
    let sent = null;
    t.mock.method(aiSearch, 'config', () => ({ configured: true, activitiesIndex: 'activities' }));
    t.mock.method(aiSearch, 'searchActivities', async (opts) => { sent = opts; return { items: [{ id: UPDATE_ID }], count: 1 }; });

    await get('/api/search?dataset=RecentActivity&keywords=application');

    assert.ok(sent.filter.includes(`not search.in(projectId, '${HIDDEN_EAGLE_ID}', ',')`), sent.filter);
  });

  await t.test('a quote in a hidden parent id is escaped, not able to close the filter literal', async () => {
    const quoted = { ...UNPUBLISHED, id: '209', eagleId: "x') or true or ('" };
    stubParents(t, { updates: [NEWS], projects: [PROJECT_ROW, quoted] });
    let sent = null;
    t.mock.method(aiSearch, 'config', () => ({ configured: true, activitiesIndex: 'activities' }));
    t.mock.method(aiSearch, 'searchActivities', async (opts) => { sent = opts; return { items: [{ id: UPDATE_ID }], count: 1 }; });

    await get('/api/search?dataset=RecentActivity&keywords=application');

    assert.ok(sent.filter.includes("not search.in(projectId, 'x'') or true or (''', ',')"), sent.filter);
  });
});
