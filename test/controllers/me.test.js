'use strict';

const test = require('node:test');
const assert = require('node:assert');

const meController = require('../../src/controllers/nosql/me');

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
});
