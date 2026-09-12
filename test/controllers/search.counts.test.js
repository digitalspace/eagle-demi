'use strict';

process.env.NODE_ENV = 'test';
// Set before the search module reads it: with no endpoint every index leg falls back or throws,
// which would make these tests pass while asserting nothing about the index path.
process.env.SEARCH_ENDPOINT = 'https://demi-search-test.search.windows.net';

const test = require('node:test');
const assert = require('node:assert');

const searchController = require('../../src/controllers/search');
const aiSearch = require('../../src/search/ai-search');
const updatesRepo = require('../../src/repositories/updates');
const notificationsRepo = require('../../src/repositories/notifications');

// Same fake response as the other search controller tests — `res.json` is replaced by the search
// handler, so it has to be a writable property.
function capture() {
  const out = {};
  const res = {
    json: (data) => { out.body = data; return res; },
    status: (code) => { out.status = code; return res; }
  };
  return { out, res };
}

const anonymous = query => ({ query, header: () => null });

const privileged = query => ({
  query,
  header: () => null,
  user: { realm_access: { roles: ['sysadmin'] } }
});

/** The two kill switches, restored whatever the test did with them. */
function withIndexes(t, { activities = 'activities', notifications = 'project-notifications' }) {
  const saved = [process.env.SEARCH_INDEX_ACTIVITIES,
    process.env.SEARCH_INDEX_PROJECT_NOTIFICATIONS];
  process.env.SEARCH_INDEX_ACTIVITIES = activities;
  process.env.SEARCH_INDEX_PROJECT_NOTIFICATIONS = notifications;
  t.after(() => {
    process.env.SEARCH_INDEX_ACTIVITIES = saved[0] ?? '';
    process.env.SEARCH_INDEX_PROJECT_NOTIFICATIONS = saved[1] ?? '';
  });
}

/** Every leg stubbed to a distinct number, so a leg wired to the wrong index is visible. */
function stubAllLegs(t, overrides = {}) {
  const seen = {};
  t.mock.method(aiSearch, 'countProjects', async (opts) => { seen.Project = opts; return 12; });
  t.mock.method(aiSearch, 'searchDocuments', async (opts) => {
    seen.Document = opts;
    return { count: 340, items: [] };
  });
  t.mock.method(aiSearch, 'countActivities', async (opts) => { seen.RecentActivity = opts; return 3; });
  t.mock.method(aiSearch, 'countNotifications', async (opts) => {
    seen.ProjectNotification = opts;
    return 9;
  });
  t.mock.method(updatesRepo, 'count', async (access, filters) => {
    seen.updatesCount = filters;
    return 77;
  });
  t.mock.method(notificationsRepo, 'count', async (access, filters) => {
    seen.notificationsCount = filters;
    return 88;
  });
  for (const [name, fn] of Object.entries(overrides)) t.mock.method(aiSearch, name, fn);
  return seen;
}

test('GET /search/counts answers one badge per record type', async (t) => {
  t.beforeEach(() => searchController.resetCountsCache());
  t.afterEach(() => t.mock.restoreAll());

  await t.test('each record type is counted on its own index', async (tt) => {
    withIndexes(tt, {});
    const seen = stubAllLegs(tt);

    const { out, res } = capture();
    await searchController.counts(anonymous({ keywords: 'caribou' }), res);

    assert.strictEqual(out.status, undefined, '200');
    assert.deepStrictEqual(out.body[0].counts, {
      Project: 12, Document: 340, RecentActivity: 3, ProjectNotification: 9
    });
    assert.deepStrictEqual(out.body[0].meta[0],
      { unavailable: [], degraded: [], cached: false });

    // The keyword reaches every leg. A badge counted without it is the corpus total.
    for (const name of ['Project', 'Document', 'RecentActivity', 'ProjectNotification']) {
      assert.strictEqual(seen[name].keywords, 'caribou', `${name} was counted on the keyword`);
    }
    assert.strictEqual(seen.Document.countOnly, true,
      'the document badge must be the two-leg total, not a page');
  });

  // The whole point of the endpoint: the badge and the tab's own toolbar total are one number.
  await t.test('the document count is what searchDocuments measured', async (tt) => {
    withIndexes(tt, {});
    stubAllLegs(tt, { searchDocuments: async () => ({ count: 1507, items: [] }) });

    const { out, res } = capture();
    await searchController.counts(anonymous({ keywords: 'pipeline' }), res);

    assert.strictEqual(out.body[0].counts.Document, 1507);
  });

  await t.test('datasets narrows the answer without narrowing the contract', async (tt) => {
    withIndexes(tt, {});
    stubAllLegs(tt);

    const { out, res } = capture();
    await searchController.counts(
      anonymous({ keywords: 'caribou', datasets: 'Project,Document' }), res);

    assert.deepStrictEqual(out.body[0].counts, { Project: 12, Document: 340 });
  });

  await t.test('an unknown parameter is a 400, as it is on /search', async (tt) => {
    withIndexes(tt, {});
    stubAllLegs(tt);

    const { out, res } = capture();
    await searchController.counts(anonymous({ keywords: 'x', pageNumber: '2' }), res);

    assert.strictEqual(out.status, 400);
    assert.match(out.body.error, /pageNumber/);
  });

  await t.test('an unknown record type is a 400 too', async (tt) => {
    withIndexes(tt, {});
    stubAllLegs(tt);

    const { out, res } = capture();
    await searchController.counts(anonymous({ keywords: 'x', datasets: 'Project,Widget' }), res);

    assert.strictEqual(out.status, 400);
    assert.match(out.body.error, /Widget/);
  });

  // `datasets` belongs to this handler alone: on /search it is a parameter nobody reads, and an
  // accepted-but-ignored parameter is the failure the 400 exists to prevent.
  await t.test('datasets stays a 400 on /search itself', async (tt) => {
    tt.mock.method(aiSearch, 'searchDocuments', async () => ({ count: 0, items: [] }));

    const { out, res } = capture();
    await searchController.search(anonymous({ dataset: 'Document', datasets: 'Project' }), res);

    assert.strictEqual(out.status, 400);
    assert.match(out.body.error, /datasets/);
  });
});

test('a badge that cannot be measured is unknown, never zero', async (t) => {
  t.beforeEach(() => searchController.resetCountsCache());
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a rejected leg answers null and names itself, under a 200', async (tt) => {
    withIndexes(tt, {});
    stubAllLegs(tt, {
      countProjects: async () => { throw new Error('search service unavailable'); }
    });

    const { out, res } = capture();
    await searchController.counts(anonymous({ keywords: 'caribou' }), res);

    assert.strictEqual(out.status, undefined, 'one dead index must not take the page down');
    assert.strictEqual(out.body[0].counts.Project, null);
    assert.deepStrictEqual(out.body[0].meta[0].unavailable, ['Project']);
    assert.strictEqual(out.body[0].counts.Document, 340, 'the other three still answer');
  });

  // `notificationsRepo.count` takes no keywords, so there is no Cosmos number to fall back to: the
  // container count would be the whole corpus under a keyword query.
  await t.test('notifications with the index switched off answer null', async (tt) => {
    withIndexes(tt, { notifications: '' });
    const seen = stubAllLegs(tt);

    const { out, res } = capture();
    await searchController.counts(anonymous({ keywords: 'caribou' }), res);

    assert.strictEqual(out.body[0].counts.ProjectNotification, null);
    assert.deepStrictEqual(out.body[0].meta[0].unavailable, ['ProjectNotification']);
    assert.strictEqual(seen.notificationsCount, undefined,
      'the keywordless container count must not be published as a keyword count');
  });

  // Activities can fall back, because the container read matches keywords on CONTAINS.
  await t.test('activities with the index off are counted in Cosmos, on the keyword', async (tt) => {
    withIndexes(tt, { activities: '' });
    const seen = stubAllLegs(tt);

    const { out, res } = capture();
    await searchController.counts(anonymous({ keywords: 'caribou' }), res);

    assert.strictEqual(out.body[0].counts.RecentActivity, 77);
    assert.deepStrictEqual(seen.updatesCount, { keywords: 'caribou' });
    assert.strictEqual(seen.RecentActivity, undefined, 'the index leg never ran');
    assert.deepStrictEqual(out.body[0].meta[0].degraded, ['RecentActivity'],
      'a substring match is a different question, and the caller is told so');
  });

  await t.test('a count the service did not report is published as unknown', async (tt) => {
    withIndexes(tt, {});
    stubAllLegs(tt, { countProjects: async () => null });

    const { out, res } = capture();
    await searchController.counts(anonymous({ keywords: 'caribou' }), res);

    assert.strictEqual(out.body[0].counts.Project, null);
    assert.deepStrictEqual(out.body[0].meta[0].unavailable, ['Project']);
  });
});

test('the counts cache', async (t) => {
  t.beforeEach(() => searchController.resetCountsCache());
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a repeat inside the TTL is served without re-counting, and expires after it',
    async (tt) => {
      withIndexes(tt, {});
      tt.mock.timers.enable({ apis: ['Date'] });
      let fanOuts = 0;
      stubAllLegs(tt, { countProjects: async () => { fanOuts += 1; return 12; } });

      const first = capture();
      await searchController.counts(anonymous({ keywords: 'caribou' }), first.res);
      assert.strictEqual(first.out.body[0].meta[0].cached, false);

      const second = capture();
      await searchController.counts(anonymous({ keywords: 'caribou' }), second.res);
      assert.strictEqual(second.out.body[0].meta[0].cached, true);
      assert.strictEqual(fanOuts, 1, 'the second request measured nothing');
      assert.deepStrictEqual(second.out.body[0].counts, first.out.body[0].counts);

      tt.mock.timers.tick(46 * 1000);

      const third = capture();
      await searchController.counts(anonymous({ keywords: 'caribou' }), third.res);
      assert.strictEqual(third.out.body[0].meta[0].cached, false);
      assert.strictEqual(fanOuts, 2, 'a stale entry is re-measured, not served');
    });

  // Two keystrokes land in the same tick on a debounced field. Caching the VALUE would let both
  // fan out; caching the PROMISE is what makes the second one free.
  await t.test('two concurrent requests share one fan-out', async (tt) => {
    withIndexes(tt, {});
    let fanOuts = 0;
    stubAllLegs(tt, {
      countProjects: async () => {
        fanOuts += 1;
        await new Promise(resolve => setImmediate(resolve));
        return 12;
      }
    });

    const a = capture();
    const b = capture();
    await Promise.all([
      searchController.counts(anonymous({ keywords: 'caribou' }), a.res),
      searchController.counts(anonymous({ keywords: 'caribou' }), b.res)
    ]);

    assert.strictEqual(fanOuts, 1);
    assert.deepStrictEqual(a.out.body[0].counts, b.out.body[0].counts);
  });

  // The counts are ACL-scoped, so a shared entry would publish one caller's totals to another.
  await t.test('two access contexts never share an entry', async (tt) => {
    withIndexes(tt, {});
    const filters = [];
    stubAllLegs(tt, {
      countProjects: async (opts) => { filters.push(opts.filter); return filters.length; }
    });

    const first = capture();
    await searchController.counts(anonymous({ keywords: 'caribou' }), first.res);
    const second = capture();
    await searchController.counts(privileged({ keywords: 'caribou' }), second.res);

    assert.strictEqual(second.out.body[0].meta[0].cached, false,
      'the privileged caller must not read the anonymous entry');
    assert.strictEqual(filters.length, 2);
    assert.notStrictEqual(filters[0], filters[1],
      'and the two were counted under different ACL clauses');
  });

  await t.test('a different keyword is a different entry', async (tt) => {
    withIndexes(tt, {});
    stubAllLegs(tt);

    const first = capture();
    await searchController.counts(anonymous({ keywords: 'caribou' }), first.res);
    const second = capture();
    await searchController.counts(anonymous({ keywords: 'salmon' }), second.res);

    assert.strictEqual(second.out.body[0].meta[0].cached, false);
  });

  // Whitespace is the one normalisation: it cannot change what the analyzer tokenises.
  await t.test('surrounding whitespace does not split the entry', async (tt) => {
    withIndexes(tt, {});
    stubAllLegs(tt);

    const first = capture();
    await searchController.counts(anonymous({ keywords: 'caribou' }), first.res);
    const second = capture();
    await searchController.counts(anonymous({ keywords: '  caribou ' }), second.res);

    assert.strictEqual(second.out.body[0].meta[0].cached, true);
  });
});
