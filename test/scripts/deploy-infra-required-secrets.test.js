'use strict';

/**
 * appSettings is a whole-collection PUT: a name missing from the vault deploys as an empty credential
 * with no error, so the script refuses first and each refusal names what is missing.
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'deploy-infra.sh');

// `STUB_VAULT_NAMES` is what the vault lists from the devbox; an empty `STUB_DEVBOX_RG` means no VM.
// Every other call, the what-if included, succeeds silently.
const FAKE_AZ = `#!/usr/bin/env bash
case "$1 $2" in
  'resource list') printf '%s\\n' "\${STUB_DEVBOX_RG-}" ;;
  'vm run-command') printf '%s\\n' "\${STUB_VAULT_NAMES-}" ;;
  'deployment group') echo 'stub what-if: no changes' ;;
esac
exit 0
`;

// Stands in for `oc`: prints nothing and succeeds, so the devbox key comes back empty the same way
// an unreadable secret does. Exiting non-zero would exercise the `|| true` path instead of this one.
const FAKE_OC = '#!/usr/bin/env bash\nexit 0\n';

// key-vault.bicep `requiredSecretNames` plus main.test.bicepparam `optionalSecretNames`, written out:
// a list parsed from the script's own source would agree with it when both are wrong.
const VAULT_NAMES = [
  'admin-api-key',
  'track-client-secret',
  'role-sync-client-secret',
  'docling-api-key',
  'minio-access-key',
  'minio-secret-key',
  'analytics-shared-header',
  'analytics-audit-header',
  'notify-api-key',
  'edge-secret',
  'access-gate-password',
  'openshift-token-test',
  'dev-openshift-token',
  'pdf-title-worker-api-key',
  'eagle-sync-out-client-secret',
  'edge-ban-policy'
];

const GOOD_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI0 demo';

/**
 * Run the script at `test --what-if` with stubbed `az` and `oc`.
 * `vaultNames` is what the vault reports holding; `devboxRg` empty means no devbox.
 */
function run({ vaultNames = VAULT_NAMES, devboxRg = 'c4b0a8-test-rg', env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-infra-'));
  fs.writeFileSync(path.join(dir, 'az'), FAKE_AZ, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'oc'), FAKE_OC, { mode: 0o755 });

  // The inherited environment is stripped of the key first: a value exported in the shell that runs
  // the suite would otherwise decide what these runs see.
  const childEnv = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    STUB_VAULT_NAMES: vaultNames.join('\n'),
    STUB_DEVBOX_RG: devboxRg
  };
  delete childEnv.DEVBOX_SSH_PUBLIC_KEY;
  Object.assign(childEnv, env);

  try {
    return spawnSync('bash', [SCRIPT, 'test', '--what-if'], {
      encoding: 'utf8',
      timeout: 15000,
      env: childEnv
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const without = (name) => VAULT_NAMES.filter((n) => n !== name);

test('deploy-infra.sh vault check', async (t) => {
  await t.test('refuses, and names the secret, when the vault is missing a required one', async () => {
    const r = run({ vaultNames: without('admin-api-key'), env: { DEVBOX_SSH_PUBLIC_KEY: GOOD_KEY } });

    assert.strictEqual(r.status, 3, 'a missing secret name is exit 3, the documented refusal');
    assert.match(r.stderr, /admin-api-key is not in demi-kv-test/,
      'the missing name must be printed — ADMIN_API_KEY would otherwise deploy unresolved');
    assert.match(r.stderr, /az keyvault secret set/,
      'and the command that fixes it, run from the devbox');
    assert.doesNotMatch(r.stdout, /what-if/,
      'the refusal must come BEFORE the deployment, not after it');
  });

  await t.test('checks the optional names the param file adds, not only the required list', async () => {
    // openshift-token-test is named in azure/main.test.bicepparam alone. Read the required list only
    // and this run deploys a secret sync with no token, which fails at runtime and not at deploy.
    const r = run({ vaultNames: without('openshift-token-test'), env: { DEVBOX_SSH_PUBLIC_KEY: GOOD_KEY } });

    assert.strictEqual(r.status, 3);
    assert.match(r.stderr, /openshift-token-test is not in demi-kv-test/,
      "the environment's own optional names must be checked too");
  });

  await t.test('says the read failed, not that every secret is missing, on ForbiddenByConnection', async () => {
    // A caller outside the VNet gets this text, not an empty list; reporting it as missing secrets
    // would send the operator to re-set every value that is still there.
    const r = run({
      vaultNames: ['ERROR: (ForbiddenByConnection) Client address is not authorized and caller is not a trusted service.'],
      env: { DEVBOX_SSH_PUBLIC_KEY: GOOD_KEY }
    });

    assert.strictEqual(r.status, 1, 'a failed read is a distinct exit code from a missing-name refusal');
    assert.match(r.stderr, /reading demi-kv-test from demi-devbox-test failed/,
      'the message must name the read that failed, not the secrets');
    assert.match(r.stderr, /ForbiddenByConnection/, 'and quote the line that shows why');
    assert.match(r.stderr, /VNet/, 'and repeat that the read has to run inside it');
    for (const name of VAULT_NAMES) {
      assert.doesNotMatch(r.stderr, new RegExp(`${name} is not in`),
        `${name} must not be reported missing when the read itself failed`);
    }
  });

  await t.test('says where the check has to run when the devbox is not there', async () => {
    // The vault denies public network access, so the check can only run from the devbox; without it
    // the run must say so rather than report an empty vault.
    const r = run({ devboxRg: '', env: { DEVBOX_SSH_PUBLIC_KEY: GOOD_KEY } });

    assert.strictEqual(r.status, 3);
    assert.match(r.stderr, /demi-devbox-test not found/, 'the refusal must name the VM it looked for');
    assert.match(r.stderr, /public network access/, 'and say why the check cannot run from here');
    assert.doesNotMatch(r.stderr, /is not in demi-kv-test/,
      'an unreachable vault must not be reported as an empty one');
  });
});

test('deploy-infra.sh devbox key check', async (t) => {
  await t.test('names an UNSET key instead of dying on it', async () => {
    const r = run();

    // The regression, stated as the thing that must not appear: read without a `:-` default under
    // `set -u`, an unset name kills the script with exit 1 before any message is printed.
    assert.doesNotMatch(r.stderr, /unbound variable/,
      'an unset name must be reported, not abort the shell');
    assert.strictEqual(r.status, 3, 'a missing parameter is exit 3, the documented refusal');
    assert.match(r.stderr, /DEVBOX_SSH_PUBLIC_KEY is empty/, 'the name must be printed');
    assert.match(r.stderr, /demi-app-secrets/, 'and the OpenShift secret it comes from');
  });

  await t.test('reads a whitespace-only value as empty', async () => {
    // A single space passes a `[ -z ]` check and deploys, wiping live credentials.
    const r = run({ env: { DEVBOX_SSH_PUBLIC_KEY: ' ' } });

    assert.strictEqual(r.status, 3);
    assert.match(r.stderr, /DEVBOX_SSH_PUBLIC_KEY is empty/, 'a whitespace-only value is still empty');
    assert.doesNotMatch(r.stdout, /what-if/, 'and nothing is deployed with it');
  });

  await t.test('refuses a value that is not an OpenSSH public key', async () => {
    // A private key, a path, or a mangled value all pass a length floor and all fail at ARM, mid
    // apply, after the rest of the template has been written.
    const r = run({ env: { DEVBOX_SSH_PUBLIC_KEY: '/home/demi/.ssh/id_ed25519' } });

    assert.strictEqual(r.status, 3);
    assert.match(r.stderr, /not an OpenSSH public key/, 'the shape must be judged, not just the length');
  });

  await t.test('deploys when the vault is complete and the key is well formed', async () => {
    const r = run({ env: { DEVBOX_SSH_PUBLIC_KEY: GOOD_KEY } });

    assert.strictEqual(r.status, 0, 'both guards pass, so the what-if runs and the script exits 0');
    assert.match(r.stdout, /what-if/, 'the deployment step must actually be reached');
    assert.match(r.stdout, /admin-api-key/, 'and each name the vault holds is reported as found');
  });
});
