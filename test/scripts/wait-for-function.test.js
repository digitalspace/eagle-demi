'use strict';

/**
 * `scripts/wait-for-function.sh` runs against two subscriptions — prod's resource group lives in
 * one, test's in another — so an `az` call that leans on the CLI default fails with
 * ResourceGroupNotFound, which reads as "not registered yet" rather than "wrong subscription".
 *
 * A fake `az` on PATH logs its whole argv, so the flag is measured off the log rather than
 * asserted from the script's own output. It always reports the function as registered, keeping
 * every case off the 20-second poll path.
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'wait-for-function.sh');
const SUBSCRIPTION = 'be5924ac-1083-4a1b-be92-7b444882cfd9';

const FAKE_AZ = `#!/usr/bin/env bash
echo "$*" >> "\${AZ_LOG}"
echo api
`;

/** Run the script with the fake az first on PATH, returning {status, stdout, stderr, calls}. */
function run(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wff-'));
  const log = path.join(dir, 'az.log');
  fs.writeFileSync(path.join(dir, 'az'), FAKE_AZ, { mode: 0o755 });
  fs.writeFileSync(log, '');

  const res = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, AZ_LOG: log }
  });

  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...res, calls };
}

test('wait-for-function.sh', async (t) => {
  await t.test('passes the subscription argument through to az', () => {
    const r = run(['rg-demi-prod', 'demi-api-fc-prod', 'api', SUBSCRIPTION]);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.calls.length, 1);
    assert.match(r.calls[0], new RegExp(`--subscription ${SUBSCRIPTION}(\\s|$)`));
  });

  await t.test('omits --subscription when none is given', () => {
    // CI logs in with a subscription already selected; an empty `--subscription ""` would abort it.
    const r = run(['c4b0a8-test-rg', 'demi-api-fc-test', 'api']);
    assert.strictEqual(r.status, 0);
    assert.doesNotMatch(r.calls[0], /--subscription/);
  });

  await t.test('rejects a fifth argument instead of silently dropping it', () => {
    const r = run(['rg', 'app', 'fn', SUBSCRIPTION, 'extra']);
    assert.strictEqual(r.status, 1);
    assert.strictEqual(r.calls.length, 0);
  });
});
