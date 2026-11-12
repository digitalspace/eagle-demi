'use strict';

// A 404 tells eagle-public the environment runs ungated, so a failed Cosmos read must never answer
// one. 404 checks assert the body: an unregistered route is a dispatcher 404 too.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../../src/config');
const configRepository = require('../../src/repositories/config');
const { routeChains } = require('../helpers/router-source');
const { withServer } = require('../helpers/with-server');

const PASSWORD = 'a-long-random-curtain-password';

/** A gated environment: the flag is on and the document is readable. */
function gateOn(t) {
  t.mock.method(configRepository, 'getPublic', async () => ({
    id: 'public', ENVIRONMENT: 'test', ACCESS_GATE: true
  }));
}

function post(call, body, headers = {}) {
  return call('/api/gate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
}

test('the access curtain', async (t) => {
  const original = config.accessGatePassword;
  t.beforeEach(() => { config.accessGatePassword = PASSWORD; });
  t.afterEach(() => {
    config.accessGatePassword = original;
    t.mock.restoreAll();
  });

  await t.test('204 and no body on the right password', async (t) => {
    gateOn(t);
    await withServer(async (call) => {
      const res = await post(call, { password: PASSWORD });
      assert.equal(res.status, 204);
      assert.equal(await res.text(), '');
    });
  });

  await t.test('answers at /gate as well as /api/gate', async (t) => {
    // APIM forwards under `/api`; direct Function-host callers use the bare path.
    gateOn(t);
    await withServer(async (call) => {
      const res = await call('/gate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD })
      });
      assert.equal(res.status, 204);
    });
  });

  await t.test('401 on a wrong password of the same length', async (t) => {
    gateOn(t);
    await withServer(async (call) => {
      const wrong = 'b'.repeat(PASSWORD.length);
      assert.equal(wrong.length, PASSWORD.length, 'this case is only meaningful at equal length');
      const res = await post(call, { password: wrong });
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: 'Invalid password' });
    });
  });

  await t.test('401, not 500, on a password of a different length', async (t) => {
    // `crypto.timingSafeEqual` throws on unequal lengths; a 500 would leak the length and flood
    // the logs with server errors.
    gateOn(t);
    await withServer(async (call) => {
      for (const wrong of ['x', `${PASSWORD}x`, '']) {
        const res = await post(call, { password: wrong });
        assert.equal(res.status, 401, `length ${wrong.length} must be a 401`);
        assert.deepEqual(await res.json(), { error: 'Invalid password' });
      }
    });
  });

  await t.test('401 when the body carries no password, or not a string', async (t) => {
    gateOn(t);
    await withServer(async (call) => {
      for (const body of [{}, { password: null }, { password: 1234 }, { password: [PASSWORD] }]) {
        const res = await post(call, body);
        assert.equal(res.status, 401, JSON.stringify(body));
      }
    });
  });

  await t.test('503 and no-store when ACCESS_GATE is true but no password is configured', async (t) => {
    config.accessGatePassword = '';
    gateOn(t);

    await withServer(async (call) => {
      const res = await post(call, { password: PASSWORD });
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await res.json(), { error: 'Gate misconfigured' });
    });
  });

  await t.test('503 when the configured password is an unresolved Key Vault reference', async (t) => {
    // An unresolved reference arrives as the literal string, and the same literal is what an
    // attacker would guess — it must not double as a working password.
    const reference = '@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/gate-password)';
    config.accessGatePassword = reference;
    gateOn(t);

    await withServer(async (call) => {
      const res = await post(call, { password: reference });
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await res.json(), { error: 'Gate misconfigured' });
    });
  });

  await t.test('404 when ACCESS_GATE is false and no password is configured', async (t) => {
    config.accessGatePassword = '';
    t.mock.method(configRepository, 'getPublic', async () => (
      { id: 'public', ENVIRONMENT: 'test', ACCESS_GATE: false }
    ));

    await withServer(async (call) => {
      const res = await post(call, { password: PASSWORD });
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { message: 'Not Found' });
    });
  });

  await t.test('404 when ACCESS_GATE is false, even with the right password', async (t) => {
    // eagle-api owns the flag. A password left in app settings after the curtain is lifted must
    // not keep a gate answering that the site does not show.
    t.mock.method(configRepository, 'getPublic', async () => ({
      id: 'public', ENVIRONMENT: 'test', ACCESS_GATE: false
    }));

    await withServer(async (call) => {
      const res = await post(call, { password: PASSWORD });
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { message: 'Not Found' });
    });
  });

  await t.test('503 and no-store when the public config cannot be read', async (t) => {
    // Both failures, and neither may be a 404: "I do not know whether the curtain is drawn" is not
    // "this environment runs no curtain". Same stance GET /config/public takes, same reason.
    for (const [label, getPublic] of [
      ['unseeded', async () => null],
      ['unreachable', async () => { throw new Error('private endpoint down'); }]
    ]) {
      const mocked = t.mock.method(configRepository, 'getPublic', getPublic);

      await withServer(async (call) => {
        const res = await post(call, { password: PASSWORD });
        assert.equal(res.status, 503, label);
        assert.equal(res.headers.get('cache-control'), 'no-store', label);
        assert.deepEqual(await res.json(), { error: 'Public configuration is unavailable.' }, label);
      });

      mocked.mock.restore();
    }
  });

  await t.test('no answer ever carries the password', async (t) => {
    gateOn(t);
    await withServer(async (call) => {
      for (const body of [{ password: PASSWORD }, { password: 'wrong' }]) {
        const res = await post(call, body);
        const text = await res.text();
        assert.ok(!text.includes(PASSWORD), `the password came back in a ${res.status} body`);
      }
    });
  });
});

test('the gate route is deliberately unguarded', () => {
  const route = routeChains().find(r => r.method === 'post' && r.path === '/gate');
  assert.ok(route, 'POST /gate is not in the route table');
  // The caller is a visitor holding nothing, so any guard here locks out the only traffic this
  // route has. The source is read with comments stripped.
  assert.equal(route.chain.trim(), '',
    'the curtain must carry no guards: the password in the body is the whole credential');
});

test('the curtain password is read from config, never from the public payload', () => {
  const configController = require('../../src/controllers/config');
  // Serving it would put the password in a bundle: eagle-public boots on this payload.
  assert.ok(!configController.PUBLIC_KEYS.includes('ACCESS_GATE_PASSWORD'),
    'the password must never be in PUBLIC_KEYS — GET /config/public is unauthenticated');
  assert.ok(configController.PUBLIC_KEYS.includes('ACCESS_GATE'),
    'the boolean is the only part of the curtain a browser is told about');
});
