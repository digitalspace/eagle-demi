'use strict';

/**
 * The edge ban timer, registered against a recording `app` (test/helpers/load-index.js). Unlike the
 * other timers it registers on EDGE_BAN_MODE, so an `off` environment still runs a tick that logs
 * the skip, and its schedule defaults to hourly.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');

const { logger } = require('../src/utils/logger');
const { loadIndex } = require('./helpers/load-index');

const SCRIPT = path.join(__dirname, '..', 'src', 'scripts', 'edge-ban.js');
const EDGE_VARS = [
  'EDGE_BAN_MODE', 'EDGE_BAN_SCHEDULE', 'EDGE_BAN_POLICY', 'EDGE_LOG_WORKSPACE_ID', 'EDGE_BAN_RULE_ID'
];
const POLICY = { minDocuments: 500, allow: ['198.51.100.7'] };

/** Set the edge settings for one test; anything not named is cleared. Restored after. */
function setEdgeEnv(t, values) {
  const saved = EDGE_VARS.map(v => [v, process.env[v]]);
  for (const v of EDGE_VARS) {
    if (values[v] === undefined) delete process.env[v];
    else process.env[v] = values[v];
  }
  t.after(() => {
    for (const [v, value] of saved) {
      if (value === undefined) delete process.env[v];
      else process.env[v] = value;
    }
  });
}

/**
 * Replace the detector with a recorder. The handler requires it lazily, and the module may not
 * exist on this checkout, so resolution is pointed at the cache entry as well.
 */
function stubScript(t, run) {
  const resolve = Module._resolveFilename;
  t.mock.method(Module, '_resolveFilename', function (request, ...rest) {
    return request === '../src/scripts/edge-ban' ? SCRIPT : resolve.call(this, request, ...rest);
  });
  const cached = require.cache[SCRIPT];
  require.cache[SCRIPT] = { id: SCRIPT, filename: SCRIPT, loaded: true, exports: { run } };
  t.after(() => {
    if (cached) require.cache[SCRIPT] = cached;
    else delete require.cache[SCRIPT];
  });
}

function recordLogs(t) {
  const logs = { info: [], error: [] };
  t.mock.method(logger, 'info', (message, meta) => { logs.info.push({ message, meta }); });
  t.mock.method(logger, 'error', (message, meta) => { logs.error.push({ message, meta }); });
  return logs;
}

test('no EDGE_BAN_MODE registers no timer, and leaves the API registered', (t) => {
  setEdgeEnv(t, {});
  const { registered } = loadIndex(t);

  assert.deepStrictEqual(registered.timers, []);
  assert.strictEqual(registered.https.length, 2);
});

test('EDGE_BAN_MODE with no schedule registers edgeBan hourly', (t) => {
  setEdgeEnv(t, { EDGE_BAN_MODE: 'off' });
  const { registered } = loadIndex(t);

  assert.strictEqual(registered.timers.length, 1);
  const [{ name, options }] = registered.timers;
  assert.strictEqual(name, 'edgeBan');
  assert.strictEqual(options.schedule, '0 0 * * * *');
  assert.strictEqual(options.runOnStartup, false);
});

test('EDGE_BAN_SCHEDULE overrides the hourly default', (t) => {
  setEdgeEnv(t, { EDGE_BAN_MODE: 'shadow', EDGE_BAN_SCHEDULE: '0 15 * * * *' });
  const { registered } = loadIndex(t);

  assert.strictEqual(registered.timers[0].options.schedule, '0 15 * * * *');
});

test('off mode logs one skip line and never loads the detector', async (t) => {
  setEdgeEnv(t, { EDGE_BAN_MODE: 'off', EDGE_BAN_POLICY: JSON.stringify(POLICY) });
  const { index } = loadIndex(t);
  let calls = 0;
  stubScript(t, async () => { calls++; });
  const logs = recordLogs(t);

  await index.edgeBan();

  assert.strictEqual(calls, 0);
  assert.strictEqual(logs.info.length, 1);
  assert.match(logs.info[0].message, /EDGE_BAN_MODE is off/);
  assert.deepStrictEqual(logs.error, []);
});

test('shadow mode runs the detector with the parsed policy and the edge ids, and logs the summary', async (t) => {
  setEdgeEnv(t, {
    EDGE_BAN_MODE: 'shadow',
    EDGE_BAN_POLICY: JSON.stringify(POLICY),
    EDGE_LOG_WORKSPACE_ID: 'workspace-under-test',
    EDGE_BAN_RULE_ID: 'rule-under-test'
  });
  const { index } = loadIndex(t);
  const calls = [];
  stubScript(t, async (opts) => {
    calls.push(opts);
    return {
      candidates: ['192.0.2.1', '192.0.2.2'], banned: ['192.0.2.1'], expired: [], written: false, warnings: ['w']
    };
  });
  const logs = recordLogs(t);

  await index.edgeBan();

  assert.strictEqual(calls.length, 1);
  const opts = calls[0];
  assert.strictEqual(opts.mode, 'shadow');
  assert.deepStrictEqual(opts.policy, POLICY);
  assert.strictEqual(opts.workspaceId, 'workspace-under-test');
  assert.strictEqual(opts.ruleId, 'rule-under-test');
  assert.strictEqual(opts.log, logger);
  assert.ok(opts.now instanceof Date);
  assert.strictEqual(typeof opts.credential.getToken, 'function');
  assert.strictEqual(opts.cosmos, require('../src/db/cosmos-nosql'));

  assert.deepStrictEqual(logs.error, []);
  assert.strictEqual(logs.info.length, 1);
  assert.strictEqual(logs.info[0].message, '[edge-ban] run finished');
  assert.deepStrictEqual(logs.info[0].meta,
    { mode: 'shadow', candidates: 2, banned: 1, expired: 0, written: false, warnings: ['w'] });
});

test('a thrown run is logged once and does not reject at the host', async (t) => {
  setEdgeEnv(t, { EDGE_BAN_MODE: 'write', EDGE_BAN_POLICY: JSON.stringify(POLICY) });
  const { index } = loadIndex(t);
  stubScript(t, async () => { throw new Error('rule PATCH 409'); });
  const logs = recordLogs(t);

  await assert.doesNotReject(() => index.edgeBan());

  assert.strictEqual(logs.error.length, 1);
  assert.strictEqual(logs.error[0].message, '[edge-ban] run failed');
  assert.strictEqual(logs.error[0].meta.error, 'rule PATCH 409');
  assert.ok(logs.error[0].meta.stack);
});

test('an unknown mode fails the tick, not the app, and never runs the detector', async (t) => {
  setEdgeEnv(t, { EDGE_BAN_MODE: 'block', EDGE_BAN_POLICY: JSON.stringify(POLICY) });
  const { index, registered } = loadIndex(t);
  let calls = 0;
  stubScript(t, async () => { calls++; });
  const logs = recordLogs(t);

  await index.edgeBan();

  assert.strictEqual(registered.https.length, 2);
  assert.strictEqual(calls, 0);
  assert.strictEqual(logs.error.length, 1);
  assert.match(logs.error[0].meta.error, /EDGE_BAN_MODE must be one of off, shadow, write, got 'block'/);
});

test('a policy that is not JSON is refused without quoting the value', async (t) => {
  setEdgeEnv(t, { EDGE_BAN_MODE: 'shadow', EDGE_BAN_POLICY: '{"minDocuments": 500, allow-marker' });
  const { index } = loadIndex(t);
  let calls = 0;
  stubScript(t, async () => { calls++; });
  const logs = recordLogs(t);

  await index.edgeBan();

  assert.strictEqual(calls, 0);
  assert.strictEqual(logs.error.length, 1);
  assert.strictEqual(logs.error[0].meta.error, 'EDGE_BAN_POLICY is not valid JSON.');
  assert.doesNotMatch(logs.error[0].meta.stack, /allow-marker/);
});

test('shadow mode with no resolved policy skips the run with an error line', async (t) => {
  setEdgeEnv(t, {
    EDGE_BAN_MODE: 'shadow',
    EDGE_BAN_POLICY: '@Microsoft.KeyVault(SecretUri=https://vault.example/secrets/edge-ban-policy)'
  });
  const { index } = loadIndex(t);
  let calls = 0;
  stubScript(t, async () => { calls++; });
  const logs = recordLogs(t);

  await index.edgeBan();

  assert.strictEqual(calls, 0);
  assert.strictEqual(logs.error.length, 1);
  assert.match(logs.error[0].message, /EDGE_BAN_POLICY is unset/);
});
