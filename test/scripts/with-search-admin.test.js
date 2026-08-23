'use strict';

/**
 * The revoke in `scripts/with-search-admin.sh` is the whole reason that script exists.
 *
 * Three index changes have each granted Search Service Contributor by hand, done the work, and
 * revoked by hand. The failure that costs something is not the typing — it is a grant left standing
 * because the middle step errored, leaving the identity the PUBLIC API runs as holding the ability
 * to delete an index. So none of these cases test the happy path on its own. Each one kills the run
 * a different way — a failing command, SIGTERM, a revoke that itself fails — and asserts the grant
 * came back off, or that the operator was told loudly enough to remove it by hand.
 *
 * `AZ` stands in for the `az` CLI, the same seam `PULL_SSH_CMD` gives `pull-from-container.sh`. The
 * fake logs every invocation, so "did it revoke" is measured off the log rather than asserted from
 * the script's own output.
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'with-search-admin.sh');

const ASSIGNMENT_ID = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Search/' +
  'searchServices/svc/providers/Microsoft.Authorization/roleAssignments/fake-id';

/**
 * Stands in for `az`: logs its whole argv, answers the three calls the script makes, and fails the
 * delete when $AZ_DELETE_FAILS is set.
 */
const FAKE_AZ = `#!/usr/bin/env bash
echo "$*" >> "\${AZ_LOG}"
case "$1 $2" in
  "identity show")           echo "fake-principal-id" ;;
  "role assignment")
    case "$3" in
      create) [[ -n "\${AZ_CREATE_EMPTY:-}" ]] || echo "${ASSIGNMENT_ID}" ;;
      list)   echo "${ASSIGNMENT_ID}" ;;
      delete) [[ -n "\${AZ_DELETE_FAILS:-}" ]] && exit 1 ;;
    esac ;;
esac
exit 0
`;

/** Run the script with the fake az, returning {status, stdout, stderr, calls}. */
function run(args, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsa-'));
  const az = path.join(dir, 'az');
  const log = path.join(dir, 'az.log');
  fs.writeFileSync(az, FAKE_AZ, { mode: 0o755 });
  fs.writeFileSync(log, '');

  const res = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, AZ: az, AZ_LOG: log, ...(opts.env || {}) }
  });

  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...res, calls };
}

const deletes = (calls) => calls.filter(c => c.startsWith('role assignment delete'));
const creates = (calls) => calls.filter(c => c.startsWith('role assignment create'));

test('with-search-admin.sh', async (t) => {
  await t.test('revokes after the command SUCCEEDS', async () => {
    const r = run(['--', 'true']);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(creates(r.calls).length, 1);
    assert.strictEqual(deletes(r.calls).length, 1, 'the grant must not outlive a successful run');
  });

  await t.test('revokes when the command FAILS, and preserves its exit code', async () => {
    // The case a plain create/work/delete sequence gets wrong: the middle step dies, the delete
    // never runs, and the public API keeps index-definition rights until somebody notices.
    const r = run(['--', 'bash', '-c', 'exit 3']);
    assert.strictEqual(r.status, 3, "the caller's exit status must survive the trap");
    assert.strictEqual(deletes(r.calls).length, 1, 'a failed command must still revoke');
  });

  await t.test('revokes when the SCRIPT ITSELF is signalled', async () => {
    // A Ctrl-C or a dropped tunnel signals the SCRIPT, not the command it is running, and that is
    // a different code path from a non-zero exit — killing the inner command would only re-test the
    // case above, since the script would then see an ordinary failure.
    //
    // This does NOT distinguish `trap revoke EXIT` from `trap revoke EXIT INT TERM`, and it should
    // not pretend to: measured on bash 5.2.15, the EXIT trap runs on SIGTERM and SIGINT anyway. It
    // catches the mutation that matters — no trap at all — on the signal path specifically.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsa-sig-'));
    const az = path.join(dir, 'az');
    const log = path.join(dir, 'az.log');
    const started = path.join(dir, 'started');
    fs.writeFileSync(az, FAKE_AZ, { mode: 0o755 });
    fs.writeFileSync(log, '');

    // `stdio: 'ignore'`, and a short sleep. The grandchild inherits the spawn's pipes, so with
    // pipes and `sleep 30` the test process stayed alive for the full 30s AFTER the assertions
    // passed — 22s added to a 9.5s gate that runs before every commit.
    const child = spawn('bash', [SCRIPT, '--', 'bash', '-c', `touch ${started}; sleep 5`], {
      stdio: 'ignore',
      env: { ...process.env, AZ: az, AZ_LOG: log }
    });

    // Signal only once the command is actually running — before that there is no grant to leak,
    // so an early kill would pass whatever the trap does.
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(started) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(fs.existsSync(started), 'the inner command never started');

    child.kill('SIGTERM');
    await new Promise(resolve => child.on('exit', resolve));

    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
    fs.rmSync(dir, { recursive: true, force: true });
    assert.strictEqual(deletes(calls).length, 1, 'a signalled SCRIPT must still revoke');
  });

  await t.test('a FAILED revoke is reported loudly, not swallowed', async () => {
    // Nothing can force the revoke through, so the only useful behaviour is to print the exact
    // command to run by hand — silently succeeding here is how a grant survives unnoticed.
    const r = run(['--', 'true'], { env: { AZ_DELETE_FAILS: '1' } });
    assert.match(r.stderr, /REVOKE FAILED/);
    assert.match(r.stderr, /az role assignment delete --ids/,
      'the message has to carry the id, or the operator cannot act on it');
    assert.ok(r.stderr.includes(ASSIGNMENT_ID), 'and the id itself, not a placeholder');
  });

  await t.test('a create that returns NO id stops, and does not run the command', async () => {
    // The trap keys on a non-empty ASSIGNMENT_ID, so an empty one made the revoke a silent no-op:
    // the command ran, the script exited 0, and zero delete calls were made. Reproduced before the
    // fix. The grant may exist server-side even when the CLI returns nothing, so "no id" has to
    // mean "stop and tell the operator", never "nothing to revoke".
    const r = run(['--', 'bash', '-c', 'echo COMMAND-RAN'], { env: { AZ_CREATE_EMPTY: '1' } });
    assert.notStrictEqual(r.status, 0, 'a grant that cannot be confirmed must not proceed');
    assert.ok(!/COMMAND-RAN/.test(r.stdout), 'the command must not run without a confirmed grant');
    assert.match(r.stderr, /no assignment id/);
    assert.match(r.stderr, /az role assignment list --scope/,
      'and it must hand over the query to find a grant that may be standing');
  });

  await t.test('resolves the identity in the SAME subscription it grants on', async () => {
    // Without --subscription the identity is looked up in whatever az defaults to, while the scope
    // names SUBSCRIPTION — best case a confusing ResourceGroupNotFound, worst case a same-named
    // identity in another subscription becomes the principal that gets granted.
    const r = run(['--', 'true'], { env: { SUBSCRIPTION: 'sub-x' } });
    const lookup = r.calls.find(c => c.startsWith('identity show'));
    assert.match(lookup, /--subscription sub-x/);
  });

  await t.test('does not grant at all when given no command', async () => {
    // Exit before the create, not after — otherwise a typo leaves a grant standing for nothing.
    const r = run([]);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /usage:/);
    assert.strictEqual(creates(r.calls).length, 0, 'nothing was asked for, so nothing is granted');
  });

  await t.test('grants at the SERVICE scope, never the resource group', async () => {
    // A resource-group-scoped grant would cover every search service in the group and outlive the
    // reasoning in the header.
    const r = run(['--', 'true'], { env: { RG: 'rg-x', SERVICE: 'svc-x', SUBSCRIPTION: 'sub-x' } });
    const create = creates(r.calls)[0];
    assert.match(create, /--scope \/subscriptions\/sub-x\/resourceGroups\/rg-x\/providers\/Microsoft\.Search\/searchServices\/svc-x/);
    assert.match(create, /--role 7ca78c08-252a-4471-8644-bb5ff32d4ba0/, 'Search Service Contributor');
  });

  await t.test('the command runs only after the grant is readable', async () => {
    // The assignment is not visible the instant it is created, and a command that starts too early
    // 403s. Ordering is the assertion: create, then at least one list, then the command.
    const r = run(['--', 'true']);
    const kinds = r.calls.map(c => c.split(' ').slice(0, 3).join(' '));
    const created = kinds.indexOf('role assignment create');
    const listed = kinds.indexOf('role assignment list');
    assert.ok(created >= 0 && listed > created, 'the readiness poll must follow the create');
  });
});
