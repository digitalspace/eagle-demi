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

/** Lets a background vault read that only awaits settled promises finish. */
const settle = () => new Promise(resolve => setImmediate(resolve));

/** EDGE_SECRET=env and a vault URI no other case touched. */
function edgeSetting(t, env) {
  const saved = { edgeSecret: config.edgeSecret, edgeSecretUri: config.edgeSecretUri };
  const uri = freshUri();
  Object.assign(config, { edgeSecret: env, edgeSecretUri: uri });
  t.after(() => Object.assign(config, saved));
  return uri;
}

function vaultDown(t, fetchImpl) {
  t.mock.method(azureCredential, 'getToken', async () => 'fake-vault-token');
  t.mock.method(globalThis, 'fetch', fetchImpl);
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
  t.mock.timers.tick(TTL_MS);
  acceptedValues('EDGE_SECRET');
  await settle();

  assert.deepStrictEqual(acceptedValues('EDGE_SECRET'), [NEW, NEW]);
});

test('vault fails at boot: env value accepted', async (t) => {
  edgeSetting(t, OLD);
  vaultDown(t, async () => new Response('', { status: 500 }));

  await ready();

  assert.deepStrictEqual(acceptedValues('EDGE_SECRET'), [OLD]);
});

test('a read that fails after a success keeps the last good set', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const uri = edgeSetting(t, OLD);
  const fetchMock = fakeVault(t, { [uri]: NEW });
  await ready();

  fetchMock.mock.mockImplementation(async () => new Response('', { status: 503 }));
  t.mock.timers.tick(TTL_MS);
  acceptedValues('EDGE_SECRET');
  await settle();

  assert.deepStrictEqual(acceptedValues('EDGE_SECRET'), [NEW]);
});

test('ready() timeout at 3 s does not block the request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  edgeSetting(t, OLD);
  vaultDown(t, () => new Promise(() => {}));

  const waiting = ready().then(() => 'ready');
  const outcome = () => Promise.race([waiting, settle().then(() => 'blocked')]);

  t.mock.timers.tick(2999);
  assert.strictEqual(await outcome(), 'blocked');
  t.mock.timers.tick(1);
  assert.strictEqual(await outcome(), 'ready');
  assert.deepStrictEqual(acceptedValues('EDGE_SECRET'), [OLD]);
});

test('no secret value in any logger call', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const calls = recordLogs(t);
  const uri = edgeSetting(t, OLD);
  const fetchMock = fakeVault(t, { [uri]: NEW, [`${uri}-standby`]: OLD });
  await ready();

  // A body that is not JSON: the parser's message quotes its first characters.
  fetchMock.mock.mockImplementation(async () => new Response(NEW, { status: 200 }));
  t.mock.timers.tick(TTL_MS);
  acceptedValues('EDGE_SECRET');
  await settle();

  assert.ok(calls.length > 0, 'the failed read is logged');
  const logged = JSON.stringify(calls);
  assert.ok(!logged.includes(NEW.slice(0, 8)), 'no part of the vault value');
  assert.ok(!logged.includes(OLD.slice(0, 8)), 'no part of the standby value');
});
