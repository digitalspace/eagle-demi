'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const links = require('../../src/repositories/links');
const { resolveAccess } = require('../../src/helpers/access-sql');

test('links repository', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('create propagates a 409 on a code clash', async () => {
    t.mock.method(cosmos, 'create', async () => {
      const err = new Error('conflict');
      err.code = 409;
      throw err;
    });
    await assert.rejects(() => links.create({ id: 'abc123', url: 'https://x' }), { code: 409 });
  });

  await t.test('a null from create (container not configured) throws, not a silent 201', async () => {
    t.mock.method(cosmos, 'create', async () => null);
    await assert.rejects(
      () => links.create({ id: 'abc123', url: 'https://x' }),
      /links container not configured/
    );
  });

  await t.test('repoint on a missing code returns null, not a 500', async () => {
    t.mock.method(cosmos, 'patch', async () => {
      const err = new Error('not found');
      err.code = 404;
      throw err;
    });
    assert.strictEqual(await links.repoint('missing', 'https://x'), null);
  });

  await t.test('repoint hands the caller\'s etag to the patch as its guard', async () => {
    let seen = null;
    t.mock.method(cosmos, 'patch', async (...args) => { seen = args; return { id: 'abc123' }; });
    await links.repoint('abc123', 'https://x', { etag: '"e1"' });
    assert.strictEqual(seen[4], undefined, 'no SQL condition');
    assert.strictEqual(seen[5], '"e1"');
  });

  await t.test('remove hands the caller\'s etag to the delete as its guard', async () => {
    let seen = null;
    t.mock.method(cosmos, 'remove', async (...args) => { seen = args; return true; });
    await links.remove('abc123', { etag: '"e1"' });
    assert.deepStrictEqual(seen, [links.CONTAINER, 'abc123', 'abc123', { etag: '"e1"' }]);
  });

  await t.test('remove on a missing code passes the false through', async () => {
    t.mock.method(cosmos, 'remove', async () => false);
    assert.strictEqual(await links.remove('missing'), false);
  });

  await t.test('list returns the items, newest first, ordered in the query', async () => {
    const rows = [{ id: 'a', createdAt: '2026-01-02' }, { id: 'b', createdAt: '2026-01-01' }];
    let seenSpec = null;
    t.mock.method(cosmos, 'query', async (container, spec) => {
      seenSpec = spec;
      assert.strictEqual(container, links.CONTAINER);
      return { items: rows };
    });

    assert.deepStrictEqual(await links.list('staff.person'), rows);
    assert.match(seenSpec.query, /ORDER BY c\.createdAt DESC$/);
    // Shared rows, legacy rows with no flag, plus the caller's own — and the caller only ever
    // arrives as a parameter, never spliced into the SQL.
    assert.match(seenSpec.query, /NOT IS_DEFINED\(c\.personal\)/);
    assert.match(seenSpec.query, /c\.personal = false/);
    assert.match(seenSpec.query, /c\.createdBy = @me/);
    assert.ok(!seenSpec.query.includes('staff.person'));
    assert.deepStrictEqual(seenSpec.parameters, [{ name: '@me', value: 'staff.person' }]);
  });

  await t.test('listProjectCodes maps every held code to its project in one query', async () => {
    const seen = [];
    t.mock.method(cosmos, 'query', async (container, spec) => {
      seen.push({ container, spec });
      return {
        items: [
          // Legacy here and listed first, current on 207 below: current still wins.
          { id: 208, shortCode: 'kemess', legacyShortCodes: ['site-c'] },
          { id: '207', shortCode: 'site-c', legacyShortCodes: ['kq7bt2rm'] }
        ]
      };
    });

    const held = await links.listProjectCodes();

    assert.deepStrictEqual([...held.entries()].sort(), [
      ['kemess', { projectId: '208', projectRole: 'current' }],
      ['kq7bt2rm', { projectId: '207', projectRole: 'legacy' }],
      ['site-c', { projectId: '207', projectRole: 'current' }]
    ]);
    assert.deepStrictEqual(seen.map(q => q.container), ['projects']);
    assert.match(seen[0].spec.query, /^SELECT c\.id, c\.shortCode, c\.legacyShortCodes FROM c WHERE /);
    assert.match(seen[0].spec.query, /IS_DEFINED\(c\.shortCode\) AND NOT IS_NULL\(c\.shortCode\)\) OR ARRAY_LENGTH\(c\.legacyShortCodes\) > 0/);
    assert.ok(!/@role/.test(seen[0].spec.query), 'with no access given, every project counts');
  });

  await t.test('listProjectCodes names the Track row over the Eagle-only twin a relink left behind', async () => {
    t.mock.method(cosmos, 'query', async () => ({
      items: [
        // The twin, listed first, still holds site-c as current; the Track row holds it as legacy.
        { id: 'eagle-58851172', shortCode: 'site-c', legacyShortCodes: ['kq7bt2rm'] },
        { id: '207', shortCode: 'site-c-2', legacyShortCodes: ['site-c', 'kq7bt2rm'] }
      ]
    }));

    const held = await links.listProjectCodes();

    assert.deepStrictEqual(held.get('site-c'), { projectId: '207', projectRole: 'legacy' });
    assert.deepStrictEqual(held.get('kq7bt2rm'), { projectId: '207', projectRole: 'legacy' });
    assert.deepStrictEqual(held.get('site-c-2'), { projectId: '207', projectRole: 'current' });
  });

  await t.test('listProjectCodes under a caller\'s access reads only projects that caller may read', async () => {
    let seenSpec = null;
    t.mock.method(cosmos, 'query', async (_container, spec) => { seenSpec = spec; return { items: [] }; });

    await links.listProjectCodes(resolveAccess({ user: { preferred_username: 'staff.person' } }));

    assert.match(seenSpec.query, /r IN c\.read WHERE r IN \(@role0\)/);
    assert.deepStrictEqual(seenSpec.parameters, [{ name: '@role0', value: 'public' }]);
  });
});
