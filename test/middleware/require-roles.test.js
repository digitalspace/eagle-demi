'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { requireWrite } = require('../../src/middleware/require-roles');
const { isPrivileged, canWrite, SECURE_ROLES, WRITE_ROLES } = require('../../src/helpers/access-sql');

function runGate(roles) {
  const req = { user: { realm_access: { roles } } };
  const result = { status: null, body: null, nexted: false };
  const res = {
    status(code) { result.status = code; return this; },
    json(body) { result.body = body; return this; }
  };
  requireWrite(req, res, () => { result.nexted = true; });
  return result;
}

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

  await t.test('WRITE_ROLES is exactly the historical privileged set', () => {
    assert.deepStrictEqual([...WRITE_ROLES].sort(), ['demi-admin', 'staff', 'sysadmin']);
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
