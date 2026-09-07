'use strict';

/**
 * The list reads the `/search` branches will be built on. What is asserted is the SQL each one
 * emits, because every one of these failures is silent: a missing visibility fragment answers 200
 * with rows the caller may not see, a count built from a different predicate advertises the size of
 * a set they cannot open, and an offset page that is never sliced repeats page 1 forever.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const cosmos = require('../../src/db/cosmos-nosql');
const commentPeriods = require('../../src/repositories/comment-periods');
const comments = require('../../src/repositories/comments');
const notifications = require('../../src/repositories/notifications');
const lists = require('../../src/repositories/lists');
const updates = require('../../src/repositories/updates');
const { TIER } = require('../../src/helpers/access-sql');

const ANON = { tier: TIER.PUBLIC, roles: ['public'], projectScope: null, teams: [], level: 4 };

/**
 * The fields one container's indexing policy includes, as the bicep writes them.
 *
 * A path is reduced to its field name, so `/read/[]/?` and `/name/?` both read as one field — the
 * allow-lists these tests pair the policy with are field names.
 */
function indexedFields(container) {
  const bicep = readFileSync(
    join(__dirname, '..', '..', 'azure', 'modules', 'cosmos-nosql.bicep'), 'utf8');
  const policy = bicep.split(`id: '${container}'`)[1].split('excludedPaths')[0];
  return [...policy.matchAll(/path: '\/([A-Za-z]+)(?:\/\[\])?\/\?'/g)].map(m => m[1]);
}

/** Capture the spec and options of the next query, and answer with `items`. */
function capture(t, items = []) {
  const seen = {};
  t.mock.method(cosmos, 'query', async (container, spec, options) => {
    seen.container = container;
    seen.spec = spec;
    seen.options = options;
    return { items };
  });
  return seen;
}

const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));

test('comment periods list by project', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('single-partition, ACL-filtered, ordered', async () => {
    const seen = capture(t, rows(2));

    await commentPeriods.listByProject('207', ANON);

    assert.strictEqual(seen.container, 'commentPeriods');
    assert.match(seen.spec.query, /c\.projectId = @projectId/);
    assert.match(seen.spec.query, /ARRAY_CONTAINS\(c\.read/, 'the visibility predicate is present');
    assert.match(seen.spec.query, /ORDER BY c\.dateStarted DESC$/);
    assert.strictEqual(seen.options.partitionKey, '207');
  });

  await t.test('sortBy picks ONE allowed key and ignores anything else', async () => {
    // Cosmos needs a composite index for a multi-property ORDER BY and these containers define
    // none, so a second clause would be a runtime 400 rather than a nicer order.
    let seen = capture(t);
    await commentPeriods.listByProject('207', ANON, { sortBy: ['-dateAdded', '+dateCompleted'] });
    assert.match(seen.spec.query, /ORDER BY c\.dateAdded DESC$/);

    t.mock.restoreAll();
    seen = capture(t);
    await commentPeriods.listByProject('207', ANON, { sortBy: 'instructions' });
    assert.match(seen.spec.query, /ORDER BY c\.dateStarted DESC$/, 'an unlisted key falls back');
  });

  await t.test('pageNum overfetches and slices', async () => {
    const seen = capture(t, rows(6));

    const page = await commentPeriods.listByProject('207', ANON, { pageNum: 2, pageSize: 2 });

    assert.strictEqual(seen.options.maxItemCount, 6, 'skip + size is what is fetched');
    assert.deepStrictEqual(page.map(r => r.id), ['r4', 'r5']);
  });

  await t.test('the count uses the same predicate as the read', async () => {
    const read = capture(t, []);
    await commentPeriods.listByProject('207', ANON);
    const readWhere = read.spec.query.split(' WHERE ')[1].split(' ORDER BY ')[0];

    t.mock.restoreAll();
    const counted = capture(t, [3]);
    const total = await commentPeriods.countByProject('207', ANON);

    assert.strictEqual(total, 3);
    assert.match(counted.spec.query, /SELECT VALUE COUNT\(1\)/);
    assert.strictEqual(counted.spec.query.split(' WHERE ')[1], readWhere);
  });
});

test('comments list by period', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('partitioned on the period, scoped on the project', async () => {
    const seen = capture(t, rows(1));

    await comments.listByPeriod('p1', ANON);

    assert.strictEqual(seen.options.partitionKey, 'p1');
    assert.match(seen.spec.query, /c\.periodId = @periodId/);
    assert.match(seen.spec.query, /ARRAY_CONTAINS\(c\.read/);
    assert.ok(!/c\.periodId IN/.test(seen.spec.query), 'the project scope never keys on the period');
  });

  await t.test('the count uses the same predicate as the read', async () => {
    const read = capture(t, []);
    await comments.listByPeriod('p1', ANON);
    const readWhere = read.spec.query.split(' WHERE ')[1].split(' ORDER BY ')[0];

    t.mock.restoreAll();
    const counted = capture(t, [42]);
    assert.strictEqual(await comments.countByPeriod('p1', ANON), 42);
    assert.strictEqual(counted.spec.query.split(' WHERE ')[1], readWhere);
  });

  await t.test('the projection stops at the catalog ceiling', async () => {
    const seen = capture(t, []);

    await comments.listByPeriod('p1', ANON);

    assert.match(seen.spec.query, /c\.comment\b/);
    // `author` IS fetched: its ceiling is 4 and `commentAttributed` can widen it at the response
    // boundary, which a projection cannot decide because it has not read the row yet. `sources`
    // has a ceiling of 0, so nothing can ever widen it and it must not leave Cosmos.
    assert.match(seen.spec.query, /c\.author\b/);
    assert.ok(!/c\.sources\b/.test(seen.spec.query));
  });
});

test('notifications list', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('role-filtered, cross-partition, newest first', async () => {
    const seen = capture(t, rows(1));

    await notifications.list(ANON);

    assert.strictEqual(seen.container, 'notifications');
    assert.match(seen.spec.query, /ARRAY_CONTAINS\(c\.read/);
    assert.match(seen.spec.query, /ORDER BY c\.notificationReceivedDate DESC$/);
    assert.ok(!('partitionKey' in seen.options), 'there is no partition to pin to');
  });

  await t.test('no project scope is applied — a notification has no project', async () => {
    // A scoped credential must still see the notifications list; scoping it on a field these rows
    // do not carry would empty the page instead of narrowing it.
    const scoped = { ...ANON, projectScope: { ids: ['207'] } };
    const seen = capture(t, []);

    await notifications.list(scoped);

    assert.ok(!/c\.projectId/.test(seen.spec.query));
  });
});

test('lists by kind', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('the kind is the partition and a criterion', async () => {
    const seen = capture(t, rows(1));

    await lists.listByKind(lists.KINDS.ORGANIZATION, ANON);

    assert.strictEqual(seen.options.partitionKey, 'Organization');
    assert.match(seen.spec.query, /c\.kind = @kind/);
    assert.match(seen.spec.query, /ORDER BY c\.name ASC$/);
  });

  await t.test('an empty-string filter narrows, it does not vanish', async () => {
    // '' is a real stored companyType. A truthiness test would widen the query to every row.
    const seen = capture(t, []);

    await lists.listByKind(lists.KINDS.ORGANIZATION, ANON, { companyType: '' });

    assert.match(seen.spec.query, /c\.companyType = @companyType/);
    assert.ok(seen.spec.parameters.some(p => p.name === '@companyType' && p.value === ''));
  });

  await t.test('an unknown filter key is ignored, not interpolated', async () => {
    const seen = capture(t, []);

    await lists.listByKind(lists.KINDS.LIST, ANON, { 'name; DROP': 'x' });

    assert.ok(!/DROP/.test(seen.spec.query));
    assert.deepStrictEqual(seen.spec.parameters.filter(p => /DROP/.test(p.name)), []);
  });

  await t.test('a sort key is allowed only on the kind whose rows carry it', async () => {
    // A single-property ORDER BY drops every row that lacks the property, so `listOrder` — a `List`
    // field the Organization mirror never writes — must not reach the Organization query.
    let seen = capture(t);
    await lists.listByKind(lists.KINDS.LIST, ANON, { sortBy: 'listOrder' });
    assert.match(seen.spec.query, /ORDER BY c\.listOrder ASC$/);

    t.mock.restoreAll();
    seen = capture(t);
    await lists.listByKind(lists.KINDS.ORGANIZATION, ANON, { sortBy: '-listOrder' });
    assert.match(seen.spec.query, /ORDER BY c\.name ASC$/, 'a List-only key falls back');

    t.mock.restoreAll();
    seen = capture(t);
    await lists.listByKind(lists.KINDS.ORGANIZATION, ANON, { sortBy: 'type' });
    assert.match(seen.spec.query, /ORDER BY c\.name ASC$/, 'so does `type`, which is List-only');

    t.mock.restoreAll();
    seen = capture(t);
    await lists.listByKind(lists.KINDS.ORGANIZATION, ANON, { sortBy: '-companyType' });
    assert.match(seen.spec.query, /ORDER BY c\.companyType DESC$/);
  });

  await t.test('an unknown kind sorts by nothing a caller named', async () => {
    const seen = capture(t);

    await lists.listByKind('Nonsense', ANON, { sortBy: 'name' });

    assert.match(seen.spec.query, /ORDER BY c\.name ASC$/, 'the fallback, not the caller\'s key');
  });

  await t.test('every sortable key is an indexed path on the lists container', () => {
    // An ORDER BY on a path the indexing policy excludes cannot be served at all, so this pairs the
    // allow-list with the bicep that has to carry it.
    const indexed = indexedFields('lists');

    for (const [kind, keys] of Object.entries(lists.SORTABLE)) {
      for (const key of keys) {
        assert.ok(indexed.includes(key), `${kind} sorts by ${key}, which is not an included path`);
      }
    }
    for (const field of Object.values(lists.FILTERS)) {
      assert.ok(indexed.includes(field), `${field} is filtered on but is not an included path`);
    }
  });

  await t.test('the count shares the filter as well as the predicate', async () => {
    const read = capture(t, []);
    await lists.listByKind(lists.KINDS.LIST, ANON, { type: 'doctype' });
    const readWhere = read.spec.query.split(' WHERE ')[1].split(' ORDER BY ')[0];

    t.mock.restoreAll();
    const counted = capture(t, [7]);
    assert.strictEqual(await lists.countByKind(lists.KINDS.LIST, ANON, { type: 'doctype' }), 7);
    assert.strictEqual(counted.spec.query.split(' WHERE ')[1], readWhere);
  });
});

test('updates', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const EAGLE_PROJECT_ID = '588511d0aaecd9001b825604';

  /** The caller's scope is in DEMI ids; the projects container is what maps them to Eagle ones. */
  function serve(projectRows, updateRows = [{ id: 'u1' }]) {
    const seen = [];
    t.mock.method(cosmos, 'query', async (container, spec) => {
      seen.push({ container, spec });
      return { items: container === 'projects' ? projectRows : updateRows };
    });
    return seen;
  }

  const specFor = (seen, container) => seen.filter(s => s.container === container)[0].spec;

  await t.test('every sorted, filtered and ACL field is an indexed path on the container', () => {
    // An ORDER BY on an excluded path cannot be served at all, and an ACL filter on one is a full
    // scan of the container — so this pairs both allow-lists with the bicep that has to carry them.
    const indexed = indexedFields('updates');

    for (const key of updates.SORTABLE) {
      assert.ok(indexed.includes(key), `updates sorts by ${key}, which is not an included path`);
    }
    assert.ok(indexed.includes(updates.SCOPE_FIELD), 'the project scope is filtered on');
    assert.ok(indexed.includes('read'), 'the ACL predicate the list, the count and the strip carry');
    assert.ok(indexed.includes('pinned'), 'listTop splits the strip on it');
  });

  await t.test('a scoped caller reads its own project, by the EAGLE id of it', async () => {
    const scoped = {
      tier: TIER.SCOPED, roles: ['staff'], projectScope: ['207'], teams: [], level: 1
    };
    const seen = serve([{ id: '207', name: 'Nicomen Wind Energy', eagleId: EAGLE_PROJECT_ID }]);

    const rows = await updates.list(scoped);

    assert.deepStrictEqual(rows.map(r => r.id), ['u1']);
    const read = specFor(seen, 'updates');
    assert.match(read.query, /c\.projectId IN \(@scope0\)/);
    assert.deepStrictEqual(
      read.parameters.filter(p => p.name === '@scope0').map(p => p.value), [EAGLE_PROJECT_ID],
      'the scope is in DEMI ids and this container stores Eagle ones — 207 reads zero rows');
  });

  await t.test('a scope whose project has no Eagle counterpart matches nothing', async () => {
    // Fail closed: an untranslatable id must not fall through to an unrestricted read.
    const scoped = {
      tier: TIER.SCOPED, roles: ['staff'], projectScope: ['999'], teams: [], level: 1
    };
    const seen = serve([{ id: '999', name: 'Track-only project' }]);

    await updates.count(scoped);

    assert.match(specFor(seen, 'updates').query, /\bfalse\b/);
  });

  await t.test('an unscoped caller costs no translation query', async () => {
    const seen = serve([]);

    await updates.list(ANON);

    assert.deepStrictEqual(seen.map(s => s.container), ['updates']);
  });
});
