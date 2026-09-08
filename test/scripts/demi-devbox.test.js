'use strict';

/**
 * What `scripts/demi-devbox.sh` sends where, and what it refuses to send.
 *
 * Every real run of this script grants a role on a live search service and then writes definitions
 * to it, so the things worth pinning are the ones that cannot be tried out: that `--env prod`
 * addresses the prod subscription and nothing else, that an `az` login which cannot read role
 * assignments stops the run BEFORE the grant instead of ending in an unexplained 403 on the
 * devbox, that the writing half never starts without a yes, and that an indexer already running is
 * never reset out from under itself.
 *
 * `AZ` stands in for the `az` CLI, the same seam `with-search-admin.test.js` uses — and that script
 * runs for real here, because the grant/revoke round trip is part of what is being tested. The fake
 * logs every invocation and answers the run-command calls with output shaped like the devbox's, so
 * "what did it run on the VM" is read off the log rather than from this script's own reporting.
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'demi-devbox.sh');

const TEST_SUB = '7897ceb1-9a86-4639-87d7-7f9ff67142b3';
const PROD_SUB = 'be5924ac-1083-4a1b-be92-7b444882cfd9';
const ASSIGNMENT_ID = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Search/' +
  'searchServices/svc/providers/Microsoft.Authorization/roleAssignments/fake-id';

/**
 * Stands in for `az`. Logs its whole argv, resolves the environment table the way ARM would, and
 * replies to `vm run-command invoke` with what the devbox would have printed for the command it was
 * handed — including the `DEMI_EXIT=` line the real remote script appends, since run-command drops
 * the remote exit code.
 */
const FAKE_AZ = `#!/usr/bin/env bash
# One log line per call: the run-command payloads are multi-line node programs, and a raw echo
# would split one call across several lines and make "what ran on the VM" unreadable.
echo "$*" | tr "\\n" " " >> "\${AZ_LOG}"
echo "" >> "\${AZ_LOG}"

if [[ -n "\${AZ_PAYLOAD_DIR:-}" && "$*" == *--scripts* ]]; then
  payload="$(mktemp "\${AZ_PAYLOAD_DIR}/payload-XXXXXX")"
fi

sub=""; scripts=""; prev=""
for a in "$@"; do
  case "$prev" in
    --subscription) sub="$a" ;;
    --scripts) scripts="$a" ;;
  esac
  prev="$a"
done

if [[ -n "\${payload:-}" ]]; then printf "%s" "$scripts" > "$payload"; fi

group() { if [[ "$sub" == "${PROD_SUB}" ]]; then echo "rg-demi-prod"; else echo "c4b0a8-test-rg"; fi; }

status_reply() {
  local n=1
  if [[ -f "\${AZ_STATUS_COUNT}" ]]; then n=$(( $(cat "\${AZ_STATUS_COUNT}") + 1 )); fi
  echo "$n" > "\${AZ_STATUS_COUNT}"
  if [[ -n "\${AZ_INDEXER_INPROGRESS:-}" ]]; then
    echo "STATUS=inProgress START=2026-09-08T20:00:00Z ITEMS=0 FAILED=0"
  elif [[ "$n" -le 1 ]]; then
    echo "STATUS=success START=2026-09-08T20:00:00Z ITEMS=0 FAILED=0"
  else
    echo "STATUS=success START=2026-09-08T21:00:00Z ITEMS=61587 FAILED=0"
  fi
  echo "DEMI_EXIT=0"
}

remote_reply() {
  local s="$1"
  echo "Enable succeeded:"
  echo "[stdout]"
  if [[ "$s" == *"--check"* ]]; then
    if [[ -n "\${AZ_DRIFT:-}" ]]; then
      echo "drift documents: missing fields fileSize"
      echo "DEMI_EXIT=1"
    else
      echo "ok documents"
      echo "DEMI_EXIT=0"
    fi
  elif [[ "$s" == *"apply-search-definitions.js --live"* ]]; then
    echo "applied 2 definition(s)."
    echo "DEMI_EXIT=0"
  elif [[ "$s" == *"apply-search-definitions.js"* ]]; then
    echo "index    documents                exists   <- documents.json"
    if [[ -n "\${AZ_DS_DIFFERS:-}" ]]; then
      echo "  !! data source demi-documents-ds DIFFERS from the committed copy. The indexer will"
    fi
    echo "dry run — nothing was written."
    echo "DEMI_EXIT=0"
  elif [[ "$s" == *"put-search-datasources.js"* ]]; then
    echo "demi-documents-ds 204 -> demicosmos/documents"
    echo "DEMI_EXIT=0"
  elif [[ "$s" == *"/status?api-version"* ]]; then
    status_reply
  elif [[ "$s" == *"/reset?api-version"* ]]; then
    echo "RESET=204"
    echo "RUN=202"
    echo "DEMI_EXIT=0"
  else
    echo "DEMI_EXIT=0"
  fi
}

case "$1 $2" in
  "account show") echo "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" ;;
  "resource list") group ;;
  "resource show")
    echo "/subscriptions/$sub/resourceGroups/$(group)/providers/Microsoft.ManagedIdentity/userAssignedIdentities/demi-identity-x" ;;
  "role assignment")
    case "$3" in
      list)
        if [[ -n "\${AZ_RBAC_DENIED:-}" && "$*" == *"[0].id"* ]]; then
          echo "AADSTS70043: The refresh token has expired due to inactivity." >&2
          exit 1
        fi
        echo "${ASSIGNMENT_ID}" ;;
      create) echo "${ASSIGNMENT_ID}" ;;
      delete) ;;
    esac ;;
  "identity show") echo "fake-principal-id" ;;
  "vm start") ;;
  "vm run-command") remote_reply "$scripts" ;;
esac
exit 0
`;

/** Run the script with the fake az, returning {status, stdout, stderr, calls, remote}. */
function run(args, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demi-devbox-'));
  const az = path.join(dir, 'az');
  const log = path.join(dir, 'az.log');
  const payloadDir = path.join(dir, 'payloads');
  fs.mkdirSync(payloadDir);
  fs.writeFileSync(az, FAKE_AZ, { mode: 0o755 });
  fs.writeFileSync(log, '');

  const res = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    input: opts.input === undefined ? '' : opts.input,
    env: {
      ...process.env,
      AZ: az,
      // The shim also goes on PATH, so anything reaching for a bare `az` finds the fake too.
      PATH: `${dir}:${process.env.PATH}`,
      AZ_LOG: log,
      AZ_STATUS_COUNT: path.join(dir, 'status.count'),
      AZ_PAYLOAD_DIR: payloadDir,
      // The RBAC-replication poll in with-search-admin.sh and the indexer poll here both sleep.
      POLL_SLEEP: '0',
      INDEXER_POLL_SLEEP: '0',
      ...(opts.env || {})
    }
  });

  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  // The verbatim `--scripts` value of every run-command call, before the log flattens its newlines.
  const payloads = fs.readdirSync(payloadDir).sort()
    .map(f => fs.readFileSync(path.join(payloadDir, f), 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
  // What was actually sent to the VM, one entry per run-command call.
  const remote = calls.filter(c => c.startsWith('vm run-command'));
  return { ...res, calls, remote, payloads };
}

const creates = (calls) => calls.filter(c => c.startsWith('role assignment create'));
const deletes = (calls) => calls.filter(c => c.startsWith('role assignment delete'));

test('demi-devbox.sh', async (t) => {
  await t.test('refuses an unknown action and an unknown flag', () => {
    const action = run(['reindex']);
    assert.strictEqual(action.status, 1);
    assert.match(action.stderr, /unknown action 'reindex'/);
    assert.match(action.stderr, /drift\|apply/, 'the usage must reach the operator');

    const flag = run(['drift', '--force']);
    assert.strictEqual(flag.status, 2, 'a bad flag is a usage error, distinct from a failed run');
    assert.match(flag.stderr, /unknown argument '--force'/);

    const none = run([]);
    assert.strictEqual(none.status, 1);
  });

  await t.test('refuses an environment it has no table row for', () => {
    // Before any az call: the subscription id IS the table, so an unknown name has no scope to
    // grant on and nothing to ask ARM about.
    const r = run(['drift', '--env', 'staging']);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /unknown --env 'staging', want test\|prod/);
    assert.deepStrictEqual(r.calls, [], 'an unknown env must not reach az at all');
  });

  await t.test('--env prod addresses the prod subscription and nothing else', () => {
    // The failure this guards is the one the manual runs kept hitting: the wrapper defaults to the
    // test names, so a prod run made under them grants on a test scope and then 403s on prod.
    const r = run(['drift', '--env', 'prod']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.calls.length > 0);
    assert.ok(r.calls.every(c => !c.includes(TEST_SUB)),
      `no call may name the test subscription: ${r.calls.filter(c => c.includes(TEST_SUB)).join(' | ')}`);
    assert.ok(r.calls.some(c => c.includes(PROD_SUB)));
    // Resource group read off the service rather than assumed: prod is rg-demi-prod, test is not.
    assert.ok(creates(r.calls).some(c => c.includes('rg-demi-prod')),
      'the grant scope must carry the group the search service actually lives in');
    assert.ok(r.remote.some(c => c.includes('demi-devbox-prod')));
  });

  await t.test('grants for the drift check and revokes afterwards', () => {
    const r = run(['drift']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(creates(r.calls).length, 1);
    assert.strictEqual(deletes(r.calls).length, 1, 'the grant must not outlive the check');
    assert.ok(r.remote.some(c => c.includes('apply-search-definitions.js --check')));
    assert.ok(r.remote.every(c => !c.includes('--live')), 'drift is read-only');
  });

  await t.test('drift exits 1 when the live index is missing a committed field', () => {
    // run-command drops the remote exit code, so a drift that only showed up in the text would
    // exit 0 — which is how this class of failure stayed invisible in the first place.
    const r = run(['drift'], { env: { AZ_DRIFT: '1' } });
    assert.strictEqual(r.status, 1);
    assert.match(r.stdout, /drift documents: missing fields fileSize/);
    assert.strictEqual(deletes(r.calls).length, 1, 'a failed check must still revoke');
  });

  await t.test('stops before granting when az cannot read role assignments', () => {
    // An expired Graph refresh token does not fail the grant loudly: with-search-admin.sh prints
    // "grant not readable after 20 tries", runs anyway, and the devbox answers 403.
    const r = run(['drift', '--env', 'prod'], { env: { AZ_RBAC_DENIED: '1' } });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /AADSTS70043/);
    assert.match(r.stderr,
      /az login --tenant aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee --scope "https:\/\/graph\.microsoft\.com\/\/\.default"/,
      'the operator needs the exact command, with the tenant filled in');
    assert.deepStrictEqual(creates(r.calls), [], 'no grant may be attempted');
    assert.deepStrictEqual(r.remote, [], 'nothing may reach the devbox');
  });

  await t.test('apply dry-runs, then stops at the prompt when the answer is not y', () => {
    const r = run(['apply', '--only', 'documents'], {
      env: { AZ_DS_DIFFERS: '1' },
      input: '\n'
    });
    assert.strictEqual(r.status, 1);
    assert.match(r.stdout, /dry run — nothing was written/);
    assert.match(r.stdout, /PUT data source\(s\): demi-documents-ds/);
    assert.match(r.stdout, /reset and run indexer\(s\): documents-indexer/);
    assert.match(r.stderr, /aborted — nothing was written/);
    assert.ok(r.remote.every(c => !c.includes('--live') && !c.includes('put-search-datasources')),
      'nothing may be written before the operator says yes');
    assert.strictEqual(deletes(r.calls).length, creates(r.calls).length,
      'every grant taken for the dry run is given back');
  });

  await t.test('apply --yes writes in order: index, data source, indexer reset, poll', () => {
    const r = run(['apply', '--env', 'prod', '--only', 'documents', '--yes'],
      { env: { AZ_DS_DIFFERS: '1' } });
    assert.strictEqual(r.status, 0, r.stderr);

    const order = r.remote.map((c) => {
      if (c.includes('--check')) return 'check';
      if (c.includes('apply-search-definitions.js --live')) return 'index';
      if (c.includes('apply-search-definitions.js')) return 'dry';
      if (c.includes('put-search-datasources.js')) return 'datasource';
      if (c.includes('/reset?api-version')) return 'reset';
      if (c.includes('/status?api-version')) return 'status';
      return 'other';
    });
    // The order is the whole point: an index widened without the data source fills with nulls, and
    // a reset before the PUT re-pulls the old column list.
    assert.deepStrictEqual(order, ['dry', 'index', 'datasource', 'status', 'reset', 'status'], order.join(','));

    // ONLY the data source that differs is copied into DS_DIR. put-search-datasources.js writes
    // every file in the directory it is given, so a wider copy would rewrite the chunks data
    // source on a `--only documents` run.
    const ds = r.remote.find(c => c.includes('put-search-datasources.js'));
    assert.match(ds, /cp azure\/search\/datasources\/demi-documents-ds\.json \/tmp\/demi-ds\//);
    assert.ok(!ds.includes('demi-chunks-ds'), '--only documents must not touch the chunks data source');
    assert.match(ds, /DS_DIR=\/tmp\/demi-ds/);
    // `\S*` between the name and the value: each is single-quoted in the payload, so the literal
    // carries the quoting the shell strips before put-search-datasources.js sees it.
    assert.match(ds, new RegExp(`DS_SUB=\\S*${PROD_SUB}`));
    assert.match(ds, /DS_RG=\S*rg-demi-prod/);
    assert.match(ds, /DS_IDENTITY_ID=\S*userAssignedIdentities\/demi-identity-x/);

    assert.match(r.stdout, /documents-indexer finished, 61587 processed/);
    assert.strictEqual(deletes(r.calls).length, creates(r.calls).length, 'no grant left standing');
  });

  await t.test('apply skips the data source and the reset when nothing differs', () => {
    const r = run(['apply', '--only', 'documents', '--yes']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /no data source differs, so no indexer reset/);
    assert.ok(r.remote.every(c => !c.includes('put-search-datasources') && !c.includes('/reset?')),
      'a reset re-pulls every row; it happens only when a projection actually changed');
  });

  await t.test('refuses to reset an indexer whose last execution is still running', () => {
    // A PT5M tick already in flight writes its old high-water mark back when it finishes, undoing
    // the clear. The run that follows then reports 0 rows and reads like a broken reset.
    const r = run(['apply', '--only', 'documents', '--yes'],
      { env: { AZ_DS_DIFFERS: '1', AZ_INDEXER_INPROGRESS: '1' } });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /documents-indexer is running now/);
    assert.ok(r.remote.every(c => !c.includes('/reset?api-version')));
    assert.strictEqual(deletes(r.calls).length, creates(r.calls).length);
  });

  await t.test('--only reaches the devbox and nothing else does', () => {
    const r = run(['drift', '--only', 'projects']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.remote.some(c => c.includes('--check --only projects')));
  });

  await t.test('every payload sent to the VM is valid bash at both quoting levels', () => {
    // Nothing here parses these before the VM does. The command is built on this machine, quoted
    // into `demi-run '...'`, quoted again into `--scripts "..."`, and the node programs inside it
    // carry braces, semicolons and regexes — a quoting bug arrives as a shell error 60 seconds
    // later on a box with a live role grant open.
    const r = run(['apply', '--env', 'prod', '--only', 'documents', '--yes'],
      { env: { AZ_DS_DIFFERS: '1' } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.payloads.length >= 5, `expected every remote step to be captured, got ${r.payloads.length}`);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demi-payload-'));
    // Stands in for demi-run: writes the single argument it was handed, which is the command as the
    // devbox would receive it after one round of quote removal.
    const stub = path.join(dir, 'demi-run');
    const captured = path.join(dir, 'inner.sh');
    fs.writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s' "$1" > ${captured}\n`, { mode: 0o755 });

    for (const payload of r.payloads) {
      const outer = path.join(dir, 'outer.sh');
      fs.writeFileSync(outer, payload);
      const outerCheck = spawnSync('bash', ['-n', outer], { encoding: 'utf8' });
      assert.strictEqual(outerCheck.status, 0, `--scripts is not valid bash: ${outerCheck.stderr}\n${payload}`);

      // Unwrap it the way the VM does, then check the command that actually runs.
      fs.rmSync(captured, { force: true });
      const unwrap = spawnSync('bash', ['-c', payload.replace('sudo -u demi /usr/local/bin/demi-run', stub)],
        { encoding: 'utf8' });
      assert.strictEqual(unwrap.status, 0, unwrap.stderr);
      const inner = fs.readFileSync(captured, 'utf8');
      const innerCheck = spawnSync('bash', ['-n', captured], { encoding: 'utf8' });
      assert.strictEqual(innerCheck.status, 0, `the command demi-run receives is not valid bash: ${innerCheck.stderr}\n${inner}`);
      assert.match(inner, /^cd \/opt\/eagle-demi &&/, 'every command runs in the checkout');
      assert.match(inner, /echo DEMI_EXIT=\$\?$/, 'every command must carry its exit code back');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('the re-entrant phases refuse to run outside a grant', () => {
    // They exist so ONE grant covers the apply and its poll; typed by hand they would run
    // ungranted and 403 on the devbox.
    const r = run(['__apply-run', '--env', 'test']);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /internal; use drift or apply/);
  });
});
