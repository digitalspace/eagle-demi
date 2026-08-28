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
  await t.test('privileged answers staff/admin membership, not the tier', () => {
    assert.strictEqual(meFor(['staff']).privileged, true);
    assert.strictEqual(meFor(['staff', 'project:207']).privileged, true);
    assert.strictEqual(meFor(['sysadmin']).privileged, true);
    assert.strictEqual(meFor(['demi-admin']).privileged, true);

    assert.strictEqual(meFor(['compliance']).privileged, false);
    assert.strictEqual(meFor(['public']).privileged, false);
    assert.strictEqual(meFor(['project:207']).privileged, false);
  });

  await t.test('a project-scoped staff caller is scoped AND privileged', () => {
    assert.deepStrictEqual(meFor(['staff', 'project:207']), {
      roles: ['public', 'staff'],
      level: 2,
      tier: 'scoped',
      privileged: true
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
