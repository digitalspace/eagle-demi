'use strict';

// The upstream ACL groups.setAclForProject derives from: a DEMI row's own stored read, an Eagle
// row's raw Eagle read.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const groups = require('../../src/repositories/groups');
const { levelOfRead } = require('../../src/helpers/access-sql');

test('setAclForProject re-derives a narrowed DEMI group from its own stored read', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.mock.method(cosmos, 'query', async () => ({
    items: [
      {
        id: 'd', read: ['sysadmin'], sourceSystem: 'demi',
        demiRead: ['project-system-admin', 'sysadmin', 'staff'], eagleRead: undefined
      },
      { id: 'e', read: ['sysadmin'], sourceSystem: 'eagle', eagleRead: ['public', 'staff', 'sysadmin'], demiRead: undefined }
    ]
  }));
  let patched = [];
  t.mock.method(cosmos, 'bulkVerified', async (container, operations) => {
    patched = operations;
    return { succeeded: operations.length, failed: 0, statusCounts: {}, requestCharge: 0 };
  });

  const result = await groups.setAclForProject('p-1', ['public', 'staff', 'sysadmin']);

  const levels = Object.fromEntries(result.rows.map(row => [row.id, levelOfRead(row.read)]));
  assert.strictEqual(levels.d, 2, 'the DEMI group opens back to staff, never to public');
  assert.strictEqual(levels.e, levelOfRead(['public', 'staff', 'sysadmin']));
  assert.deepStrictEqual(patched.map(op => op.id), ['d', 'e']);
});
