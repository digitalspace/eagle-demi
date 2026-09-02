'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const meController = require('../../src/controllers/me');
const { routeChains } = require('../helpers/router-source');
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

    assert.deepStrictEqual(res.body, {
      roles: ['public'], level: 4, tier: 'public', privileged: false, staffUi: false,
      credentials: []
    });
  });

  await t.test('/api/me never returns a token or a key id', () => {
    const req = { user: { realm_access: { roles: ['staff'] } }, headers: { authorization: 'Bearer x' } };
    const res = mockRes();

    meController.getMe(req, res);

    assert.deepStrictEqual(
      Object.keys(res.body).sort(),
      ['credentials', 'level', 'privileged', 'roles', 'staffUi', 'tier']);
  });

  // `privileged` is the whole reason this field exists: a client that re-derived it from `tier`
  // gets the scoped staff row wrong, and that is a real credential shape (a staff key minted for
  // one project).
  await t.test('privileged answers the row-plane short-circuit, not the tier', () => {
    assert.strictEqual(meFor(['sysadmin']).privileged, true);
    assert.strictEqual(meFor(['demi-admin']).privileged, true);

    // False for staff since `staff` left SECURE_ROLES. The frontend gates on `staffUi`.
    assert.strictEqual(meFor(['staff']).privileged, false);
    assert.strictEqual(meFor(['staff', 'project:207']).privileged, false);
    assert.strictEqual(meFor(['compliance']).privileged, false);
    assert.strictEqual(meFor(['public']).privileged, false);
    assert.strictEqual(meFor(['project:207']).privileged, false);
  });

  // The frontend gate. Neither `level` nor `tier` can answer it: `staff` and `compliance` are both
  // level 2 / tier `public`, and only one of them may reach an authenticated route.
  await t.test('staffUi is the authenticated-route predicate, not the tier', () => {
    assert.strictEqual(meFor(['staff']).staffUi, true);
    assert.strictEqual(meFor(['staff', 'project:207']).staffUi, true);
    assert.strictEqual(meFor(['sysadmin']).staffUi, true);
    assert.strictEqual(meFor(['compliance']).staffUi, false);
    assert.strictEqual(meFor(['public']).staffUi, false);
  });

  await t.test('a staff caller holding a project role is level 2 and not scoped', () => {
    // Team membership grants; it does not restrict. Only a key's own projectScope makes a caller
    // scoped, and that is the shape below.
    assert.deepStrictEqual(meFor(['staff', 'project:207']), {
      roles: ['public', 'staff'],
      level: 2,
      tier: 'public',
      privileged: false,
      staffUi: true,
      credentials: []
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
      privileged: false,
      staffUi: true,
      credentials: []
    });
  });

  // The holder's only sight of its own expiry. Renewal is the norm on EA timelines, so a grant
  // that says nothing about `end` anywhere the holder can read is one that lapses unannounced.
  await t.test('a holder sees its own live grants, end included', () => {
    const stored = {
      id: 'cred-1',
      party: { type: 'user', id: 'bceid-sub' },
      scope: { type: 'project', ids: ['207'] },
      levels: [1, 2],
      start: '2026-08-01T00:00:00.000Z',
      end: '2026-11-01T00:00:00.000Z',
      revokedAt: null,
      _etag: 'e0'
    };
    const res = mockRes();

    meController.getMe(
      { user: { realm_access: { roles: ['public'] }, sub: 'bceid-sub' }, credentials: [stored] },
      res);

    // Exact, not a subset: `party` and the Cosmos system fields are the holder's own row, but
    // emitting them here would make /api/me a second, unreviewed shape of the grant registry.
    assert.deepStrictEqual(res.body.credentials, [{
      id: 'cred-1',
      scope: { type: 'project', ids: ['207'] },
      levels: [1, 2],
      end: '2026-11-01T00:00:00.000Z'
    }]);
  });

  // `end` reaches the holder only if the loader runs, and it reads `req.user`, so the order is the
  // behaviour: credentialsMiddleware ahead of passive auth attaches nothing on every request.
  await t.test('GET /me loads credentials after passive auth', () => {
    const route = routeChains().find(r => r.method === 'get' && r.path === '/me');
    assert.ok(route, 'no GET /me in the route table');
    assert.match(route.chain, /passiveAuthMiddleware\s*,\s*credentialsMiddleware/);
  });

  await t.test('the mounted route answers an anonymous request with 200', async () => {
    await withServer(async (call) => {
      const res = await call('/api/me');
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(await res.json(), {
        roles: ['public'], level: 4, tier: 'public', privileged: false, staffUi: false,
        credentials: []
      });
    });
  });
});
