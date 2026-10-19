'use strict';

// The upstream ACL comments.aclRowsForPeriod hands the period cascade: a DEMI row's own stored
// read, an Eagle row's raw Eagle read.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const comments = require('../../src/repositories/comments');
const { systemAccess } = require('../../src/helpers/access-sql');

test('aclRowsForPeriod gives a DEMI row its own stored read as the upstream ACL', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.mock.method(cosmos, 'query', async () => ({
    items: [
      { id: 'd', read: ['staff'], sourceSystem: 'demi', demiRead: ['public', 'staff'], eagleRead: undefined },
      { id: 'e', read: ['staff'], sourceSystem: 'eagle', eagleRead: ['public'], demiRead: ['staff'] }
    ]
  }));

  const rows = await comments.aclRowsForPeriod(systemAccess(), 'period-1');

  assert.deepStrictEqual(rows.map(r => [r.id, r.eagleRead]), [['d', ['public', 'staff']], ['e', ['public']]]);
});
