'use strict';

/**
 * The Cosmos-backed `/search` datasets — the reads eagle-public used to make against eagle-api.
 *
 * One case per dataset and per guard. The two home-page reads have their own files beside this one
 * (`search.commentperiods`, `search.recentactivity`); the harness they all share, and why it stubs
 * where it does, is `test/helpers/search-reads.js`.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const aiSearch = require('../../src/search/ai-search');
const searchController = require('../../src/controllers/search');
const { logger } = require('../../src/utils/logger');
const {
  PROJECT_EAGLE_ID, PERIOD_EAGLE_ID, PUBLIC_ACL, PROJECT_ROW,
  stubCosmos, specsFor, boundValues, get, getAsStaff,
  listRow, orgRow, periodRow, commentRow, updateRow, notificationRow
} = require('../helpers/search-reads');

test('GET /search?dataset=List', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('answers every lookup row in the shape eagle-public keys on', async () => {
    const seen = stubCosmos(t, { lists: [listRow()] }, { lists: 251 });

    const { status, body } = await get('/api/search?dataset=List&pageSize=250');

    assert.strictEqual(status, 200);
    const [row] = body[0].searchResults;
    // eagle-public's `idToList()` looks rows up by `_id` and renders `name`; `item` is the BC Laws
    // link and `listOrder` the sort the picker uses.
    assert.strictEqual(row._id, '5cf00c03a266b7e1877504ca');
    assert.strictEqual(row._schemaName, 'List');
    assert.strictEqual(row.type, 'doctype');
    assert.strictEqual(row.name, 'Amendment Package');
    assert.strictEqual(row.item,
      'https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/370_2002');
    // A NUMBER: eagle-public compares `legislation === 2002`, and the backfill stored the year as
    // a string, so a row that answered '2002' rendered under no legislation at all.
    assert.strictEqual(row.legislation, 2002);
    assert.strictEqual(row.listOrder, 12);

    // The total is MEASURED and is the container's, not the page's — eagle-public pages on it.
    assert.strictEqual(body[0].count, 251);
    assert.strictEqual(body[0].meta[0].searchResultsTotal, 251);

    assert.strictEqual(row.read, undefined, 'the ACL is not published');
    assert.strictEqual(row.sources, undefined, 'the raw Eagle payload is not published');

    const [read] = specsFor(seen, 'lists');
    assert.match(read.query, /c\.kind = @kind/);
    assert.ok(boundValues(read).includes('List'));
    assert.ok(boundValues(read).includes('public'),
      'the anonymous ACL reached Cosmos — a systemAccess read would not bind it');
  });
});

test('GET /search?dataset=Organization', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('filters by companyType in BOTH wire shapes and sorts by name', async () => {
    for (const query of [
      'companyType=Proponent%2FCertificate%20Holder',
      'and%5BcompanyType%5D=Proponent%2FCertificate%20Holder'
    ]) {
      t.mock.restoreAll();
      const seen = stubCosmos(t, { lists: [orgRow()] });

      const { status, body } = await get(
        `/api/search?dataset=Organization&${query}&sortBy=%2Bname`);

      assert.strictEqual(status, 200, query);
      assert.strictEqual(body[0].searchResults[0].name, 'Nicomen Energy Ltd', query);
      assert.strictEqual(body[0].searchResults[0]._schemaName, 'Organization', query);
      // Applied, so the caller is never told it was dropped.
      assert.strictEqual(body[0].meta[0].dropped, undefined, query);

      const [read, count] = specsFor(seen, 'lists');
      assert.match(read.query, /c\.companyType = @companyType/, query);
      assert.match(read.query, /ORDER BY c\.name ASC$/, query);
      assert.ok(boundValues(read).includes('Organization'), query);
      // The total describes the SAME set as the page, or it advertises rows the picker cannot show.
      assert.match(count.query, /c\.companyType = @companyType/, query);
    }
  });
});

test('GET /search?dataset=CommentPeriod', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('scopes to the project and carries the EAGLE project id back', async () => {
    const seen = stubCosmos(t,
      { projects: [PROJECT_ROW], commentPeriods: [periodRow()] }, { commentPeriods: 3 });

    const { status, body } = await get(
      `/api/search?dataset=CommentPeriod&and%5Bproject%5D=${PROJECT_EAGLE_ID}&sortBy=-dateStarted`);

    assert.strictEqual(status, 200);
    const [row] = body[0].searchResults;
    assert.strictEqual(row._id, PERIOD_EAGLE_ID);
    assert.strictEqual(row._schemaName, 'CommentPeriod');
    // eagle-public's CommentPeriod model reads `period.project` and hands it straight to a project
    // URL, so it must be the EAGLE id even though the row is partitioned on the DEMI one.
    assert.strictEqual(row.project, PROJECT_EAGLE_ID);
    assert.strictEqual(row.projectId, '207');
    assert.strictEqual(row.instructions, 'Tell us what you think.');
    // Both carried from Eagle at the same visibility as `instructions`: eagle-public renders
    // `additionalText` as the period's blurb, and the Engage callout has no image without
    // `metBannerImageUrl`. A field the catalog does not publish is dropped here, silently.
    assert.strictEqual(row.additionalText, 'Comment on the amendment application.');
    assert.strictEqual(row.metBannerImageUrl, 'https://engage.gov.bc.ca/banner.jpg');
    assert.strictEqual(body[0].count, 3);
    assert.strictEqual(body[0].meta[0].searchResultsTotal, 3);
    // `canScopeToProject` must admit this dataset, or the guard answers 0 rows and reports the
    // project filter as dropped.
    assert.strictEqual(body[0].meta[0].dropped, undefined);

    const [read] = specsFor(seen, 'commentPeriods');
    // The DEMI project id, translated from the Eagle one before the read.
    assert.ok(boundValues(read).includes('207'));
    assert.ok(!boundValues(read).includes(PROJECT_EAGLE_ID),
      'the Eagle ObjectId must not reach a container partitioned on DEMI ids');
    assert.ok(boundValues(read).includes('public'), 'the anonymous ACL reached Cosmos');
    assert.match(read.query, /ORDER BY c\.dateStarted DESC$/);
  });

  await t.test('a period under a project this caller cannot see answers nothing', async () => {
    // The project point read is ACL-enforcing, so an unpublished project resolves to no DEMI id and
    // the period read is never made. This is the case that decides whether an unpublished
    // project's engagement tab is readable through the mirror.
    stubCosmos(t, { projects: [], commentPeriods: [periodRow()] });

    const { body } = await get(
      `/api/search?dataset=CommentPeriod&and%5Bproject%5D=${PROJECT_EAGLE_ID}`);

    // The unresolved Eagle id passes through as a literal and matches no partition.
    assert.deepStrictEqual(body[0].searchResults, []);
  });

  await t.test('a period under a ProjectNotification carries the notification id back', async () => {
    // Eagle hangs some periods off a ProjectNotification, and the mirror partitions those under
    // the notification's own id. Resolving the parent through `projects` alone answered
    // `project: null`, and eagle-public's CommentPeriod model has nowhere to link that.
    const notification = notificationRow();
    const seen = stubCosmos(t, {
      notifications: [notification],
      commentPeriods: [periodRow({ projectId: notification.id })]
    });

    const { status, body } = await get(
      `/api/search?dataset=CommentPeriod&and%5Bproject%5D=${notification.id}`);

    assert.strictEqual(status, 200);
    const [row] = body[0].searchResults;
    assert.strictEqual(row._id, PERIOD_EAGLE_ID);
    assert.strictEqual(row.project, notification.id);
    assert.strictEqual(row.projectId, notification.id);
    // The read is a partition read on the notification id: the id space is the caller's own.
    assert.ok(boundValues(specsFor(seen, 'commentPeriods')[0]).includes(notification.id));
  });

  // Some Track projects carry a ProjectNotification _id in `epic_guid`, which the merge copies to
  // the project row's `eagleId` (test 2026-09-08: Track 351 and 353). eagle-public sends the
  // notification's own id as its project filter, so translating it to that project searched a
  // partition holding none of the notification's periods.
  await t.test('a project row carrying the notification id does not capture the filter', async () => {
    const notification = notificationRow();
    const seen = stubCosmos(t, {
      projects: [{ id: '353', eagleId: notification.id, name: 'Shadow', read: PUBLIC_ACL }],
      notifications: [notification],
      commentPeriods: [periodRow({ projectId: notification.id })]
    });

    const { status, body } = await get(
      `/api/search?dataset=CommentPeriod&and%5Bproject%5D=${notification.id}`);

    assert.strictEqual(status, 200);
    assert.strictEqual(body[0].searchResults.length, 1, 'the notification partition was read');
    assert.strictEqual(body[0].searchResults[0]._id, PERIOD_EAGLE_ID);
    const bound = boundValues(specsFor(seen, 'commentPeriods')[0]);
    assert.ok(bound.includes(notification.id), 'the filter keeps the notification id');
    assert.ok(!bound.includes('353'), 'and never becomes the shadowing project id');
  });

  await t.test('a period under a notification this caller cannot see is withheld', async () => {
    // The lookup is ACL-enforcing on the notification too, and a period row that survived the
    // period ACL must not reach a caller who may not read its parent.
    stubCosmos(t, { notifications: [], commentPeriods: [periodRow({ projectId: 'PN1' })] });

    const { body } = await get('/api/search?dataset=CommentPeriod&and%5Bproject%5D=PN1');

    assert.deepStrictEqual(body[0].searchResults, []);
  });

  await t.test('and[_id] fetches one period', async () => {
    stubCosmos(t, { projects: [PROJECT_ROW], commentPeriods: [periodRow()] });

    const { body } = await get(
      `/api/search?dataset=CommentPeriod&and%5B_id%5D=${PERIOD_EAGLE_ID}`);

    assert.strictEqual(body[0].count, 1);
    assert.strictEqual(body[0].searchResults[0]._id, PERIOD_EAGLE_ID);
  });
});

test('GET /search?dataset=Comment', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('pages a period, and the total is the whole period', async () => {
    const seen = stubCosmos(t, { comments: [commentRow()] }, { comments: 87 });

    const { status, body } = await get(
      `/api/search?dataset=Comment&and%5Bperiod%5D=${PERIOD_EAGLE_ID}&sortBy=-commentId&pageNum=0&pageSize=10`);

    assert.strictEqual(status, 200);
    const [row] = body[0].searchResults;
    assert.strictEqual(row._id, '5b8bcf0d0f5e9c0019a7a1c2');
    assert.strictEqual(row._schemaName, 'Comment');
    assert.strictEqual(row.period, PERIOD_EAGLE_ID, "eagle-public's Comment model reads `period`");
    assert.strictEqual(row.comment, 'Please consider the wetland.');
    // The three fields eagle-public's Comment model reads beyond the text itself. `location` is
    // free text the commenter typed and is public in eagle-api too (ALLOWED_FIELDS, publicGet as
    // `['public']`), so it is public here.
    assert.strictEqual(row.dateUpdated, '2026-08-06T00:00:00.000Z');
    assert.strictEqual(row.location, 'Nicomen Island');
    assert.strictEqual(row.submittedCAC, true);
    // eagle-public pages the comment table off this number, so it is the period's total and not
    // the page length.
    assert.strictEqual(body[0].count, 87);
    assert.strictEqual(body[0].meta[0].searchResultsTotal, 87);

    const [read, count] = specsFor(seen, 'comments');
    assert.match(read.query, /c\.periodId = @periodId/);
    assert.match(read.query, /ORDER BY c\.commentId DESC$/);
    assert.match(count.query, /c\.periodId = @periodId/);
  });

  await t.test('the author of an anonymous comment is withheld from the public and kept for staff',
    async () => {
      stubCosmos(t, { comments: [commentRow()] });
      const anon = await get(`/api/search?dataset=Comment&period=${PERIOD_EAGLE_ID}`);
      assert.strictEqual(anon.body[0].searchResults[0].author, undefined);
      assert.strictEqual(anon.body[0].searchResults[0].isAnonymous, true);

      t.mock.restoreAll();
      stubCosmos(t, { comments: [commentRow()] });
      const staff = await getAsStaff(t, `/api/search?dataset=Comment&period=${PERIOD_EAGLE_ID}`);
      assert.strictEqual(staff.body[0].searchResults[0].author, 'Jane Public');
    });

  await t.test('a comment under an unpublished period is not readable', async () => {
    // A comment may never out-rank its period: the mirror stores it private, and the read carries
    // the caller's own ACL into the predicate. Both halves matter — this asserts the second.
    const seen = stubCosmos(t, { comments: [] });

    const { body } = await get(`/api/search?dataset=Comment&and%5Bperiod%5D=${PERIOD_EAGLE_ID}`);

    assert.deepStrictEqual(body[0].searchResults, []);
    assert.strictEqual(body[0].count, 0);
    const [read] = specsFor(seen, 'comments');
    assert.match(read.query, /ARRAY_CONTAINS\(c\.read/,
      'the visibility predicate is what withholds a private comment');
    assert.ok(boundValues(read).includes('public'));
  });

  await t.test('a comment read with no period and no id is refused, never answered empty',
    async () => {
      stubCosmos(t, { comments: [commentRow()] });
      const { status, body } = await get('/api/search?dataset=Comment');
      assert.strictEqual(status, 400);
      assert.match(body.error, /requires and\[period\]/);
    });
});

test('GET /search?dataset=RecentActivity', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('top=true is pinned first, capped at four, with the project resolved', async () => {
    const pinned = [1, 2].map(n => updateRow({ id: `pin-${n}`, eagleId: `pin-${n}`, pinned: true }));
    const unpinned = [1, 2, 3, 4].map(n =>
      updateRow({ id: `un-${n}`, eagleId: `un-${n}`, pinned: false }));

    // The two states are two queries; served in call order, pinned first.
    let call = 0;
    t.mock.method(cosmos, 'query', async (container, spec) => {
      if (container === 'projects') return { items: [PROJECT_ROW] };
      // The two references an update carries, as the repositories project them.
      if (container === 'commentPeriods') {
        return { items: [{ id: PERIOD_EAGLE_ID, isMet: true, metURL: 'https://eao.gov.bc.ca/met' }] };
      }
      if (container === 'notifications') {
        return { items: [{ id: '5f0e4a0c3f4b1a0021a1b2c3', name: 'Bear Creek Quarry' }] };
      }
      if (/COUNT\(1\)/.test(spec.query)) return { items: [6] };
      return { items: call++ === 0 ? pinned : unpinned };
    });

    const { status, body } = await get('/api/search?dataset=RecentActivity&top=true');

    assert.strictEqual(status, 200);
    const ids = body[0].searchResults.map(r => r._id);
    // FOUR IN TOTAL, pinned first — what eagle-api's /api/public/recentActivity?top=true answers.
    assert.deepStrictEqual(ids, ['pin-1', 'pin-2', 'un-1', 'un-2']);
    assert.strictEqual(body[0].count, 4);

    const [row] = body[0].searchResults;
    assert.strictEqual(row._schemaName, 'RecentActivity');
    assert.strictEqual(row.headline, 'Application accepted');
    assert.strictEqual(row.pinned, true);
    // Everything else eagle-public's News model reads off the row.
    assert.strictEqual(row.active, true);
    assert.strictEqual(row.notificationName, 'Nicomen Wind Energy');
    assert.strictEqual(row.contentUrl,
      'https://projects.eao.gov.bc.ca/p/588511d0aaecd9001b825604/news');
    assert.strictEqual(row.documentUrl,
      'https://projects.eao.gov.bc.ca/api/document/5cf00c03a266b7e187750002/fetch');
    // OBJECTS, not the bare ids the mirror stores: the News template reads `pcp.isMet` and
    // `projectNotification.name`, and a string answers both with undefined.
    assert.deepStrictEqual(row.pcp,
      { _id: PERIOD_EAGLE_ID, isMet: true, metURL: 'https://eao.gov.bc.ca/met' });
    assert.deepStrictEqual(row.projectNotification,
      { _id: '5f0e4a0c3f4b1a0021a1b2c3', name: 'Bear Creek Quarry' });
    assert.deepStrictEqual(row.project, { _id: PROJECT_EAGLE_ID, name: 'Nicomen Wind Energy', location: null });
    assert.strictEqual(row.notifiedAt, undefined, 'the notify claim is not public');
    assert.strictEqual(row.read, undefined);
  });

  await t.test('a project filter keeps the EAGLE id, which is what this container stores',
    async () => {
      const seen = stubCosmos(t, { projects: [PROJECT_ROW], updates: [updateRow()] }, { updates: 9 });

      const { body } = await get(
        `/api/search?dataset=RecentActivity&and%5Bproject%5D=${PROJECT_EAGLE_ID}&pageSize=25`);

      assert.strictEqual(body[0].count, 9);
      assert.strictEqual(body[0].meta[0].dropped, undefined, 'the project filter is applied');

      const [read] = specsFor(seen, 'updates');
      assert.match(read.query, /c\.projectId = @projectId/);
      assert.ok(boundValues(read).includes(PROJECT_EAGLE_ID),
        'updates.projectId holds the Eagle id — the translated DEMI id would match nothing');
      assert.match(read.query, /ORDER BY c\.dateAdded DESC$/);
    });

  await t.test('a page of updates resolves every project in ONE query', async () => {
    // One query PER ROW is what this replaced: `pageSlice` allows a 1000-row page, so a per-row
    // lookup is 1000 cross-partition reads of the projects container per anonymous request.
    const eagleIds = ['588511d0aaecd9001b825601', '588511d0aaecd9001b825602', PROJECT_EAGLE_ID];
    const rows = eagleIds.map((eagleId, i) =>
      updateRow({ id: `u${i}`, eagleId: `u${i}`, projectId: eagleId }));
    const projectRows = eagleIds.map((eagleId, i) => ({
      id: `${200 + i}`, eagleId, name: `Project ${i}`, read: PUBLIC_ACL
    }));
    const seen = stubCosmos(t, { projects: projectRows, updates: rows }, { updates: 3 });

    const { status, body } = await get('/api/search?dataset=RecentActivity&pageSize=25');

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body[0].searchResults.map(r => r.project.name),
      ['Project 0', 'Project 1', 'Project 2']);

    // The parent gate's one whole-container read aside, which is per request, not per row.
    const projectSpecs = specsFor(seen, 'projects').filter(spec => !/c\.read FROM c WHERE IS_DEFINED/.test(spec.query));
    assert.strictEqual(projectSpecs.length, 1, 'one batched read, not one per row');
    assert.match(projectSpecs[0].query, /c\.eagleId IN \(@eid0, @eid1, @eid2\)/);
    assert.match(projectSpecs[0].query, /SELECT c\.id, c\.name, c\.eagleId/,
      'the label is projected, never the whole project record');
  });

  await t.test('a reference this caller cannot resolve is DROPPED, not left as an id', async () => {
    // `pcp: '<id>'` renders as `pcp.isMet === undefined`, which the News template reads as a period
    // that exists and is not met. An absent key reads as no period at all, which is the truth.
    stubCosmos(t, { projects: [PROJECT_ROW], updates: [updateRow()] });

    const { body } = await get('/api/search?dataset=RecentActivity');

    const [row] = body[0].searchResults;
    assert.strictEqual(row.pcp, undefined);
    assert.strictEqual(row.projectNotification, undefined);
  });

  await t.test('keywords search the headline and the content, and -score means newest first',
    async () => {
      const seen = stubCosmos(t, { projects: [PROJECT_ROW], updates: [updateRow()] });

      const { status } = await get(
        '/api/search?dataset=RecentActivity&keywords=Application&sortBy=-score');

      assert.strictEqual(status, 200);
      const [read, counted] = specsFor(seen, 'updates');
      assert.match(read.query,
        /CONTAINS\(c\.headline, @keywords, true\) OR CONTAINS\(c\.content, @keywords, true\)/);
      // The same text the index searches, so the fallback cannot miss what the index would find.
      assert.match(read.query,
        /CONTAINS\(c\.shortHeadline, @keywords, true\) OR CONTAINS\(c\.summary, @keywords, true\)/);
      assert.ok(boundValues(read).includes('Application'));
      // There is no relevance rank on a Cosmos read, and `-score` must not fall through to an
      // ORDER BY on a field these rows do not carry — that drops every row.
      assert.match(read.query, /ORDER BY c\.dateAdded DESC$/);
      // The count carries the same keyword predicate, or it advertises the unfiltered total.
      assert.match(counted.query, /CONTAINS\(c\.headline/);
    });
});

test('GET /search?dataset=ProjectNotification', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('lists newest first, and and[_id] fetches one', async () => {
    const seen = stubCosmos(t, { notifications: [notificationRow()] }, { notifications: 17 });

    const list = await get('/api/search?dataset=ProjectNotification');
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body[0].searchResults[0]._id, '5f0e4a0c3f4b1a0021a1b2c3');
    assert.strictEqual(list.body[0].searchResults[0]._schemaName, 'ProjectNotification');
    assert.strictEqual(list.body[0].searchResults[0].name, 'Bear Creek Quarry');
    assert.strictEqual(list.body[0].count, 17);
    assert.match(specsFor(seen, 'notifications')[0].query,
      /ORDER BY c\.notificationReceivedDate DESC$/);

    const one = await get('/api/search?dataset=ProjectNotification&and%5B_id%5D=5f0e4a0c3f4b1a0021a1b2c3');
    assert.strictEqual(one.body[0].count, 1);
    assert.strictEqual(one.body[0].searchResults[0].name, 'Bear Creek Quarry');
  });

  await t.test('the four page filters narrow the read AND its count', async () => {
    const seen = stubCosmos(t, { notifications: [notificationRow()] });

    const { body } = await get('/api/search?dataset=ProjectNotification' +
      '&and%5Btype%5D=Project%20Notification&and%5Bregion%5D=Cariboo' +
      '&and%5Bpcp%5D=none&and%5Bdecision%5D=In%20Progress');

    assert.strictEqual(body[0].meta[0].dropped, undefined, 'all four are applied, none dropped');
    const [read, counted] = specsFor(seen, 'notifications');
    for (const field of ['type', 'region', 'pcp', 'decision']) {
      assert.match(read.query, new RegExp(`c\\.${field} = @${field}`));
    }
    assert.strictEqual(counted.query.split(' WHERE ')[1], read.query.split(' WHERE ')[1]
      .split(' ORDER BY ')[0], 'the count shares the filter, or it sizes a different set');
  });

  await t.test('sortBy=-_id is the arrival order these rows actually carry', async () => {
    // `_id` is Mongo's; a single-property ORDER BY on a field the mirror never wrote drops every
    // row, so the wire key maps onto the received date rather than reaching Cosmos as written.
    const seen = stubCosmos(t, { notifications: [notificationRow()] });

    await get('/api/search?dataset=ProjectNotification&sortBy=-_id');

    assert.match(specsFor(seen, 'notifications')[0].query,
      /ORDER BY c\.notificationReceivedDate DESC$/);
  });

  await t.test('a proponent stored as an Organization id renders as its name', async () => {
    const org = {
      id: '58850f69aaecd9001b8085cc', kind: 'Organization', name: 'Nicomen Energy Ltd',
      read: PUBLIC_ACL
    };
    const seen = stubCosmos(t, {
      notifications: [notificationRow({ proponent: '58850f69aaecd9001b8085cc' })],
      lists: [org]
    });

    const { body } = await get('/api/search?dataset=ProjectNotification');

    assert.strictEqual(body[0].searchResults[0].proponent, 'Nicomen Energy Ltd');
    assert.strictEqual(specsFor(seen, 'lists').length, 1, 'one batched lookup for the page');
  });

  await t.test('a proponent stored as a name costs no lookup', async () => {
    const seen = stubCosmos(t, {
      notifications: [notificationRow({ proponent: 'Nicomen Energy Ltd' })]
    });

    const { body } = await get('/api/search?dataset=ProjectNotification');

    assert.strictEqual(body[0].searchResults[0].proponent, 'Nicomen Energy Ltd');
    assert.deepStrictEqual(specsFor(seen, 'lists'), [], 'only an ObjectId is worth resolving');
  });
});

test('the /search query gate', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('the new bare parameters are accepted and a junk one is still refused', async () => {
    stubCosmos(t, { lists: [listRow()] });

    const ok = await get(
      '/api/search?dataset=List&top=true&period=1&companyType=x&docIds=a%7Cb&_id=1');
    assert.strictEqual(ok.status, 200);

    const bad = await get('/api/search?dataset=List&notAParam=1');
    assert.strictEqual(bad.status, 400);
    assert.match(bad.body.error, /Unsupported query parameter: notAParam/);
  });

  await t.test('a bare parameter the dataset does not consume is REPORTED dropped', async () => {
    // Accepted and silently ignored is the worst of the three outcomes: the caller asked for one
    // period's rows and got every notification, with nothing in the response saying so.
    stubCosmos(t, { notifications: [notificationRow()] });

    const { body } = await get(
      '/api/search?dataset=ProjectNotification&period=abc&companyType=x&docIds=a');

    assert.deepStrictEqual(body[0].meta[0].dropped.filter.sort(),
      ['companyType', 'docIds', 'period']);
  });

  await t.test('an unknown dataset is still a 400', async () => {
    const { status, body } = await get('/api/search?dataset=Widget');
    assert.strictEqual(status, 400);
    assert.match(body.error, /Invalid or unsupported dataset: Widget/);
  });

  await t.test('a project filter a Cosmos container has no axis for is reported, not ignored',
    async () => {
      stubCosmos(t, { lists: [listRow()] });
      const { body } = await get(
        `/api/search?dataset=List&and%5Bproject%5D=${PROJECT_EAGLE_ID}`);
      assert.deepStrictEqual(body[0].searchResults, []);
      assert.strictEqual(body[0].count, 0);
      assert.deepStrictEqual(body[0].meta[0].dropped.filter, ['project']);
    });
});

test('GET /search?dataset=Document&docIds=', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a pipe-separated id list becomes one search.in scope on the document key',
    async () => {
      let asked;
      t.mock.method(aiSearch, 'searchDocuments', async (opts) => {
        asked = opts;
        return { items: [], count: 0 };
      });

      const { status } = await get(
        '/api/search?dataset=Document&docIds=5cf00c03a266b7e187750002%7C5cf00c03a266b7e187750003');

      assert.strictEqual(status, 200);
      // `id`, the DOCUMENTS index key — not `documentId`, which is the CHUNKS index field the
      // deep-search branch scopes on.
      assert.match(asked.filter,
        /search\.in\(id, '5cf00c03a266b7e187750002,5cf00c03a266b7e187750003', ','\)/);
      // ANDed onto the caller's ACL, never instead of it.
      assert.match(asked.filter, /read\/any/);
    });

  await t.test('an empty docIds asks for a named set that is empty, and matches nothing',
    async () => {
      let asked;
      t.mock.method(aiSearch, 'searchDocuments', async (opts) => {
        asked = opts;
        return { items: [], count: 0 };
      });

      const { body } = await get('/api/search?dataset=Document&docIds=');

      assert.match(asked.filter, /id eq ''/);
      assert.strictEqual(body[0].count, 0);
    });
});

/**
 * The same two datasets, WITH keywords: ranked by the index, read back from Cosmos.
 *
 * The index is stubbed at `aiSearch.searchActivities`/`searchNotifications` — what belongs here is
 * the routing, the filter the controller hands the index, and the row shape it answers with. The
 * query those two functions build is pinned in `test/search/ai-search.test.js`.
 */
test('GET /search keyword searches over the indexed Cosmos datasets', async (t) => {
  t.beforeEach(() => {
    process.env.SEARCH_ENDPOINT = 'https://demi-search-test.search.windows.net';
    // BOTH HALVES OF THE SWITCH have to be on for the index to be asked anything: there is no code
    // default index name, so an environment whose param file does not name one answers from Cosmos.
    process.env.SEARCH_INDEX_ACTIVITIES = 'activities';
    process.env.SEARCH_INDEX_PROJECT_NOTIFICATIONS = 'project-notifications';
    searchController.resetKeywordFallbackWarnings();
  });
  t.afterEach(() => {
    delete process.env.SEARCH_ENDPOINT;
    delete process.env.SEARCH_INDEX_ACTIVITIES;
    delete process.env.SEARCH_INDEX_PROJECT_NOTIFICATIONS;
    t.mock.restoreAll();
  });

  /** Answer the index with the ids given, and record what it was asked. */
  const stubIndex = (name, ids, count) => {
    const asked = {};
    t.mock.method(aiSearch, name, async (opts) => {
      Object.assign(asked, opts);
      return { items: ids.map(id => ({ id })), count: count ?? ids.length };
    });
    return asked;
  };

  await t.test('a keyword news search is ranked by the index and read back from Cosmos',
    async () => {
      const seen = stubCosmos(t, { projects: [PROJECT_ROW], updates: [updateRow()] });
      const asked = stubIndex('searchActivities', ['5f0e4a0c3f4b1a0021a1b2c1'], 42);

      const { status, body } = await get(
        '/api/search?dataset=RecentActivity&keywords=application&pageSize=10&pageNum=2');

      assert.strictEqual(status, 200);
      assert.strictEqual(asked.keywords, 'application');
      assert.strictEqual(asked.prefix, true, 'type-ahead is on unless the caller opts out');
      assert.strictEqual(asked.top, 10);
      assert.strictEqual(asked.skip, 20, 'rows, in the caller\'s own page size');
      // THE INDEX-WIDE TOTAL, not the page: eagle-public pages against it.
      assert.strictEqual(body[0].count, 42);
      assert.strictEqual(body[0].meta[0].searchResultsTotal, 42);

      // The Cosmos read is the named set the index ranked, never the whole container.
      const [read] = specsFor(seen, 'updates');
      assert.match(read.query, /c\.id IN \(@uid0\)/);
      assert.ok(boundValues(read).includes('5f0e4a0c3f4b1a0021a1b2c1'));
      // And NOT the CONTAINS predicate: that is the fallback path, and running both would be two
      // different answers to one question.
      assert.ok(!/CONTAINS\(c\.headline/.test(read.query));
    });

  await t.test('the keyword row is the SAME row the keywordless page answers with', async () => {
    stubCosmos(t, { projects: [PROJECT_ROW], updates: [updateRow()] });
    stubIndex('searchActivities', ['5f0e4a0c3f4b1a0021a1b2c1']);
    const indexed = await get('/api/search?dataset=RecentActivity&keywords=application');

    t.mock.restoreAll();
    stubCosmos(t, { projects: [PROJECT_ROW], updates: [updateRow()] });
    const cosmosOnly = await get('/api/search?dataset=RecentActivity');

    // Not just the same KEYS — the same row. The index carries no copy of any field on it, so a
    // difference here would mean one of the two paths maps the record differently.
    assert.deepStrictEqual(indexed.body[0].searchResults, cosmosOnly.body[0].searchResults);
    assert.strictEqual(indexed.body[0].searchResults[0]._schemaName, 'RecentActivity');
    assert.strictEqual(indexed.body[0].searchResults[0].read, undefined);
  });

  await t.test('the index hides drafts and scheduled updates from the public, not from staff',
    async () => {
      const AT = '\\d{4}-\\d{2}-\\d{2}T[^) ]+Z';
      const LIVE = new RegExp(`\\(status eq null or \\(status eq 'published' and publishDate le ${AT}\\)\\)`);
      stubCosmos(t, { projects: [PROJECT_ROW], updates: [updateRow()] });
      const asked = stubIndex('searchActivities', []);

      await get('/api/search?dataset=RecentActivity&keywords=application');
      assert.match(asked.filter, LIVE);

      await getAsStaff(t, '/api/search?dataset=RecentActivity&keywords=application');
      assert.doesNotMatch(asked.filter || '', /publishDate/);
    });

  await t.test('notifications answer the same row on both paths too', async () => {
    stubCosmos(t, { notifications: [notificationRow()] });
    stubIndex('searchNotifications', ['5f0e4a0c3f4b1a0021a1b2c3']);
    const indexed = await get('/api/search?dataset=ProjectNotification&keywords=quarry');

    t.mock.restoreAll();
    stubCosmos(t, { notifications: [notificationRow()] });
    const cosmosOnly = await get('/api/search?dataset=ProjectNotification');

    assert.deepStrictEqual(indexed.body[0].searchResults, cosmosOnly.body[0].searchResults);
  });

  await t.test('the page keeps the ranking, not the order Cosmos answered in', async () => {
    const ids = ['5f0e4a0c3f4b1a0021a1b2c1', '5f0e4a0c3f4b1a0021a1b2c2'];
    // The fixture order is the opposite of the ranking, so a page that simply took what Cosmos
    // returned would still look sorted.
    stubCosmos(t, {
      projects: [PROJECT_ROW],
      updates: [updateRow({ id: ids[1], eagleId: ids[1] }), updateRow({ id: ids[0], eagleId: ids[0] })]
    });
    stubIndex('searchActivities', ids);

    const { body } = await get('/api/search?dataset=RecentActivity&keywords=application');

    assert.deepStrictEqual(body[0].searchResults.map(r => r._id), ids);
  });

  await t.test('the caller ACL and their filters are ONE $filter, never one instead of the other',
    async () => {
      stubCosmos(t, { notifications: [notificationRow()] });
      const asked = stubIndex('searchNotifications', []);

      const { body } = await get('/api/search?dataset=ProjectNotification' +
        '&keywords=quarry&and%5Bregion%5D=Cariboo&and%5Btype%5D=Project%20Notification');

      assert.match(asked.filter, /region eq 'Cariboo'/);
      assert.match(asked.filter, /type eq 'Project Notification'/);
      // The read[] gate, from the same builder the Document branch uses.
      assert.match(asked.filter, /read\/any\(r: search\.in\(r, '[^']*public/);
      assert.match(asked.filter, / and /);
      assert.strictEqual(body[0].meta[0].dropped, undefined, 'both filters are applied');
    });

  await t.test('a project filter keeps the EAGLE id on the index path too', async () => {
    stubCosmos(t, { projects: [PROJECT_ROW], updates: [updateRow()] });
    const asked = stubIndex('searchActivities', []);

    const { body } = await get('/api/search?dataset=RecentActivity' +
      `&keywords=application&and%5Bproject%5D=${PROJECT_EAGLE_ID}`);

    // `activities.projectId` holds the id eagle-api pushed, so the translated DEMI id would match
    // nothing — the same rule the Cosmos branch follows, one query layer over.
    assert.match(asked.filter, new RegExp(`projectId eq '${PROJECT_EAGLE_ID}'`));
    assert.strictEqual(body[0].meta[0].dropped, undefined, 'the project filter is applied');
  });

  await t.test('a filter key the index cannot express is reported, not ignored', async () => {
    stubCosmos(t, { notifications: [notificationRow()] });
    stubIndex('searchNotifications', []);

    const { body } = await get(
      '/api/search?dataset=ProjectNotification&keywords=quarry&period=abc&and%5Bread%5D=sealed');

    // `period` never reaches the filter builder; `read` resolves to a real filterable field and is
    // refused by the catalog, which is what stops a row count answering what a row's ACL holds.
    assert.deepStrictEqual(body[0].meta[0].dropped.filter.sort(), ['period', 'read']);
  });

  await t.test('sortBy=-_id still means the arrival order these rows carry', async () => {
    stubCosmos(t, { notifications: [notificationRow()] });
    const asked = stubIndex('searchNotifications', []);

    await get('/api/search?dataset=ProjectNotification&keywords=quarry&sortBy=-_id');

    assert.match(asked.orderby, /^notificationReceivedDate desc/);
  });

  await t.test('with no keywords the index is not asked at all', async () => {
    stubCosmos(t, { notifications: [notificationRow()] });
    let called = 0;
    t.mock.method(aiSearch, 'searchNotifications',
      async () => { called++; return { items: [], count: 0 }; });

    const { status, body } = await get('/api/search?dataset=ProjectNotification');

    assert.strictEqual(status, 200);
    assert.strictEqual(called, 0, 'a bare list read is a Cosmos read whatever the index could do');
    assert.strictEqual(body[0].searchResults.length, 1);
  });

  await t.test('top=true and and[_id] stay Cosmos reads however they are asked', async () => {
    stubCosmos(t, {
      projects: [PROJECT_ROW], updates: [updateRow()], notifications: [notificationRow()]
    });
    let called = 0;
    const counted = async () => { called++; return { items: [], count: 0 }; };
    t.mock.method(aiSearch, 'searchActivities', counted);
    t.mock.method(aiSearch, 'searchNotifications', counted);

    // The home-page strip is ordered by pinned-ness, and a point read by id has nothing to rank.
    const strip = await get('/api/search?dataset=RecentActivity&keywords=application&top=true');
    const one = await get('/api/search?dataset=ProjectNotification' +
      '&keywords=quarry&and%5B_id%5D=5f0e4a0c3f4b1a0021a1b2c3');

    assert.strictEqual(called, 0);
    // The strip runs the pinned and unpinned reads, so its length is the fixture's, not one row.
    assert.strictEqual(strip.body[0].searchResults[0]._schemaName, 'RecentActivity');
    assert.strictEqual(one.body[0].count, 1);
  });

  // THE KILL SWITCH. An emptied app setting is an operator decision, and the Cosmos read answers
  // keywords too — with CONTAINS instead of BM25.
  await t.test('an emptied index setting falls back to the Cosmos read and says so once',
    async () => {
      const warnings = [];
      t.mock.method(logger, 'warn', message => warnings.push(message));
      process.env.SEARCH_INDEX_ACTIVITIES = '';
      const seen = stubCosmos(t, { projects: [PROJECT_ROW], updates: [updateRow()] });
      let called = 0;
      t.mock.method(aiSearch, 'searchActivities',
        async () => { called++; return { items: [], count: 0 }; });

      const first = await get('/api/search?dataset=RecentActivity&keywords=application');
      await get('/api/search?dataset=RecentActivity&keywords=application');

      assert.strictEqual(first.status, 200);
      assert.strictEqual(called, 0, 'the index is not asked when its setting is empty');
      assert.match(specsFor(seen, 'updates')[0].query, /CONTAINS\(c\.headline/);
      const fallback = warnings.filter(w => w.includes('falling back to the Cosmos read'));
      assert.strictEqual(fallback.length, 1,
        'once per process — the frontend searches on every keystroke');
    });

  // THE BUG THIS PAIR EXISTS FOR. Test carries neither app setting — the two indexes were never
  // created there — and the code used to supply a default name, so the switch read "on", the query
  // hit an index the service does not hold, and both datasets answered 502 on every keyword search.
  await t.test('an app setting that was never deployed answers from Cosmos, both datasets',
    async () => {
      t.mock.method(logger, 'warn', () => {});
      delete process.env.SEARCH_INDEX_ACTIVITIES;
      delete process.env.SEARCH_INDEX_PROJECT_NOTIFICATIONS;
      const seen = stubCosmos(t, {
        projects: [PROJECT_ROW], updates: [updateRow()], notifications: [notificationRow()]
      });
      let called = 0;
      const counted = async () => { called++; return { items: [], count: 0 }; };
      t.mock.method(aiSearch, 'searchActivities', counted);
      t.mock.method(aiSearch, 'searchNotifications', counted);

      const news = await get('/api/search?dataset=RecentActivity&keywords=Assessment');
      const notices = await get('/api/search?dataset=ProjectNotification&keywords=pa');

      assert.strictEqual(called, 0, 'an unnamed index is not asked anything');
      for (const { status, body } of [news, notices]) {
        assert.strictEqual(status, 200);
        assert.strictEqual(body[0].searchResults.length, 1);
        assert.strictEqual(body[0].count, 1);
        assert.strictEqual(body[0].meta[0].searchResultsTotal, 1);
      }
      assert.strictEqual(news.body[0].searchResults[0]._schemaName, 'RecentActivity');
      assert.strictEqual(notices.body[0].searchResults[0]._schemaName, 'ProjectNotification');
      // The keywords reached the Cosmos read as CONTAINS, so the page is filtered, not the whole
      // container handed back under a keyword query.
      assert.match(specsFor(seen, 'updates')[0].query, /CONTAINS\(c\.headline/);
    });

  // Defence in depth behind the setting: a name that IS deployed but points at an index nobody
  // created answers 404 per query, and no configuration this app can read says so.
  await t.test('a 404 for a missing index falls back to Cosmos and says so once', async () => {
    const warnings = [];
    t.mock.method(logger, 'warn', message => warnings.push(message));
    const seen = stubCosmos(t, { projects: [PROJECT_ROW], updates: [updateRow()] });
    let called = 0;
    t.mock.method(aiSearch, 'searchActivities', async () => {
      called++;
      throw Object.assign(
        new Error("HTTP 404 No index with the name 'activities' was found in the service [abc]"),
        { status: 404 });
    });

    const first = await get('/api/search?dataset=RecentActivity&keywords=Assessment');
    const second = await get('/api/search?dataset=RecentActivity&keywords=Assessment');

    assert.strictEqual(called, 2, 'the switch still says on — each request tries the index first');
    for (const { status, body } of [first, second]) {
      assert.strictEqual(status, 200);
      assert.strictEqual(body[0].searchResults.length, 1);
      assert.strictEqual(body[0].searchResults[0]._schemaName, 'RecentActivity');
    }
    assert.match(specsFor(seen, 'updates')[0].query, /CONTAINS\(c\.headline/);
    const fallback = warnings.filter(w => w.includes('does not exist on the search service'));
    assert.strictEqual(fallback.length, 1, 'once per process, like the emptied-setting warning');
  });

  // The narrowness is the point: a 403 or a slow service means the index is there and the query is
  // not, and answering those from Cosmos would publish an unranked page as the index's own.
  await t.test('any other index failure is still a 502', async () => {
    t.mock.method(logger, 'error', () => {});
    stubCosmos(t, { notifications: [notificationRow()] });
    t.mock.method(aiSearch, 'searchNotifications', async () => {
      throw Object.assign(new Error('HTTP 403 Forbidden'), { status: 403 });
    });

    const { status, body } = await get('/api/search?dataset=ProjectNotification&keywords=pa');

    assert.strictEqual(status, 502);
    assert.match(body.error, /ProjectNotification search is unavailable/);
  });

  // A fallback page reports ITS OWN unapplied keys. The index attempt refused `period` on the way
  // out, and counting that refusal twice would tell the caller a filter panel did nothing twice.
  await t.test('the dropped keys a fallback reports are the Cosmos read\'s, not both paths\'',
    async () => {
      t.mock.method(logger, 'warn', () => {});
      stubCosmos(t, { notifications: [notificationRow()] });
      t.mock.method(aiSearch, 'searchNotifications', async () => {
        throw Object.assign(new Error('HTTP 404 was not found'), { status: 404 });
      });

      const { status, body } = await get(
        '/api/search?dataset=ProjectNotification&keywords=quarry&period=abc');

      assert.strictEqual(status, 200);
      assert.deepStrictEqual(body[0].meta[0].dropped.filter, ['period']);
    });

  await t.test('no SEARCH_ENDPOINT falls back the same way', async () => {
    delete process.env.SEARCH_ENDPOINT;
    t.mock.method(logger, 'warn', () => {});
    const seen = stubCosmos(t, { notifications: [notificationRow()] });
    let called = 0;
    t.mock.method(aiSearch, 'searchNotifications',
      async () => { called++; return { items: [], count: 0 }; });

    const { status, body } = await get('/api/search?dataset=ProjectNotification&keywords=quarry');

    assert.strictEqual(status, 200);
    assert.strictEqual(called, 0);
    assert.strictEqual(body[0].searchResults.length, 1);
    assert.ok(specsFor(seen, 'notifications').length > 0, 'the Cosmos read answered instead');
  });

  // A search that FAILED is not a search that found nothing, and it must not become the
  // keywordless list either — the same rule as the Project and Document branches.
  await t.test('an index failure is a 502, never an empty page', async () => {
    t.mock.method(logger, 'error', () => {});
    stubCosmos(t, { projects: [PROJECT_ROW], updates: [updateRow()] });
    t.mock.method(aiSearch, 'searchActivities', async () => {
      throw new Error('HTTP 503 Service Unavailable');
    });

    const { status, body } = await get('/api/search?dataset=RecentActivity&keywords=application');

    assert.strictEqual(status, 502);
    assert.match(body.error, /RecentActivity search is unavailable/);
  });

  // The indexers have no delete detection (`_ts` high-water only), so a row the index still holds
  // may be one Cosmos no longer admits. Dropping it is the fail-closed direction.
  await t.test('a ranked id the caller may not read drops out of the page', async () => {
    stubCosmos(t, { projects: [PROJECT_ROW], updates: [updateRow()] });
    stubIndex('searchActivities', ['5f0e4a0c3f4b1a0021a1b2c1', 'gone-from-cosmos'], 2);

    const { body } = await get('/api/search?dataset=RecentActivity&keywords=application');

    assert.deepStrictEqual(body[0].searchResults.map(r => r._id), ['5f0e4a0c3f4b1a0021a1b2c1']);
    assert.strictEqual(body[0].count, 2, 'the total is the index-wide one, as on every other branch');
  });
});
