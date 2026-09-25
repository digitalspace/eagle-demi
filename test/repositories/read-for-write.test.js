'use strict';

/**
 * `readForWrite`: the unfiltered existence check a mirror write makes before it chooses create or
 * an etag-guarded replace. It skips `canRead`, so it must stay on the write side.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const cosmos = require('../../src/db/cosmos-nosql');
const commentPeriods = require('../../src/repositories/comment-periods');
const comments = require('../../src/repositories/comments');
const projects = require('../../src/repositories/projects');
const { logger } = require('../../src/utils/logger');

const SRC = path.join(__dirname, '..', '..', 'src');

/** One stored row per partition key, answered by point read or by the cross-partition query. */
function stored(t, rows) {
  const queries = [];
  t.mock.method(cosmos, 'readItem', async (_container, id, pk) =>
    rows.find(r => r.id === id && r.pk === pk) || null);
  t.mock.method(cosmos, 'query', async (container, spec) => {
    queries.push({ container, spec });
    const id = spec.parameters.find(p => p.name === '@id').value;
    return { items: rows.filter(r => r.id === id), continuationToken: undefined, requestCharge: 0 };
  });
  return queries;
}

test('readForWrite on the parent-partitioned mirrors', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a period in the named project is one point read, no query', async () => {
    const queries = stored(t, [{ id: 'p1', pk: '207' }]);

    const row = await commentPeriods.readForWrite('p1', '207');

    assert.deepStrictEqual({ row, queries }, { row: { id: 'p1', pk: '207' }, queries: [] });
  });

  await t.test('a comment in the named period is one point read, no query', async () => {
    const queries = stored(t, [{ id: 'c1', pk: 'period1' }]);

    const row = await comments.readForWrite('c1', 'period1');

    assert.deepStrictEqual({ row, queries }, { row: { id: 'c1', pk: 'period1' }, queries: [] });
  });

  await t.test('a row that moved parent is found across partitions, with no ACL predicate', async () => {
    const queries = stored(t, [{ id: 'p1', pk: '208', read: ['compliance'] }]);

    const row = await commentPeriods.readForWrite('p1', '207');

    assert.deepStrictEqual(row, { id: 'p1', pk: '208', read: ['compliance'] });
    assert.doesNotMatch(queries[0].spec.query, /read/);
  });

  await t.test('an id held in two partitions warns with the id and count only', async () => {
    stored(t, [{ id: 'c1', pk: 'a', comment: 'secret text' }, { id: 'c1', pk: 'b' }]);
    const warned = [];
    t.mock.method(logger, 'warn', (message, meta) => { warned.push(meta); });

    await comments.readForWrite('c1', 'z');

    assert.deepStrictEqual(warned, [{ container: 'comments', id: 'c1', count: 2 }]);
  });

  await t.test('a project by Eagle id is found with no ACL predicate', async () => {
    const specs = [];
    t.mock.method(cosmos, 'queryFirst', async (_container, spec) => {
      specs.push(spec);
      return { id: '207', eagleId: '588511d0aaecd9001b825604' };
    });

    const row = await projects.readForWriteByEagleId('588511d0aaecd9001b825604');

    assert.strictEqual(row.id, '207');
    assert.doesNotMatch(specs[0].query, /read/);
    assert.match(specs[0].query, /\bc\.eagleId = @eagleId\b/);
    assert.deepStrictEqual(specs[0].parameters,
      [{ name: '@eagleId', value: '588511d0aaecd9001b825604' }]);
  });
});

/** Every .js file under `dir`, as a path relative to src/. */
function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.js') ? [path.relative(SRC, full)] : [];
  });
}

test('readForWrite is reached only from the mirror write paths', () => {
  // Named files, not directories: a new caller of an unfiltered read is a decision, not a default.
  const ALLOWED = new Set([
    'controllers/nosql/comment-period.js',
    'controllers/nosql/comment.js',
    'controllers/nosql/notification.js',
    'controllers/nosql/organization.js',
    'controllers/nosql/update.js',
    'helpers/parent-admit.js',
    // An Update's parent, read to narrow the Update's own read: a filtered read would miss a sealed one.
    'helpers/update-acl.js',
    'helpers/update-parent.js',
    'repositories/_sql.js',
    'repositories/comment-periods.js',
    'repositories/comments.js',
    'repositories/lists.js',
    'repositories/notifications.js',
    'repositories/projects.js',
    'repositories/updates.js',
    'scripts/seed-public-reads.js'
  ].map(file => path.join(...file.split('/'))));
  const allowed = (file) => ALLOWED.has(file);

  const outside = sourceFiles(SRC)
    .filter(file => /readForWrite/.test(fs.readFileSync(path.join(SRC, file), 'utf8')))
    .filter(file => !allowed(file));

  assert.deepStrictEqual(outside, []);
});
