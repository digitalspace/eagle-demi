'use strict';

/**
 * `GET /search?dataset=RecentActivity&top=true&pageSize=N` and `dataset=HomeFeed` — the home page's
 * strip with a caller-chosen length, and the feed that merges updates with decisions.
 *
 * The updates stub here honours the pinned/unpinned split and the type IN clause, because both
 * reads are built from them: a stub that served every row to both queries could not tell a pinned
 * strip from an unordered one. The ACL still cannot be evaluated by a stub, so it is asserted on
 * the predicates each read sent, as in `search.commentperiods.test.js`.
 *
 * Harness, stub points and row fixtures: `test/helpers/search-reads.js`.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const aiSearch = require('../../src/search/ai-search');
const {
  PROJECT_ROW, PROJECT_EAGLE_ID, NOTIFICATION_EAGLE_ID, specsFor, boundValues, get, getAsStaff, updateRow, notificationRow
} = require('../helpers/search-reads');

const day = (n) => `2026-09-${String(n).padStart(2, '0')}T00:00:00.000Z`;

const update = (id, dateDay, over = {}) => updateRow({
  id, eagleId: id, type: 'News', pinned: false, dateAdded: day(dateDay), headline: `h-${id}`, ...over
});

/**
 * Cosmos by container, recording every spec. `updates` answers the pinned and the unpinned read
 * apart, applies a bound `type` IN, and orders newest first, as the real predicates would.
 */
function stubFeed(t, { updates = [], notifications = [] } = {}) {
  const seen = [];
  t.mock.method(cosmos, 'query', async (container, spec, options) => {
    seen.push({ container, spec, options });
    if (container === 'projects') return { items: [PROJECT_ROW] };
    if (container === 'notifications') return { items: notifications.slice() };
    if (container !== 'updates') return { items: [] };

    const wantsPinned = !/NOT IS_DEFINED\(c\.pinned\)/.test(spec.query);
    const types = /c\.type IN/.test(spec.query)
      ? spec.parameters.filter(p => /^@type/.test(p.name)).map(p => p.value)
      : null;
    const items = updates
      .filter(u => (u.pinned === true) === wantsPinned)
      .filter(u => !types || types.includes(u.type))
      .sort((a, b) => b.dateAdded.localeCompare(a.dateAdded));
    return { items };
  });
  return seen;
}

/** The `projects` index answer for the decision half, and what the controller sent it. */
function stubDecisions(t, hits = []) {
  const sent = [];
  t.mock.method(aiSearch, 'searchProjects', async (opts) => {
    sent.push(opts);
    return { items: hits, count: hits.length };
  });
  return sent;
}

const projectHit = (over = {}) => ({
  id: '207',
  legacyEagleId: PROJECT_EAGLE_ID,
  name: PROJECT_ROW.name,
  eacDecision: 'Certificate Issued',
  decisionDate: '2026-09-05T07:00:00Z',
  isPublished: true,
  read: ['public'],
  vis: '{}',
  ...over
});

const SIX_UNPINNED = [1, 2, 3, 4, 5, 6].map(n => update(`un-${n}`, 10 - n));

test('GET /search?dataset=RecentActivity&top=true&pageSize', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('with no pageSize the strip is still four rows', async () => {
    stubFeed(t, { updates: SIX_UNPINNED });

    const { status, body } = await get('/api/search?dataset=RecentActivity&top=true');

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body[0].searchResults.map(r => r._id), ['un-1', 'un-2', 'un-3', 'un-4']);
  });

  await t.test('an explicit pageSize is the row count', async () => {
    stubFeed(t, { updates: SIX_UNPINNED });

    const { body } = await get('/api/search?dataset=RecentActivity&top=true&pageSize=5');

    assert.deepStrictEqual(body[0].searchResults.map(r => r._id),
      ['un-1', 'un-2', 'un-3', 'un-4', 'un-5']);
    assert.strictEqual(body[0].count, 5);
  });

  await t.test('pinned rows lead and the limit still caps the whole strip', async () => {
    const pinned = [1, 2, 3].map(n => update(`pin-${n}`, n, { pinned: true }));
    stubFeed(t, { updates: [...pinned, ...SIX_UNPINNED] });

    const { body } = await get('/api/search?dataset=RecentActivity&top=true&pageSize=4');

    // The pinned rows are OLDER than every unpinned one; date alone would put them last.
    assert.deepStrictEqual(body[0].searchResults.map(r => r._id),
      ['pin-3', 'pin-2', 'pin-1', 'un-1']);
  });

  for (const bad of ['0', '21', 'abc', '2.5', '-3', '']) {
    await t.test(`pageSize=${bad} is refused, not clamped`, async () => {
      stubFeed(t, { updates: SIX_UNPINNED });

      const { status, body } = await get(
        `/api/search?dataset=RecentActivity&top=true&pageSize=${bad}`);

      assert.strictEqual(status, 400);
      assert.match(body.error, /pageSize must be an integer from 1 to 20/);
    });
  }
});

test('GET /search?dataset=HomeFeed', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('pinned first, then updates and decisions merged newest first, to pageSize',
    async () => {
      stubFeed(t, {
        updates: [
          update('pin-old', 1, { pinned: true }),
          update('news-9', 9),
          update('news-3', 3),
          update('pcp-8', 8, { type: 'Public Comment Period' })
        ],
        notifications: [notificationRow({
          decision: 'No further EAO review required', decisionDate: day(7),
          associatedProjectName: 'Bear Creek Quarry'
        })]
      });
      stubDecisions(t, [projectHit({ decisionDate: '2026-09-05T07:00:00Z' })]);

      const { status, body } = await get('/api/search?dataset=HomeFeed&pageSize=4');

      assert.strictEqual(status, 200);
      const rows = body[0].searchResults;
      assert.deepStrictEqual(rows.map(r => `${r.kind}:${r.id}`), [
        'update:pin-old',
        'update:news-9',
        `decision:${NOTIFICATION_EAGLE_ID}`,
        `decision:${PROJECT_EAGLE_ID}`
      ]);
      assert.strictEqual(rows[2].headline, 'No further EAO review required');
      assert.strictEqual(body[0].count, 4);
    });

  await t.test('only News fills the unpinned slots; a pinned row of any type still leads',
    async () => {
      const seen = stubFeed(t, {
        updates: [
          update('pin-pcp', 1, { pinned: true, type: 'Public Comment Period' }),
          update('pcp-9', 9, { type: 'Public Comment Period' }),
          update('news-2', 2)
        ]
      });
      stubDecisions(t);

      const { body } = await get('/api/search?dataset=HomeFeed&pageSize=5');

      assert.deepStrictEqual(body[0].searchResults.map(r => r.id), ['pin-pcp', 'news-2']);
      const [pinnedRead, unpinnedRead] = specsFor(seen, 'updates');
      assert.ok(!/c\.type IN/.test(pinnedRead.query), 'the pinned read carries no type clause');
      assert.ok(boundValues(unpinnedRead).includes('News'));
    });

  await t.test('rows carry the one normalised shape', async () => {
    stubFeed(t, { updates: [update('news-9', 9)] });
    stubDecisions(t, [projectHit()]);

    const { body } = await get('/api/search?dataset=HomeFeed&pageSize=2');

    const [news, decision] = body[0].searchResults;
    assert.deepStrictEqual(decision, {
      kind: 'decision',
      id: PROJECT_EAGLE_ID,
      projectId: PROJECT_EAGLE_ID,
      projectName: PROJECT_ROW.name,
      date: '2026-09-05T07:00:00.000Z',
      headline: 'Certificate Issued',
      content: null,
      documentUrl: null
    });
    assert.deepStrictEqual(news, {
      kind: 'update',
      id: 'news-9',
      projectId: PROJECT_EAGLE_ID,
      projectName: PROJECT_ROW.name,
      date: day(9),
      headline: 'h-news-9',
      content: 'The application has been accepted for review.',
      documentUrl: 'https://projects.eao.gov.bc.ca/api/document/5cf00c03a266b7e187750002/fetch'
    });
  });

  await t.test('the decision read is sorted newest first and stops at today', async () => {
    stubFeed(t);
    const sent = stubDecisions(t);

    await get('/api/search?dataset=HomeFeed&pageSize=3');

    assert.strictEqual(sent.length, 1);
    assert.match(sent[0].orderby, /^decisionDate desc/);
    assert.match(sent[0].filter, /decisionDate lt \d{4}-/, 'a decision dated after today is left out');
    assert.strictEqual(sent[0].top, 3);
  });

  await t.test('pageSize is validated like the strip', async () => {
    stubFeed(t);
    stubDecisions(t);

    const { status } = await get('/api/search?dataset=HomeFeed&pageSize=21');

    assert.strictEqual(status, 400);
  });

  // Three reads, three containers or indexes: each must carry the caller's own ACL, or one of them
  // publishes an unpublished project's update or decision to the home page.
  await t.test('every read carries the anonymous ACL, and staff widens all three', async () => {
    const anonSeen = stubFeed(t, { updates: [update('news-9', 9)] });
    const anonSent = stubDecisions(t);
    await get('/api/search?dataset=HomeFeed');
    const anon = {
      updates: boundValues(specsFor(anonSeen, 'updates')[1]),
      notifications: boundValues(specsFor(anonSeen, 'notifications')[0]),
      projects: anonSent[0].filter
    };
    t.mock.restoreAll();

    const staffSeen = stubFeed(t, { updates: [update('news-9', 9)] });
    const staffSent = stubDecisions(t);
    const { status } = await getAsStaff(t, '/api/search?dataset=HomeFeed');
    assert.strictEqual(status, 200);

    assert.ok(anon.updates.includes('public') && !anon.updates.includes('staff'));
    assert.ok(anon.notifications.includes('public') && !anon.notifications.includes('staff'));
    assert.match(anon.projects, /'public'/);
    assert.doesNotMatch(anon.projects, /staff/);

    assert.ok(boundValues(specsFor(staffSeen, 'updates')[1]).includes('staff'));
    assert.ok(boundValues(specsFor(staffSeen, 'notifications')[0]).includes('staff'));
    assert.match(staffSent[0].filter, /search\.in\(r, '[^']*\bstaff\b/);
  });

  await t.test('keywords are refused rather than ignored', async () => {
    stubFeed(t);
    stubDecisions(t);

    const { status } = await get('/api/search?dataset=HomeFeed&q=mine');

    assert.strictEqual(status, 400);
  });
});
