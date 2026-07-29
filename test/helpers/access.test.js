'use strict';

process.env.NODE_ENV = 'test';
// Deliberately NOT one of the formerly-hardcoded literals.
process.env.DOCLING_API_KEY = 'configured-key-for-tests';

const test = require('node:test');
const assert = require('node:assert');

const { authenticate } = require('../../src/helpers/auth');
const { rolesFor, readFilter, withReadFilter, canRead } = require('../../src/helpers/access');

function reqWithKey(key) {
  return { header: (name) => (name === 'X-Api-Key' ? key : null) };
}

test('Hardcoded admin API keys are rejected (regression: public-repo credential leak)', async (t) => {
  // These two literals used to sit in validKeys with no environment guard, so anyone
  // reading the public repo had unconditional sysadmin on every write route.
  for (const leaked of ['demi-admin-key-dev-2026', 'not-a-real-key']) {
    await t.test(`rejects "${leaked}"`, () => {
      let failureStatus = null;
      authenticate(
        reqWithKey(leaked),
        () => assert.fail(`authenticate() accepted the un-configured key "${leaked}"`),
        (status) => { failureStatus = status; }
      );
      assert.strictEqual(failureStatus, 401);
    });
  }

  await t.test('still accepts the key supplied via configuration', () => {
    let user = null;
    authenticate(
      reqWithKey('configured-key-for-tests'),
      (u) => { user = u; },
      (status) => assert.fail(`configured key rejected with ${status}`)
    );
    assert.ok(user);
    assert.ok(user.realm_access.roles.includes('sysadmin'));
  });
});

test('readFilter gates reads by role', async (t) => {
  await t.test('anonymous callers are constrained to the public ACL', () => {
    const filter = readFilter(['public']);
    assert.ok(Array.isArray(filter.$or), 'must apply an ACL clause, never a bare {}');
    assert.deepStrictEqual(filter.$or[0], { read: { $in: ['public'] } });
    assert.strictEqual(filter.$or.length, 3, 'ACL match + isPublished mirror + legacy tier');
  });

  await t.test('an explicit isPublished:false is never matched by any tier', () => {
    const clauses = readFilter(['public']).$or;
    // Tier 2 requires isPublished:true; tier 3 requires the field to be absent entirely.
    // Neither can match a row that says isPublished:false.
    assert.deepStrictEqual(clauses[1].isPublished, true);
    assert.deepStrictEqual(clauses[2].isPublished, { $exists: false });
  });

  await t.test('privileged roles read unfiltered', () => {
    for (const role of ['sysadmin', 'staff', 'demi-admin']) {
      assert.deepStrictEqual(readFilter(['public', role]), {}, `${role} should be unfiltered`);
    }
  });

  await t.test('an unprivileged extra role does not unlock everything', () => {
    const filter = readFilter(['public', 'some-unrelated-role']);
    assert.ok(Array.isArray(filter.$or), 'unknown roles must not bypass the ACL');
  });

  await t.test('withReadFilter combines with $and so criteria cannot cancel the ACL', () => {
    const combined = withReadFilter(['public'], { sector: 'Mining' });
    assert.ok(Array.isArray(combined.$and));
    assert.strictEqual(combined.$and.length, 2);
    assert.ok(combined.$and.some(c => c.sector === 'Mining'));
    assert.ok(combined.$and.some(c => Array.isArray(c.$or)));
  });

  await t.test('withReadFilter still applies the ACL when there are no extra criteria', () => {
    const only = withReadFilter(['public'], null);
    assert.ok(Array.isArray(only.$or));
  });
});

test('rolesFor reads only from the verified token', async (t) => {
  await t.test('defaults to public with no user', () => {
    assert.deepStrictEqual(rolesFor({}), ['public']);
  });

  await t.test('ignores client-supplied headers', () => {
    const req = { header: () => 'sysadmin', user: undefined };
    assert.deepStrictEqual(rolesFor(req), ['public']);
  });

  await t.test('includes roles from req.user', () => {
    const req = { user: { realm_access: { roles: ['staff'] } } };
    assert.deepStrictEqual(rolesFor(req).sort(), ['public', 'staff']);
  });
});

test('canRead gates already-fetched records (point reads)', async (t) => {
  await t.test('public cannot read a record with a private ACL', () => {
    assert.strictEqual(canRead({ read: ['sysadmin'], isPublished: false }, ['public']), false);
  });

  await t.test('public can read a record with public in its ACL', () => {
    assert.strictEqual(canRead({ read: ['public'] }, ['public']), true);
  });

  await t.test('admin can read anything', () => {
    assert.strictEqual(canRead({ read: ['sysadmin'] }, ['public', 'sysadmin']), true);
  });

  await t.test('falls back to isPublished when no ACL is present, and fails closed', () => {
    assert.strictEqual(canRead({ isPublished: true }, ['public']), true);
    assert.strictEqual(canRead({}, ['public']), false, 'no ACL and no flag must not be public');
  });
});
