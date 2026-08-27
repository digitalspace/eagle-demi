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

test('me controller', async (t) => {
  await t.test('anonymous /api/me returns level 4', () => {
    const res = mockRes();

    meController.getMe({}, res);

    assert.deepStrictEqual(res.body, { roles: ['public'], level: 4, tier: 'public' });
  });

  await t.test('/api/me never returns a token or a key id', () => {
    const req = { user: { realm_access: { roles: ['staff'] } }, headers: { authorization: 'Bearer x' } };
    const res = mockRes();

    meController.getMe(req, res);

    assert.deepStrictEqual(Object.keys(res.body).sort(), ['level', 'roles', 'tier']);
  });

  await t.test('the mounted route answers an anonymous request with 200', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/me`);
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(await res.json(), { roles: ['public'], level: 4, tier: 'public' });
    });
  });
});
