'use strict';

// Offset pages past the 1,000 rows one Cosmos fetch carries. eagle-public's `/news` asked for
// `pageNum=100&pageSize=10` of 2,510 updates and got an empty page under a total of 2,510.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const updates = require('../../src/repositories/updates');
const comments = require('../../src/repositories/comments');
const notifications = require('../../src/repositories/notifications');
const lists = require('../../src/repositories/lists');
const commentPeriods = require('../../src/repositories/comment-periods');
const projects = require('../../src/repositories/projects');
const { resolveAccess, MAX_PAGE_DEPTH } = require('../../src/helpers/access-sql');
const { ids, pagedCosmos } = require('../helpers/paged-cosmos');
const { stubCosmos, get } = require('../helpers/search-reads');

const anonymous = () => resolveAccess({});
const idsOf = (rows) => rows.map(row => row.id);

/** Every `readPage` list, with the container it pages, its partition and the order it keeps. */
const READS = [
  { name: 'updates.list', container: updates.CONTAINER, order: 'c.dateAdded DESC',
    read: (opts) => updates.list(anonymous(), { sortBy: '-dateAdded', ...opts }) },
  { name: 'comments.listByPeriod', container: comments.CONTAINER, order: 'c.commentId ASC',
    partitionKey: 'CP1', read: (opts) => comments.listByPeriod('CP1', anonymous(), opts) },
  { name: 'notifications.list', container: notifications.CONTAINER,
    order: 'c.notificationReceivedDate DESC', read: (opts) => notifications.list(anonymous(), opts) },
  { name: 'lists.listByKind', container: lists.CONTAINER, order: 'c.name ASC',
    partitionKey: lists.KINDS.ORGANIZATION,
    read: (opts) => lists.listByKind(lists.KINDS.ORGANIZATION, anonymous(), opts) },
  { name: 'commentPeriods.listByProject', container: commentPeriods.CONTAINER,
    order: 'c.dateStarted DESC', partitionKey: '207',
    read: (opts) => commentPeriods.listByProject('207', anonymous(), opts) },
  // Partitioned by id, so every fetch is cross-partition: no partition key on any of them.
  { name: 'projects.listPage', container: projects.CONTAINER, order: 'c.name ASC',
    read: (opts) => projects.listPage(anonymous(), opts) }
];

for (const { name, container, order, partitionKey, read } of READS) {
  test(`${name} pages past the first 1,000 rows`, async (t) => {
    const rows = ids('r', 2505);
    const seen = pagedCosmos(t, c => (c === container ? rows : []));
    /** The fetches `run` made against this list's own container. */
    const fetchesOf = async (run) => {
      const before = seen.length;
      const page = await run();
      return { page, fetches: seen.slice(before).filter(s => s.container === container) };
    };

    await t.test('the page at offset 1,000 is the next rows, in two fetches', async () => {
      const { page, fetches } = await fetchesOf(() => read({ pageNum: 100, pageSize: 10 }));
      assert.deepStrictEqual(idsOf(page), idsOf(rows.slice(1000, 1010)));
      assert.strictEqual(fetches.length, 2);
      assert.ok(fetches.every(s => s.spec.query.endsWith(`ORDER BY ${order}`)), 'same ORDER BY');
      assert.ok(fetches.every(s => s.options.partitionKey === partitionKey),
        'every continuation fetch stays on the partition');
    });

    await t.test('the last page is short, and one past it is empty after reading the set once',
      async () => {
        assert.deepStrictEqual(idsOf(await read({ pageNum: 250, pageSize: 10 })),
          idsOf(rows.slice(2500)));
        const { page, fetches } = await fetchesOf(() => read({ pageNum: 251, pageSize: 10 }));
        assert.deepStrictEqual(page, []);
        assert.strictEqual(fetches.length, 3);
      });

    await t.test('a page inside the first 1,000 rows is still one fetch', async () => {
      const { page, fetches } = await fetchesOf(() => read({ pageNum: 3, pageSize: 10 }));
      assert.deepStrictEqual(idsOf(page), idsOf(rows.slice(30, 40)));
      assert.deepStrictEqual(fetches.map(s => s.options.maxItemCount), [40]);
    });

    await t.test('a page past MAX_PAGE_DEPTH is refused with 400 before any read', async () => {
      const deepest = MAX_PAGE_DEPTH / 10 - 1;
      await read({ pageNum: deepest, pageSize: 10 });
      const { fetches } = await fetchesOf(() => assert.rejects(read({ pageNum: deepest + 1, pageSize: 10 }),
        err => err.status === 400 && /past the deepest page this list serves/.test(err.message)));
      assert.strictEqual(fetches.length, 0);
    });
  });
}

test('a short or empty fetch that still carries a token is followed', async (t) => {
  await t.test('short fetches', async (tt) => {
    const rows = ids('c', 50);
    const seen = pagedCosmos(tt, () => rows, { pageSize: 7 });
    assert.deepStrictEqual(idsOf(await comments.listByPeriod('CP1', anonymous(), { pageNum: 3, pageSize: 10 })),
      idsOf(rows.slice(30, 40)));
    assert.strictEqual(seen.length, Math.ceil(40 / 7));
  });

  await t.test('an empty first fetch', async (tt) => {
    const rows = ids('c', 50);
    const seen = pagedCosmos(tt, () => rows, { emptyFetches: 1 });
    assert.deepStrictEqual(idsOf(await comments.listByPeriod('CP1', anonymous(), { pageNum: 0, pageSize: 10 })),
      idsOf(rows.slice(0, 10)));
    assert.strictEqual(seen.length, 2);
  });
});

test('GET /search refuses a page past MAX_PAGE_DEPTH with 400, not an empty page', async (t) => {
  stubCosmos(t, { updates: [] });
  const { status, body } = await get(
    `/api/search?dataset=RecentActivity&sortBy=-dateAdded&pageSize=10&pageNum=${MAX_PAGE_DEPTH / 10}`);
  assert.strictEqual(status, 400);
  assert.match(body.error, /past the deepest page this list serves/);
});

test('GET /search serves the bare project list past row 1,000', async (t) => {
  const rows = ids('p', 1500).map(row => ({ ...row, name: row.id, read: ['public'] }));
  pagedCosmos(t, c => (c === projects.CONTAINER ? rows : []));
  t.mock.method(projects, 'countVisible', async () => rows.length);

  const { status, body } = await get('/api/search?dataset=Project&pageSize=10&pageNum=100');

  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body[0].searchResults.map(r => r.id), idsOf(rows.slice(1000, 1010)));
  assert.strictEqual(body[0].count, 1500);
});

test('GET /search refuses a project page past MAX_PAGE_DEPTH with 400', async (t) => {
  stubCosmos(t, { projects: [] });
  const { status, body } = await get(
    `/api/search?dataset=Project&pageSize=10&pageNum=${MAX_PAGE_DEPTH / 10}`);
  assert.strictEqual(status, 400);
  assert.match(body.error, /past the deepest page this list serves/);
});
