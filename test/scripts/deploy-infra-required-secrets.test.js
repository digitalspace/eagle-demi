'use strict';

/**
 * `require_secrets` in `scripts/deploy-infra.sh` exists to turn a missing credential into a message
 * and exit 3, because the deployment behind it is a whole-collection appSettings PUT with no
 * rollback. The message is the feature. A guard that aborts without naming what is missing sends the
 * operator back to the comments in the script.
 *
 * The case these tests pin is the one where the guard used to abort the wrong way. Two of the values
 * it demands, APIM_SHARED_HEADER_VALUE and AUDIT_SHARED_HEADER_VALUE, live in GitHub environment
 * secrets and nowhere else — the script never assigns them, so on any run where the operator forgot
 * to export them the name is not merely empty but UNSET. Read as `${!name}` under `set -u` that
 * killed the script with `APIM_SHARED_HEADER_VALUE: unbound variable` and exit 1, before either the
 * per-name line or the where-to-find-it block could print.
 *
 * `oc` is faked to return nothing, which is also what a real run against a cluster the caller cannot
 * reach does. That makes every OpenShift-sourced value empty too, so these runs always end at exit
 * 3 — what is asserted is HOW they get there and what they say on the way. Nothing here reaches
 * Azure: `require_secrets` runs before `run_deployment` and exits first.
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'deploy-infra.sh');

// Stands in for `oc`: prints nothing and succeeds, so `os_secret` yields an empty value the same way
// an unreadable secret does. Exiting non-zero would test the `|| true` path instead of this one.
const FAKE_OC = '#!/usr/bin/env bash\nexit 0\n';

/**
 * Run the script at `test --what-if` with a fake `oc`, with `names` removed from the environment.
 * Returns {status, stdout, stderr}.
 */
function run({ unset = [], env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-infra-'));
  fs.writeFileSync(path.join(dir, 'oc'), FAKE_OC, { mode: 0o755 });

  const childEnv = { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...env };
  for (const name of unset) delete childEnv[name];

  try {
    return spawnSync('bash', [SCRIPT, 'test', '--what-if'], {
      encoding: 'utf8',
      timeout: 60000,
      env: childEnv
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const APIM = 'APIM_SHARED_HEADER_VALUE';
const AUDIT = 'AUDIT_SHARED_HEADER_VALUE';
const DEVBOX = 'DEVBOX_SSH_PUBLIC_KEY';

test('deploy-infra.sh require_secrets', async (t) => {
  await t.test('names an UNSET secret instead of dying on it', async () => {
    const r = run({ unset: [APIM, AUDIT, DEVBOX] });

    // The regression, stated as the thing that must not appear. Under `${!name}` this run exits 1
    // here and every assertion below it fails.
    assert.doesNotMatch(
      r.stderr,
      /unbound variable/,
      'an unset name must be reported, not abort the shell'
    );
    assert.strictEqual(r.status, 3, 'a missing credential is exit 3, the documented refusal');
    for (const name of [APIM, AUDIT, DEVBOX]) {
      assert.match(r.stderr, new RegExp(`${name} is empty`), `${name} must be named`);
    }
  });

  await t.test('tells the operator the APIM headers are not in OpenShift', async () => {
    // Every other value in the refusal block carries the OpenShift secret it comes from. These two
    // do not come from OpenShift at all, so without their own line the message points at a cluster
    // that will never hold them.
    const r = run({ unset: [APIM, AUDIT] });

    assert.strictEqual(r.status, 3);
    assert.match(r.stderr, new RegExp(`${APIM} / ${AUDIT}`), 'both names must appear in the refusal');
    assert.match(r.stderr, /NOT in OpenShift/, 'the message must say where they are not');
    assert.match(r.stderr, /GitHub environment secrets/, 'and where they are');
  });

  await t.test('still judges an EXPORTED value on its content', async () => {
    // Reading an unset name as empty must not become reading every name as empty. A single space is
    // the value that destroyed two live credentials on 2026-08-13 by passing a `[ -z ]` check.
    const r = run({
      env: { [APIM]: 'abcdefghijk', [AUDIT]: ' ', [DEVBOX]: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI0 demo' }
    });

    assert.match(r.stdout, new RegExp(`${APIM}`), 'a good value passes and is reported');
    assert.match(r.stderr, new RegExp(`${AUDIT} is empty`), 'a whitespace-only value is still empty');
    assert.strictEqual(r.status, 3);
  });
});
