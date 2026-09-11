'use strict';

/**
 * `src/scripts/probe-acl.js` is an operator script that only talks to a remote API over HTTP, so it
 * must run from a shell that has ENVIRONMENT exported — which is the natural state while probing
 * test. Reading ADMIN_API_KEY through src/config.js applied the server's DEMI_ALLOWED_CLIENTS boot
 * guard to it and killed the probe with an unrelated error before it ran.
 *
 * A child process, and no key: the script exits on its own guard before any request, so this case
 * proves the decoupling without reaching the network.
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'src', 'scripts', 'probe-acl.js');

function run(vars) {
  const env = { ...process.env };
  // Whatever the runner's shell holds must not decide the case.
  delete env.ADMIN_API_KEY;
  Object.assign(env, vars);
  const res = spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 60000, env
  });
  return { status: res.status, output: `${res.stdout}${res.stderr}` };
}

test('the probe runs from a shell with ENVIRONMENT exported', () => {
  const { status, output } = run({ ENVIRONMENT: 'test', DEMI_ALLOWED_CLIENTS: '' });
  assert.ok(!/DEMI_ALLOWED_CLIENTS/.test(output),
    `the server boot guard must not reach this script; got:\n${output}`);
  assert.match(output, /ADMIN_API_KEY is not set/);
  assert.strictEqual(status, 2, 'a missing key aborts with 2');
});

test('an unresolved Key Vault reference is treated as no key', () => {
  // Sending the reference text would read back as a 401 and be reported as a broken ACL.
  const { status, output } = run({
    ADMIN_API_KEY: '@Microsoft.KeyVault(SecretUri=https://x.vault.azure.net/secrets/y)'
  });
  assert.match(output, /ADMIN_API_KEY is not set/);
  assert.strictEqual(status, 2);
});
