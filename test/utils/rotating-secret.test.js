'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const azureCredential = require('../../src/utils/azure-credential');
const config = require('../../src/config');
const { logger } = require('../../src/utils/logger');
const { ready, acceptedValues } = require('../../src/utils/rotating-secret');
const { freshUri, fakeVault } = require('../helpers/fake-vault');

const OLD = 'old-edge-value-from-app-setting';
const NEW = 'new-edge-value-from-vault';
const TTL_MS = 5 * 60_000;

/** Lets a background vault read against an answered stub finish, with room for added async steps. */
async function settle() {
  for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setImmediate(resolve));
}

/** EDGE_SECRET=env and a vault URI no other case touched. */
function edgeSetting(t, env) {
  const saved = { edgeSecret: config.edgeSecret, edgeSecretUri: config.edgeSecretUri };
  const uri = freshUri();
  Object.assign(config, { edgeSecret: env, edgeSecretUri: uri });
  t.after(() => Object.assign(config, saved));
  return uri;
}

function stubVault(t, fetchImpl, getToken = async () => 'fake-vault-token') {
  t.mock.method(azureCredential, 'getToken', getToken);
  t.mock.method(globalThis, 'fetch', fetchImpl);
}

/** Let one TTL pass and run the background refresh a request then starts. */
async function refreshAfterTtl(t) {
  t.mock.timers.tick(TTL_MS);
  acceptedValues('EDGE_SECRET');
  await settle();
}

function recordLogs(t) {
  const calls = [];
  for (const level of ['error', 'warn', 'info', 'debug']) {
    t.mock.method(logger, level, (...args) => { calls.push(args); });
  }
  return calls;
}

test('after a successful vault read, env-only O is rejected once the vault no longer holds it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const uri = edgeSetting(t, OLD);
  const vault = { [uri]: NEW, [`${uri}-standby`]: OLD };
  fakeVault(t, vault);
  await ready();
  assert.ok(acceptedValues('EDGE_SECRET').includes(OLD), 'mid-rotation the standby still holds O');

  vault[`${uri}-standby`] = NEW;
  await refreshAfterTtl(t);
  await refreshAfterTtl(t);

  assert.deepStrictEqual(acceptedValues('EDGE_SECRET'), [NEW]);
});

test('refresh in the {O,O} promote gap, then a stamper sends N within 5 min: N still accepted', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const uri = edgeSetting(t, OLD);
  const vault = { [uri]: OLD, [`${uri}-standby`]: NEW };
  fakeVault(t, vault);
  await ready();

  // standby := O is written, name := N is not yet.
  vault[`${uri}-standby`] = OLD;
  await refreshAfterTtl(t);

  assert.ok(acceptedValues('EDGE_SECRET').includes(NEW));
});

// The vault serves concurrent GETs in any order. Here the standby GET is answered first, then the
// rotator promotes (standby := O, name := N), then the name GET is answered.
test('a promote between the two reads never drops the value the stampers still send', async (t) => {
  const uri = edgeSetting(t, OLD);
  const vault = { [uri]: OLD, [`${uri}-standby`]: NEW };
  const answer = (key) => Response.json({ value: vault[key] });
  stubVault(t, async (url) => {
    const key = String(url).split('?')[0];
    if (key === uri) return new Promise(resolve => setImmediate(() => resolve(answer(key))));
    const res = answer(key);
    Object.assign(vault, { [`${uri}-standby`]: OLD, [uri]: NEW });
    return res;
  });

  await ready();

  assert.ok(acceptedValues('EDGE_SECRET').includes(OLD));
});

const BOOT_FAILURES = {
  'the vault answers 500': [async () => new Response('', { status: 500 })],
  'the token call rejects': [async () => Response.json({ value: NEW }), async () => { throw new Error('no identity'); }],
  'the secret itself is a 404': [async () => Response.json({ error: { code: 'SecretNotFound' } }, { status: 404 })]
};

for (const [failure, stubs] of Object.entries(BOOT_FAILURES)) {
  test(`vault fails at boot: env value accepted (${failure})`, async (t) => {
    edgeSetting(t, OLD);
    stubVault(t, ...stubs);

    await ready();

    assert.deepStrictEqual(acceptedValues('EDGE_SECRET'), [OLD]);
  });
}

test('a read that fails after a success keeps the last good set', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const uri = edgeSetting(t, OLD);
  const fetchMock = fakeVault(t, { [uri]: NEW });
  await ready();

  fetchMock.mock.mockImplementation(async () => new Response('', { status: 503 }));
  await refreshAfterTtl(t);

  assert.deepStrictEqual(acceptedValues('EDGE_SECRET'), [NEW]);
});

test('ready() timeout at 3 s does not block the request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  edgeSetting(t, OLD);
  stubVault(t, () => new Promise(() => {}));

  const waiting = ready().then(() => 'ready');
  const outcome = () => Promise.race([waiting, settle().then(() => 'blocked')]);

  t.mock.timers.tick(2999);
  assert.strictEqual(await outcome(), 'blocked');
  t.mock.timers.tick(1);
  assert.strictEqual(await outcome(), 'ready');
  assert.deepStrictEqual(acceptedValues('EDGE_SECRET'), [OLD]);
});

test('a hung token call fails the read at 10 s and a later read still lands', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const calls = recordLogs(t);
  const uri = edgeSetting(t, OLD);
  fakeVault(t, { [uri]: NEW });
  const token = t.mock.method(azureCredential, 'getToken', () => new Promise(() => {}));
  ready();

  t.mock.timers.tick(10_000);
  await settle();
  assert.strictEqual(calls.length, 1, 'the hung read is logged as failed');

  token.mock.mockImplementation(async () => 'fake-vault-token');
  await refreshAfterTtl(t);

  assert.deepStrictEqual(acceptedValues('EDGE_SECRET'), [NEW]);
});

test('no secret value in any logger call', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const calls = recordLogs(t);
  const uri = edgeSetting(t, OLD);
  const fetchMock = fakeVault(t, { [uri]: NEW, [`${uri}-standby`]: OLD });
  await ready();

  // A body that is not JSON: the parser's message quotes its first characters.
  fetchMock.mock.mockImplementation(async () => new Response(NEW, { status: 200 }));
  await refreshAfterTtl(t);

  assert.ok(calls.length > 0, 'the failed read is logged');
  const logged = JSON.stringify(calls);
  assert.ok(!logged.includes(NEW.slice(0, 8)), 'no part of the vault value');
  assert.ok(!logged.includes(OLD.slice(0, 8)), 'no part of the standby value');
});
