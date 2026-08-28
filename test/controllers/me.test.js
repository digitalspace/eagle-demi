'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const meController = require('../../src/controllers/me');
const { withServer } = require('../helpers/with-server');

function mockRes() {
  return {
    body: undefined,
    json(data) { this.body = data; return this; }
  };
}

function meFor(tokenRoles) {
  const res = mockRes();
  meController.getMe({ user: { realm_access: { roles: tokenRoles } } }, res);
  return res.body;
}

test('me controller', async (t) => {
  await t.test('anonymous /api/me returns level 4 and no privilege', () => {
    const res = mockRes();

    meController.getMe({}, res);

    assert.deepStrictEqual(res.body, { roles: ['public'], level: 4, tier: 'public', privileged: false });
  });

  await t.test('/api/me never returns a token or a key id', () => {
    const req = { user: { realm_access: { roles: ['staff'] } }, headers: { authorization: 'Bearer x' } };
    const res = mockRes();

    meController.getMe(req, res);

    assert.deepStrictEqual(Object.keys(res.body).sort(), ['level', 'privileged', 'roles', 'tier']);
  });

  // `privileged` is the whole reason this field exists: a client that re-derived it from `tier`
  // gets the scoped staff row wrong, and that is a real credential shape (a staff key minted for
  // one project).
  await t.test('privileged answers the row-plane short-circuit, not the tier', () => {
    assert.strictEqual(meFor(['sysadmin']).privileged, true);
    assert.strictEqual(meFor(['demi-admin']).privileged, true);

    // False for staff since `staff` left SECURE_ROLES. The frontend gates on `level <= 2`.
    assert.strictEqual(meFor(['staff']).privileged, false);
    assert.strictEqual(meFor(['staff', 'project:207']).privileged, false);
    assert.strictEqual(meFor(['compliance']).privileged, false);
    assert.strictEqual(meFor(['public']).privileged, false);
    assert.strictEqual(meFor(['project:207']).privileged, false);
  });

  await t.test('a staff caller holding a project role is level 2 and not scoped', () => {
    // Team membership grants; it does not restrict. Only a key's own projectScope makes a caller
    // scoped, and that is the shape below.
    assert.deepStrictEqual(meFor(['staff', 'project:207']), {
      roles: ['public', 'staff'],
      level: 2,
      tier: 'public',
      privileged: false
    });
  });

  await t.test('a key minted with a projectScope is still scoped', () => {
    const res = mockRes();
    meController.getMe(
      { user: { realm_access: { roles: ['staff'] }, projectScope: ['207'] } }, res);

    assert.deepStrictEqual(res.body, {
      roles: ['public', 'staff'],
      level: 2,
      tier: 'scoped',
      privileged: false
    });
  });

  await t.test('the mounted route answers an anonymous request with 200', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/me`);
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(await res.json(), {
        roles: ['public'], level: 4, tier: 'public', privileged: false
      });
    });
  });
});
