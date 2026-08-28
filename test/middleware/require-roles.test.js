'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { requireWrite, requireAdmin } = require('../../src/middleware/require-roles');
const apiKeys = require('../../src/repositories/api-keys');
const apiKeyController = require('../../src/controllers/nosql/api-key');
const {
  isPrivileged, canWrite, canAdmin, SECURE_ROLES, ADMIN_ROLES, WRITE_ROLES
} = require('../../src/helpers/access-sql');

function run(gate, roles) {
  const req = { user: { realm_access: { roles } } };
  const result = { status: null, body: null, nexted: false };
  const res = {
    status(code) { result.status = code; return this; },
    json(body) { result.body = body; return this; }
  };
  gate(req, res, () => { result.nexted = true; });
  return result;
}

const runGate = roles => run(requireWrite, roles);
const runAdminGate = roles => run(requireAdmin, roles);

// The pair below is the point of this file. A read-only tier that is merely *declared* would pass
// a test that only checks it can read. It has to be shown BOTH reading and being refused a write —
// otherwise `demi-service-read` doing nothing at all would look identical to it working.
test('demi-service-read reads everything and writes nothing', async (t) => {
  await t.test('it is privileged for reads, so the ACL predicate does not restrict it', () => {
    assert.strictEqual(isPrivileged(['public', 'demi-service-read']), true);
  });

  await t.test('it is refused by the write gate', () => {
    const r = runGate(['public', 'demi-service-read']);
    assert.strictEqual(r.nexted, false, 'must not reach the controller');
    assert.strictEqual(r.status, 403);
    assert.match(r.body.error, /read-only/i);
  });
});

test('requireWrite admits every role that could write before this existed', async (t) => {
  // Regression guard: this middleware was added to make a read-only tier possible, NOT to take
  // anything away. If this fails, a previously working consumer has just been locked out.
  for (const role of ['sysadmin', 'staff', 'demi-admin']) {
    await t.test(`${role} still writes`, () => {
      const r = runGate(['public', role]);
      assert.strictEqual(r.nexted, true, `${role} must retain write access`);
      assert.strictEqual(r.status, null);
    });
  }

  await t.test('WRITE_ROLES is the historical privileged set plus the machine writer', () => {
    assert.deepStrictEqual([...WRITE_ROLES].sort(),
      ['demi-admin', 'demi-service-write', 'staff', 'sysadmin']);
  });

  await t.test('ADMIN_ROLES is exactly the historical privileged set', () => {
    assert.deepStrictEqual([...ADMIN_ROLES].sort(), ['demi-admin', 'staff', 'sysadmin']);
  });

  await t.test('and demi-service-read is a read tier only — never in WRITE_ROLES', () => {
    assert.ok(SECURE_ROLES.includes('demi-service-read'), 'must grant read privilege');
    assert.ok(!WRITE_ROLES.includes('demi-service-read'), 'must not grant write');
    assert.strictEqual(canWrite(['demi-service-read']), false);
  });
});

test('requireWrite refuses anything unprivileged', async (t) => {
  for (const roles of [[], ['public'], ['compliance'], ['project:207']]) {
    await t.test(`${JSON.stringify(roles)} cannot write`, () => {
      assert.strictEqual(runGate(roles).nexted, false);
    });
  }

  await t.test('a missing req.user fails closed rather than throwing', () => {
    const result = { status: null, nexted: false };
    const res = { status(c) { result.status = c; return this; }, json() { return this; } };
    requireWrite({}, res, () => { result.nexted = true; });
    assert.strictEqual(result.nexted, false);
    assert.strictEqual(result.status, 403);
  });
});

// The mirror of the demi-service-read pair above, and the same reason it is written as a pair: a
// write tier that is merely *declared* would pass a test that only checks it can write. It has to
// be shown BOTH writing data and being refused the admin surface — otherwise granting it
// `demi-admin` in all but name would look identical to this working.
test('demi-service-write writes data and administers nothing', async (t) => {
  await t.test('it reads like staff, so the ACL predicate does not restrict it', () => {
    assert.strictEqual(isPrivileged(['public', 'demi-service-write']), true);
    assert.ok(SECURE_ROLES.includes('demi-service-write'));
  });

  await t.test('the write gate admits it', () => {
    const r = runGate(['public', 'demi-service-write']);
    assert.strictEqual(r.nexted, true, 'the Eagle push and the extractor need this');
    assert.strictEqual(r.status, null);
    assert.strictEqual(canWrite(['demi-service-write']), true);
  });

  await t.test('the admin gate refuses it, so it cannot mint itself a key', () => {
    const r = runAdminGate(['public', 'demi-service-write']);
    assert.strictEqual(r.nexted, false, 'must not reach the api-key controller');
    assert.strictEqual(r.status, 403);
    assert.strictEqual(canAdmin(['demi-service-write']), false);
    assert.ok(!ADMIN_ROLES.includes('demi-service-write'));
  });

  await t.test('a key may be granted it', () => {
    // The role is useless if the mint route rejects it as unknown. GRANTABLE_ROLES derives from
    // AUTHENTICATED_ROLES, so this asserts the derivation still reaches the new tier.
    const { GRANTABLE_ROLES } = require('../../src/controllers/nosql/api-key');
    assert.ok(GRANTABLE_ROLES.includes('demi-service-write'));
    assert.ok(GRANTABLE_ROLES.includes('demi-service-read'));
  });
});

// A role the mint route rejects as unknown is a role nobody can hold. `staff` left SECURE_ROLES in
// P3-2, so GRANTABLE_ROLES derives from AUTHENTICATED_ROLES instead.
test('staff and compliance API keys can still be minted', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.mock.method(apiKeys, 'upsert', async (record) => record);

  const mintRes = () => ({
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json() { return this; }
  });

  // `allowWrite` because staff is in WRITE_ROLES, which is a separate confirmation and unchanged.
  const staff = mintRes();
  await apiKeyController.createApiKey(
    { body: { name: 'staff key', roles: ['staff'], allowWrite: true } }, staff);
  assert.strictEqual(staff.statusCode, 201);

  const compliance = mintRes();
  await apiKeyController.createApiKey(
    { body: { name: 'compliance key', roles: ['compliance'] } }, compliance);
  assert.strictEqual(compliance.statusCode, 201);
});

test('requireAdmin admits every role that could administer before the split', async (t) => {
  // Regression guard, same shape as the requireWrite one: splitting the gate was meant to take
  // privilege away from the machine tier only, never from a human role.
  for (const role of ['sysadmin', 'staff', 'demi-admin']) {
    await t.test(`${role} still administers`, () => {
      const r = runAdminGate(['public', role]);
      assert.strictEqual(r.nexted, true, `${role} must retain admin access`);
      assert.strictEqual(r.status, null);
    });
  }

  await t.test('and refuses the read tier and anything unprivileged', () => {
    for (const roles of [[], ['public'], ['compliance'], ['demi-service-read']]) {
      assert.strictEqual(runAdminGate(roles).nexted, false, JSON.stringify(roles));
    }
  });

  await t.test('a missing req.user fails closed rather than throwing', () => {
    const result = { status: null, nexted: false };
    const res = { status(c) { result.status = c; return this; }, json() { return this; } };
    requireAdmin({}, res, () => { result.nexted = true; });
    assert.strictEqual(result.nexted, false);
    assert.strictEqual(result.status, 403);
  });
});
