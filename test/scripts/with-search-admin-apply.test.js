'use strict';

/**
 * The `apply` mode of `scripts/with-search-admin.sh` — the same grant and revoke as the devbox
 * flow, but the work happens in the Function app instead of on the VM.
 *
 * What these tests are for is the window, not the HTTP. The identity the INTERNET-FACING API runs
 * as holds Search Service Contributor for as long as the apply takes, so the two things that must
 * hold are that the grant is in place before the POST (or the app 403s), and that it comes back off
 * on every way out — a finished job, a failed job, a job that never answers. A revoke that only
 * runs on the happy path leaves the public API able to delete an index.
 *
 * `AZ` and `CURL` are both seams. They log into the same file, so "granted before the POST" and
 * "revoked after the last poll" are read off one ordered transcript rather than asserted from the
 * script's own output.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'with-search-admin.sh');

const ASSIGNMENT_ID = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Search/' +
  'searchServices/svc/providers/Microsoft.Authorization/roleAssignments/fake-id';

const API_KEY = 'super-secret-key-value';

const FAKE_AZ = `#!/usr/bin/env bash
echo "az $*" >> "\${CALL_LOG}"
case "$1 $2" in
  "identity show")           echo "fake-principal-id" ;;
  "role assignment")
    case "$3" in
      create) echo "${ASSIGNMENT_ID}" ;;
      list)   [[ -n "\${AZ_LIST_EMPTY:-}" ]] || echo "${ASSIGNMENT_ID}" ;;
      delete) [[ -n "\${AZ_DELETE_FAILS:-}" ]] && exit 1 ;;
    esac ;;
  "resource list")           echo "rg-from-lookup" ;;
esac
exit 0
`;

/**
 * Stands in for `curl`. Answers the enqueue POST with a job id, then walks $CURL_STATUSES one entry
 * per poll — so a test names the job's whole life as a list. The body and the status code are
 * printed the way the script asks for them, body first and `%{http_code}` on its own last line.
 * $CURL_JOB_RESULTS is the `results` array the job records, one entry per indexer.
 */
const FAKE_CURL = `#!/usr/bin/env bash
echo "curl $*" >> "\${CALL_LOG}"
url="\${@: -1}"
if [[ "$url" == *"/apply" ]]; then
  echo '{"jobId":"job-1","statusUrl":"/admin/search-definitions/jobs/job-1"}'
  echo "\${CURL_POST_CODE:-202}"
  exit 0
fi
n=0
[[ -f "\${CALL_LOG}.n" ]] && n="$(cat "\${CALL_LOG}.n")"
read -r -a statuses <<< "\${CURL_STATUSES:-succeeded}"
status="\${statuses[$n]:-\${statuses[-1]}}"
echo "$((n + 1))" > "\${CALL_LOG}.n"
echo "{\\"id\\":\\"job-1\\",\\"status\\":\\"\${status}\\",\\"error\\":\\"\${CURL_JOB_ERROR:-}\\",\\"results\\":\${CURL_JOB_RESULTS:-[]}}"
echo "\${CURL_GET_CODE:-200}"
exit 0
`;

/** Run the script with both fakes in place, returning {status, stdout, stderr, calls}. */
function run(args, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsa-apply-'));
  const az = path.join(dir, 'az');
  const curl = path.join(dir, 'curl');
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(az, FAKE_AZ, { mode: 0o755 });
  fs.writeFileSync(curl, FAKE_CURL, { mode: 0o755 });
  fs.writeFileSync(log, '');

  const res = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      AZ: az,
      CURL: curl,
      CALL_LOG: log,
      ADMIN_API_KEY: API_KEY,
      APPLY_POLL_SLEEP: '0',
      POLL_TRIES: '1',
      POLL_SLEEP: '0',
      ...(opts.env || {})
    }
  });

  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...res, calls };
}

const indexOf = (calls, pred) => calls.findIndex(pred);
const lastIndexOf = (calls, pred) => calls.map(pred).lastIndexOf(true);

const isCreate = (c) => c.startsWith('az role assignment create');
const isDelete = (c) => c.startsWith('az role assignment delete');
const isPost = (c) => c.startsWith('curl ') && c.includes('/admin/search-definitions/apply');
const isPoll = (c) => c.startsWith('curl ') && c.includes('/admin/search-definitions/jobs/');

test('with-search-admin.sh apply', async (t) => {
  await t.test('grants BEFORE the POST', async () => {
    // The app writes definitions as demi-identity-<env>. A POST that lands before the assignment
    // does gets a 403 from the search service, and the job fails for a reason that reads like a
    // code bug rather than a timing one.
    const r = run(['apply', '--env', 'test', '--only', 'projects']);
    assert.strictEqual(r.status, 0, r.stderr);
    const created = indexOf(r.calls, isCreate);
    const posted = indexOf(r.calls, isPost);
    assert.ok(created >= 0, 'nothing was granted');
    assert.ok(posted > created, 'the apply must not be enqueued before the grant exists');
  });

  await t.test('revokes AFTER the job reaches a terminal status', async () => {
    // Revoking while the job is still queued or running is the same outage as never granting: the
    // app loses the role mid-apply. The revoke has to follow the last poll, not the POST.
    const r = run(['apply', '--env', 'test', '--only', 'projects'],
      { env: { CURL_STATUSES: 'queued running succeeded' } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.calls.filter(isPoll).length, 3, 'it must poll until the job stops moving');
    const deleted = indexOf(r.calls, isDelete);
    const lastPoll = lastIndexOf(r.calls, isPoll);
    assert.ok(deleted > lastPoll, 'the grant must outlive the job, and not a moment longer');
  });

  await t.test('revokes when the job FAILS, and exits non-zero', async () => {
    const r = run(['apply', '--env', 'test', '--only', 'projects'],
      { env: { CURL_STATUSES: 'running failed', CURL_JOB_ERROR: 'index put rejected' } });
    assert.notStrictEqual(r.status, 0, 'a failed apply must not report success');
    assert.strictEqual(r.calls.filter(isDelete).length, 1, 'a failed job must still revoke');
    assert.match(r.stderr, /index put rejected/, 'the operator needs the job error, not just a code');
  });

  await t.test('treats `warned` as a success, with the per-indexer results', async () => {
    // What a chunks run normally ends as: the definitions are written, the reset is issued, and the
    // indexer is still going when the job's 25-minute wait runs out. Exiting non-zero here would
    // have the operator chase a run that did its job, and the results say which indexer to watch.
    const r = run(['apply', '--env', 'test', '--only', 'chunks', '--live'], {
      env: {
        CURL_STATUSES: 'running warned',
        CURL_JOB_RESULTS: '[{"indexer":"chunks-indexer","status":"stillRunning"},' +
          '{"indexer":"projects-indexer","status":"success","itemsProcessed":"412","itemsFailed":"0"}]'
      }
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /WARNING|WITH WARNINGS/, 'a warned job has to say so, not pass silently');
    assert.match(r.stderr, /chunks-indexer stillRunning/, 'the indexer still running must be named');
    assert.match(r.stderr, /projects-indexer success items=412 failed=0/);
    assert.strictEqual(r.calls.filter(isDelete).length, 1, 'a warned job still revokes');
  });

  await t.test('ends on a status the job never emits instead of polling through it', async () => {
    // The job writes queued, running, succeeded, warned or failed (src/jobs/search-definitions.js).
    // Anything else is the two sides having drifted apart, and reading it as "still going" holds the
    // role open to the deadline while reading it as done would report an unknown state as success.
    const r = run(['apply', '--env', 'test', '--only', 'projects'],
      { env: { CURL_STATUSES: 'ready' } });
    assert.notStrictEqual(r.status, 0, 'an unknown status is not a success');
    assert.strictEqual(r.calls.filter(isPoll).length, 1, 'it must not keep polling an unknown status');
    assert.strictEqual(r.calls.filter(isDelete).length, 1);
  });

  await t.test('revokes when the POST itself is rejected', async () => {
    // Nothing is running, so this is the cheapest grant to leak and the easiest to miss.
    const r = run(['apply', '--env', 'test', '--only', 'projects'],
      { env: { CURL_POST_CODE: '500' } });
    assert.notStrictEqual(r.status, 0);
    assert.strictEqual(r.calls.filter(isPoll).length, 0, 'there is no job to poll');
    assert.strictEqual(r.calls.filter(isDelete).length, 1, 'a rejected POST must still revoke');
  });

  await t.test('gives up on a job that never finishes, and still revokes', async () => {
    // The grant cannot be held open forever waiting on a job that is stuck. Giving up has to hand
    // over the status URL, because the job itself may still be running after the role is gone.
    const r = run(['apply', '--env', 'test', '--only', 'chunks'],
      { env: { CURL_STATUSES: 'running', APPLY_TIMEOUT: '0' } });
    assert.notStrictEqual(r.status, 0);
    assert.strictEqual(r.calls.filter(isDelete).length, 1, 'a timeout must still revoke');
    assert.match(r.stderr, /job-1/, 'the job id has to survive the give-up, or it cannot be followed');
  });

  await t.test('never prints the API key', async () => {
    // It is a long-lived admin credential and this script is run with the output pasted into
    // tickets. Off the argv too: /proc is readable by anything on the box.
    const r = run(['apply', '--env', 'test', '--only', 'projects', '--live']);
    assert.ok(!r.stdout.includes(API_KEY), 'the key reached stdout');
    assert.ok(!r.stderr.includes(API_KEY), 'the key reached stderr');
    assert.ok(!r.calls.join('\n').includes(API_KEY), 'the key reached the curl command line');
  });

  await t.test('refuses to grant when no API key is exported', async () => {
    // Exit before the create: a grant made for a call that cannot authenticate is a window opened
    // for nothing.
    const r = run(['apply', '--env', 'test', '--only', 'projects'], { env: { ADMIN_API_KEY: '' } });
    assert.notStrictEqual(r.status, 0);
    assert.strictEqual(r.calls.filter(isCreate).length, 0, 'nothing usable was asked for');
    assert.match(r.stderr, /ADMIN_API_KEY/);
  });

  await t.test('sends what was asked for, and nothing it was not asked for', async () => {
    // `live` decides whether this writes to the service at all, so a flag dropped between the CLI
    // and the body is the difference between a dry run and a real one.
    const r = run(['apply', '--env', 'test', '--only', 'projects,documents',
      '--datasources', 'demi-projects-ds', '--live']);
    assert.strictEqual(r.status, 0, r.stderr);
    const post = r.calls.find(isPost);
    assert.match(post, /"only":\["projects","documents"\]/);
    assert.match(post, /"datasources":\["demi-projects-ds"\]/);
    assert.match(post, /"live":true/);
    assert.match(post, /"check":false/);
  });

  await t.test('goes through the APIM machine path for the environment', async () => {
    // Direct azurewebsites.net access is platform-403'd since the APIM cutover. `/machine` is the
    // API for callers with no browser session, which is what this script is; `X-Api-Key` is
    // accepted on `/api` too, so the path is a choice rather than the only one that works.
    const r = run(['apply', '--env', 'prod', '--only', 'projects'],
      { env: { SUBSCRIPTION: 'sub-x', RG: 'rg-x' } });
    assert.strictEqual(r.status, 0, r.stderr);
    const post = r.calls.find(isPost);
    assert.ok(post.includes('https://demi-apim-prod.azure-api.net/machine/admin/search-definitions/apply'),
      `machine path missing: ${post}`);
    // And it grants on the environment it is calling, not on the test default.
    assert.match(r.calls.find(isCreate), /searchServices\/demi-search-prod/);
  });

  await t.test('a revoke that fails takes the run down with it, apply or no apply', async () => {
    // The apply succeeded, so without this the script exits 0 and the operator moves on — while
    // the INTERNET-FACING API keeps Search Service Contributor indefinitely. A distinct code (3)
    // so a caller can tell "the grant is still standing" from "the apply was refused" (1).
    const r = run(['apply', '--env', 'test', '--only', 'projects'],
      { env: { AZ_DELETE_FAILS: '1' } });

    assert.strictEqual(r.status, 3, 'a leaked grant is not a successful run');
    assert.match(r.stderr, /STILL GRANTED/, 'the message has to say the window is still open');
    assert.ok(r.stderr.includes(ASSIGNMENT_ID), 'and name the assignment, not a placeholder');
    assert.match(r.stderr, /az role assignment delete --ids/, 'and how to close it');
  });

  await t.test('warns when the identity already holds the role before this run grants it', async () => {
    // A run that was killed cannot fire its revoke trap, and the grant it made then stands with
    // nobody watching. This run revokes only its OWN assignment, so the old one has to be named.
    const r = run(['apply', '--env', 'test', '--only', 'projects']);

    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /ALREADY holds Search Service Contributor/);
    assert.strictEqual(r.calls.filter(isCreate).length, 1,
      'a stale grant is a warning, not a reason to refuse the run');
  });

  await t.test('says nothing about a stale grant when there is none', async () => {
    const r = run(['apply', '--env', 'test', '--only', 'projects'], { env: { AZ_LIST_EMPTY: '1' } });

    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!/ALREADY holds/.test(r.stderr), 'a clean scope must not raise a stale-grant warning');
  });

  await t.test('still runs a plain command when given one', async () => {
    // The devbox flow is the same script and must not have moved.
    const r = run(['--', 'bash', '-c', 'echo COMMAND-RAN']);
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /COMMAND-RAN/);
    assert.strictEqual(r.calls.filter(isPost).length, 0, 'no API call belongs in the devbox flow');
    assert.strictEqual(r.calls.filter(isDelete).length, 1);
  });
});
