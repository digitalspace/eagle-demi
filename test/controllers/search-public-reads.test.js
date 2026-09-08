'use strict';

/**
 * The Cosmos-backed `/search` datasets — the reads eagle-public used to make against eagle-api.
 *
 * Driven through the DISPATCHER rather than the controller function, because half of what can go
 * wrong here lives in the guard chain rather than in the branch: the `canScopeToProject` gate that
 * zeroes a project filter, the `unknownParams` 400, and the `meta[0].searchResultsTotal` the
 * response wrapper attaches and eagle-public pages against.
 *
 * `cosmos.query`/`readItem` are the stub point, one level BELOW the repositories, so the SQL each
 * request emits is real and assertable. That is the only place the caller's ACL can be checked on
 * this path: a branch that read with `systemAccess()` would answer 200 with rows an anonymous
 * visitor may not see, and nothing in the response would say so.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const aiSearch = require('../../src/search/ai-search');
const apiKeys = require('../../src/repositories/api-keys');
const { generateKey } = require('../../src/helpers/api-key');
const { forgetCachedKey } = require('../../src/helpers/auth');
const { withServer } = require('../helpers/with-server');

const PROJECT_EAGLE_ID = '588511d0aaecd9001b825604';
const PERIOD_EAGLE_ID = '5b8bcf0d0f5e9c0019a7a1c1';
const PUBLIC_ACL = ['public', 'staff', 'sysadmin'];

/** The DEMI project row every branch that names a project resolves through. */
const PROJECT_ROW = {
  id: '207', eagleId: PROJECT_EAGLE_ID, name: 'Nicomen Wind Energy', read: PUBLIC_ACL
};

/** The Cosmos partition key of each container the branches read. */
const PARTITION_FIELD = {
  projects: 'id',
  lists: 'kind',
  commentPeriods: 'projectId',
  comments: 'periodId',
  notifications: 'id',
  updates: 'id'
};

/**
 * Serve Cosmos by CONTAINER, and record every spec.
 *
 * `rows` is keyed by container name; a `VALUE COUNT(1)` query is answered from `counts`, defaulting
 * to the number of rows served, so a branch that builds its total from a different predicate than
 * its read is still visible in `seen`.
 */
function stubCosmos(t, rows, counts = {}) {
  const seen = [];
  t.mock.method(cosmos, 'query', async (container, spec, options) => {
    seen.push({ container, spec, options });
    // A partition key is HONOURED, so a read aimed at a partition that does not exist answers
    // nothing — the case an unresolved project id produces, and the one a stub that always serves
    // its fixture would hide.
    const served = (rows[container] || []).filter(row =>
      options.partitionKey === undefined ||
      String(row[PARTITION_FIELD[container]]) === String(options.partitionKey));

    if (/COUNT\(1\)/.test(spec.query)) return { items: [counts[container] ?? served.length] };
    return { items: served.slice() };
  });
  t.mock.method(cosmos, 'readItem', async (container, id) =>
    (rows[container] || []).find(r => String(r.id) === String(id)) || null);
  return seen;
}

/** The specs a container saw, read query first. */
const specsFor = (seen, container) =>
  seen.filter(s => s.container === container).map(s => s.spec);

/** Every parameter value one spec bound, so an ACL token can be looked for by value. */
const boundValues = (spec) => (spec.parameters || []).map(p => String(p.value));

async function get(path) {
  let payload;
  let status;
  await withServer(async (call) => {
    const res = await call(path);
    status = res.status;
    payload = await res.json();
  });
  return { status, body: payload };
}

/** The same call under a staff credential, so the two visibility levels can be compared. */
async function getAsStaff(t, path) {
  const { keyId, plaintext, hash } = generateKey('test');
  forgetCachedKey(keyId);
  t.mock.method(apiKeys, 'getById', async () => ({
    id: keyId, name: 'reader', hash, roles: ['staff'],
    projectScope: null, expiresAt: null, revokedAt: null
  }));
  t.mock.method(apiKeys, 'touchLastUsed', async () => {});

  let payload;
  let status;
  await withServer(async (call) => {
    const res = await call(path, { headers: { 'x-api-key': plaintext } });
    status = res.status;
    payload = await res.json();
  });
  forgetCachedKey(keyId);
  return { status, body: payload };
}

const listRow = (over = {}) => ({
  id: '5cf00c03a266b7e1877504ca',
  eagleId: '5cf00c03a266b7e1877504ca',
  kind: 'List',
  sourceSystem: 'eagle',
  name: 'Amendment Package',
  type: 'doctype',
  item: 'https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/370_2002',
  legislation: '2002',
  listOrder: 12,
  isPublished: true,
  read: PUBLIC_ACL,
  sources: { eagle: { secret: 'raw' } },
  ...over
});

const orgRow = (over = {}) => ({
  id: '58850f69aaecd9001b8085cc',
  eagleId: '58850f69aaecd9001b8085cc',
  kind: 'Organization',
  sourceSystem: 'eagle',
  name: 'Nicomen Energy Ltd',
  companyType: 'Proponent/Certificate Holder',
  province: 'BC',
  isPublished: true,
  read: PUBLIC_ACL,
  ...over
});

const periodRow = (over = {}) => ({
  id: PERIOD_EAGLE_ID,
  eagleId: PERIOD_EAGLE_ID,
  // The DEMI project id, as the mirror stores it.
  projectId: '207',
  sourceSystem: 'eagle',
  dateStarted: '2026-08-01T00:00:00.000Z',
  dateCompleted: '2026-08-30T00:00:00.000Z',
  instructions: 'Tell us what you think.',
  additionalText: 'Comment on the amendment application.',
  isMet: false,
  metURL: '',
  metBannerImageUrl: 'https://engage.gov.bc.ca/banner.jpg',
  informationLabel: 'Read the application',
  isPublished: true,
  read: PUBLIC_ACL,
  ...over
});

const commentRow = (over = {}) => ({
  id: '5b8bcf0d0f5e9c0019a7a1c2',
  eagleId: '5b8bcf0d0f5e9c0019a7a1c2',
  periodId: PERIOD_EAGLE_ID,
  projectId: '207',
  sourceSystem: 'eagle',
  author: 'Jane Public',
  comment: 'Please consider the wetland.',
  commentId: 41,
  dateAdded: '2026-08-05T00:00:00.000Z',
  dateUpdated: '2026-08-06T00:00:00.000Z',
  location: 'Nicomen Island',
  submittedCAC: true,
  isAnonymous: true,
  documents: [],
  eaoStatus: 'Published',
  isPublished: true,
  read: PUBLIC_ACL,
  ...over
});

const updateRow = (over = {}) => ({
  id: '5f0e4a0c3f4b1a0021a1b2c1',
  eagleId: '5f0e4a0c3f4b1a0021a1b2c1',
  // The EAGLE project id — updates.js SCOPE_FIELD, the opposite of the period row above.
  projectId: PROJECT_EAGLE_ID,
  headline: 'Application accepted',
  content: 'The application has been accepted for review.',
  type: 'project',
  pinned: true,
  dateAdded: '2026-09-01T00:00:00.000Z',
  dateUpdated: '2026-09-01T00:00:00.000Z',
  active: true,
  notificationName: 'Nicomen Wind Energy',
  contentUrl: 'https://projects.eao.gov.bc.ca/p/588511d0aaecd9001b825604/news',
  documentUrl: 'https://projects.eao.gov.bc.ca/api/document/5cf00c03a266b7e187750002/fetch',
  pcp: PERIOD_EAGLE_ID,
  projectNotification: '5f0e4a0c3f4b1a0021a1b2c3',
  isPublished: true,
  read: PUBLIC_ACL,
  notifiedAt: '2026-09-01T01:00:00.000Z',
  ...over
});

const notificationRow = (over = {}) => ({
  id: '5f0e4a0c3f4b1a0021a1b2c3',
  eagleId: '5f0e4a0c3f4b1a0021a1b2c3',
  sourceSystem: 'eagle',
  name: 'Bear Creek Quarry',
  type: 'Project Notification',
  subType: 'New',
  region: 'Cariboo',
  notificationReceivedDate: '2026-05-01T00:00:00.000Z',
  isPublished: true,
  read: PUBLIC_ACL,
  ...over
});

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

  await t.test('a period under a notification this caller cannot see carries no parent', async () => {
    // The lookup is ACL-enforcing on the notification too, and a period row that survived the
    // period ACL must not be labelled with a parent the caller may not read.
    stubCosmos(t, { notifications: [], commentPeriods: [periodRow({ projectId: 'PN1' })] });

    const { body } = await get('/api/search?dataset=CommentPeriod&and%5Bproject%5D=PN1');

    assert.strictEqual(body[0].searchResults[0].project, null);
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
    assert.deepStrictEqual(row.project, { _id: PROJECT_EAGLE_ID, name: 'Nicomen Wind Energy' });
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

    const projectSpecs = specsFor(seen, 'projects');
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
