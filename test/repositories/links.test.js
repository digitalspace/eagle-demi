'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const links = require('../../src/repositories/links');

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
});
