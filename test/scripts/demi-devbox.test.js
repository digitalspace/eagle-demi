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
 * Each phase is one `az vm run-command invoke` carrying several steps, so the other thing pinned
 * here is that one clean step never speaks for a failing one — the payload and-s every step's code
 * into the one DEMI_EXIT line this script reads — and that an apply stays inside a handful of
 * calls. The indexer wait itself runs on the VM; its own decisions are covered by
 * `reset-and-run-indexers.test.js`, and the fake below only replays a transcript of them.
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
 * replies to `vm run-command invoke` with what the devbox would have printed for the payload it was
 * handed — one `DEMI_STEP <name> <rc>` block per name in the payload's loop, then the single
 * `DEMI_EXIT=` line the real remote script appends, since run-command drops the remote exit code.
 */
const FAKE_AZ = `#!/usr/bin/env bash
# One log line per call: the run-command payloads are multi-line shell, and a raw echo would split
# one call across several lines and make "what ran on the VM" unreadable.
echo "$*" | tr "\\n" " " >> "\${AZ_LOG}"
echo "" >> "\${AZ_LOG}"

state="$(dirname "\${AZ_LOG}")"

# \`--scripts\` is invoke's flag, \`--script\` the managed run command's.
if [[ -n "\${AZ_PAYLOAD_DIR:-}" && "$*" == *--script* ]]; then
  payload="$(mktemp "\${AZ_PAYLOAD_DIR}/payload-XXXXXX")"
fi

sub=""; scripts=""; name=""; file=""; query=""; outuri=""; prev=""
for a in "$@"; do
  case "$prev" in
    --subscription) sub="$a" ;;
    --scripts|--script) scripts="$a" ;;
    --name|-n) name="$a" ;;
    -f) file="$a" ;;
    --query) query="$a" ;;
    --output-blob-uri) outuri="$a" ;;
  esac
  prev="$a"
done

# Each call to a counter returns how many times it has been called before, so a test can say
# "not ready for the first N checks".
count() { local f="\${state}/count-$1" n=0; [[ -f "$f" ]] && n="$(cat "$f")"; echo $((n + 1)) > "$f"; echo "$n"; }

# The raw instanceView JSON: AZ_IV for the first AZ_READY_AFTER checks, a settled VM after that.
# The script classifies it itself, so the fake never decides what counts as ready.
READY_IV='{"statuses":[{"code":"ProvisioningState/succeeded"},{"code":"PowerState/running"}],"vmAgent":{"statuses":[{"code":"ProvisioningState/succeeded","displayStatus":"Ready","message":"Guest Agent is running"}],"extensionHandlers":[]},"extensions":[]}'
instance_view() {
  if [[ -n "\${AZ_IV_FAIL:-}" ]]; then echo "ERROR: (AuthorizationFailed) no read on the VM" >&2; exit 1; fi
  if [[ "$(count iv)" -ge "\${AZ_READY_AFTER:-0}" ]]; then echo "\${AZ_IV_READY:-$READY_IV}"; else echo "\${AZ_IV}"; fi
}

run_command() {
  case "$1" in
    invoke) remote_reply "$scripts" ;;
    create)
      if [[ -n "\${AZ_CREATE_FAIL:-}" ]]; then
        echo "ERROR: (AuthorizationFailed) cannot write https://acct.blob.core.windows.net/devbox-run-output/x/stdout?sv=1&sig=FAKESIG" >&2
        exit 1
      fi
      [[ "$outuri" != @* ]] || echo "\${outuri#@}" > "\${state}/sas-path"
      [[ -z "\${AZ_CREATE_SLEEP:-}" ]] || sleep "\${AZ_CREATE_SLEEP}"
      # The real CLI prints the resource, blob URIs and their SAS included, unless told -o none.
      [[ "$*" == *"-o none"* ]] || echo "{\\"outputBlobUri\\": \\"https://fake/\${name}/stdout?sig=FAKESIG\\"}"
      # \`@file\`: what the SAS file held and how it was protected, for the tests to read back.
      if [[ "$outuri" == @* ]]; then
        cat "\${outuri#@}" > "\${state}/sas-seen"
        stat -c %a "\${outuri#@}" > "\${state}/sas-mode"
      fi
      [[ -n "\${AZ_NO_BLOB:-}" ]] || remote_reply "$scripts" > "\${state}/blob-\${name}-stdout"
      [[ -z "\${AZ_STDERR_TEXT:-}" ]] || echo "\${AZ_STDERR_TEXT}" > "\${state}/blob-\${name}-stderr" ;;
    delete)
      if [[ -n "\${AZ_DELETE_NOTFOUND:-}" ]]; then echo "ERROR: (ResourceNotFound) The Resource was not found." >&2; exit 1; fi ;;
    show)
      if [[ "$query" == *executionMessage* ]]; then
        echo "\${AZ_EXEC_MESSAGE:-Execution failed: Error creating AppendBlob: StatusCode=403, ErrorCode=AuthorizationPermissionMismatch, QueryParameterName=sig, QueryParameterValue=FAKESIG}"
        return
      fi
      n="$(count show)"
      if [[ "$n" -lt "\${AZ_PENDING_POLLS:-0}" ]]; then echo "Creating Pending"; return; fi
      if [[ "$n" -lt $(( \${AZ_PENDING_POLLS:-0} + \${AZ_RUNNING_POLLS:-0} )) ]]; then echo "Succeeded Running"; return; fi
      echo "\${AZ_PROV_STATE:-Succeeded} \${AZ_EXEC_STATE:-Succeeded}" ;;
  esac
}

if [[ -n "\${payload:-}" ]]; then printf "%s" "$scripts" > "$payload"; fi

group() { if [[ "$sub" == "${PROD_SUB}" ]]; then echo "rg-demi-prod"; else echo "c4b0a8-test-rg"; fi; }

# The names the payload's loop walks. The script sends them as a literal \`for n in a b; do\`, and
# \`all\` is the label a run that named no index carries.
names_of() { sed -n "s/.*for n in \\([A-Za-z0-9 _-]*\\); do.*/\\1/p" <<<"$1" | head -1; }

# The indexers handed to reset-and-run-indexers.js: the words between the script name and the
# newline that ends the remote command. Grepping for *-indexer would also match the script's own
# filename.
indexers_of() {
  local rest="\${1##*reset-and-run-indexers.js }"
  echo "\${rest%%$'\\n'*}"
}

# AZ_DRIFT / AZ_DRY_FAIL: "1" for every index, or a comma list to fail just those. One payload now
# carries every name, so this is what lets a test mix a clean index with a dirty one.
fails_for() {
  local want="$1" name="$2"
  [[ -n "$want" ]] || return 1
  [[ "$want" == "1" || ",\${want}," == *",\${name},"* ]]
}

# The transcript reset-and-run-indexers.js prints on the VM. AZ_INDEXER_* pick which one.
indexer_transcript() {
  local n
  # Each value in the payload is single-quoted twice over, so match the digit rather than the
  # literal \`='1'\`.
  local nowait='DEMI_NO_WAIT=[^ ]*1'
  for n in $(indexers_of "$1"); do
    echo "DEMI_BEFORE \${n} status=success start=2026-09-08T20:00:00Z"
    if [[ -n "\${AZ_INDEXER_INPROGRESS:-}" ]]; then echo "DEMI_BUSY \${n}"; bad=1; return; fi
    echo "DEMI_RESET \${n} 204"
    echo "DEMI_RUN \${n} \${AZ_RUN_STATUS:-202}"
    if [[ "$1" =~ $nowait ]]; then echo "DEMI_NOWAIT \${n}"; continue; fi
    echo "DEMI_POLL \${n} inProgress items=0"
    case "\${AZ_INDEXER_OUTCOME:-success}" in
      warn) echo "DEMI_WARN \${n} still running after 4800s; check its status before resetting again" ;;
      notreset) echo "DEMI_RESET_NOT_APPLIED \${n}"; bad=1; return ;;
      failure)
        echo "DEMI_RESULT name=\${n} status=transientFailure items=0 failed=3 tracking=null"
        echo "DEMI_FAIL \${n} ended transientFailure"; bad=1; return ;;
      *) echo "DEMI_RESULT name=\${n} status=success items=61587 failed=0 tracking=null" ;;
    esac
  done
}

remote_reply() {
  local s="$1" name disp bad=0
  echo "Enable succeeded:"
  echo "[stdout]"
  for name in $(names_of "$s"); do
    # \`all\` is the script's label for "no --only"; the real tool still reports an index name.
    disp="$name"; [[ "$disp" != all ]] || disp=documents
    if [[ "$s" == *"--check"* ]]; then
      if fails_for "\${AZ_DRIFT:-}" "$name"; then
        echo "drift \${disp}: missing fields fileSize"; echo "DEMI_STEP \${name} 1"; bad=1
      else
        echo "ok \${disp}"; echo "DEMI_STEP \${name} 0"
      fi
    elif [[ "$s" == *"apply-search-definitions.js --live"* ]]; then
      echo "applied 2 definition(s) to \${disp}."
      echo "DEMI_STEP \${name} 0"
    elif [[ "$s" == *"apply-search-definitions.js"* ]]; then
      echo "index    \${disp}                exists   <- \${disp}.json"
      if [[ -n "\${AZ_DS_DIFFERS:-}" ]]; then
        echo "  !! data source demi-documents-ds DIFFERS from the committed copy. The indexer will"
      fi
      if fails_for "\${AZ_DRY_FAIL:-}" "$name"; then
        echo "the live index could not be read."; echo "DEMI_STEP \${name} 1"; bad=1
      else
        echo "dry run — nothing was written."; echo "DEMI_STEP \${name} 0"
      fi
    fi
  done

  # The data source PUT rides on the same payload as the live apply, behind an && the devbox
  # evaluates: a failed index PUT means it never runs.
  if [[ "$s" == *"put-search-datasources.js"* && "$bad" -eq 0 ]]; then
    echo "demi-documents-ds 204 -> demicosmos/documents"
    echo "DEMI_STEP datasources 0"
  fi
  if [[ "$s" == *"reset-and-run-indexers.js"* ]]; then indexer_transcript "$s"; fi
  # A one-off \`run\`: as many lines as asked for, and the exit code asked for.
  if [[ -n "\${AZ_RUN_LINES:-}" ]]; then seq 1 "\${AZ_RUN_LINES}"; bad="\${AZ_RUN_EXIT:-0}"; fi

  [[ -n "\${AZ_NO_EXIT_LINE:-}" ]] || echo "DEMI_EXIT=\${bad}"
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
  "vm get-instance-view") instance_view ;;
  "vm run-command") run_command "$3" "$@" ;;
  "storage account") echo "demifctestfake" ;;
  "storage blob")
    case "$3" in
      generate-sas) echo "https://demifctestfake.blob.core.windows.net/devbox-run-output/\${name}?sig=FAKESIG" ;;
      download)
        src="\${state}/blob-\${name//\\//-}"
        if [[ -n "\${AZ_DOWNLOAD_FAIL:-}" ]]; then echo "ERROR: (AuthorizationFailure) This request is not authorized." >&2; exit 1; fi
        [[ -f "$src" ]] || { printf 'ERROR: The specified blob does not exist.\nErrorCode:BlobNotFound\n' >&2; exit 1; }
        cp "$src" "$file" ;;
    esac ;;
  "storage container") [[ -z "\${AZ_CONTAINER_FAIL:-}" ]] || { echo "ERROR: AuthorizationPermissionMismatch" >&2; exit 1; } ;;
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
    timeout: opts.timeout || 60000,
    killSignal: opts.killSignal || 'SIGTERM',
    input: opts.input === undefined ? '' : opts.input,
    env: {
      ...process.env,
      AZ: az,
      // The shim also goes on PATH, so anything reaching for a bare `az` finds the fake too.
      PATH: `${dir}:${process.env.PATH}`,
      AZ_LOG: log,
      AZ_PAYLOAD_DIR: payloadDir,
      // The RBAC-replication poll in with-search-admin.sh sleeps for real.
      POLL_SLEEP: '0',
      // Carried into the payload rather than slept on here; a test that let the default through
      // would wait 30 s per tick on the VM's behalf.
      INDEXER_POLL_SLEEP: '0',
      DEVBOX_READY_SLEEPS: '0',
      DEVBOX_RUN_POLL_SLEEP: '0',
      ...(opts.env || {})
    }
  });

  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  // The verbatim `--scripts` value of every run-command call, before the log flattens its newlines.
  const payloads = fs.readdirSync(payloadDir).sort()
    .map(f => fs.readFileSync(path.join(payloadDir, f), 'utf8'));
  // What the fake found in the `@file` a managed create was handed, and that file's mode.
  const readState = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8').trim() : '');
  const sasSeen = readState('sas-seen');
  const sasMode = readState('sas-mode');
  const sasPath = readState('sas-path');
  fs.rmSync(dir, { recursive: true, force: true });
  // What was actually sent to the VM, one entry per run-command that carried a script.
  const remote = calls.filter(c => /^vm run-command (invoke|create) /.test(c));
  return { ...res, calls, remote, payloads, sasSeen, sasMode, sasPath };
}

/** A raw instanceView, shaped like `az vm get-instance-view --query instanceView` returns it. */
function iv({ power = 'running', agent = 'Ready', msg = 'Guest Agent is running', ext = [], handlers = [] } = {}) {
  return JSON.stringify({
    statuses: [{ code: 'ProvisioningState/succeeded' }, { code: `PowerState/${power}` }],
    vmAgent: {
      statuses: [{ code: 'ProvisioningState/succeeded', displayStatus: agent, message: msg }],
      extensionHandlers: handlers.map(([type, code]) => ({ type, status: { code } }))
    },
    extensions: ext.map(([name, code]) => (code ? { name, statuses: [{ code }] } : { name }))
  });
}

const PROD_IV = iv({
  ext: ['AzureMonitorLinuxAgent', 'AzurePolicyforLinux', 'ChangeTracking-Linux', 'MDE.Linux']
    .map(n => [n, 'ProvisioningState/succeeded']),
  handlers: [
    ['Microsoft.Azure.Monitor.AzureMonitorLinuxAgent', 'ProvisioningState/succeeded'],
    ['Microsoft.GuestConfiguration.ConfigurationforLinux', 'ProvisioningState/succeeded'],
    ['Microsoft.Azure.ChangeTrackingAndInventory.ChangeTracking-Linux', 'ProvisioningState/NotReady/1011'],
    ['Microsoft.CPlat.Core.LinuxPatchExtension', 'ProvisioningState/succeeded'],
    ['Microsoft.Azure.AzureDefenderForServers.MDE.Linux', 'ProvisioningState/succeeded'],
    ['Microsoft.CPlat.Core.RunCommandLinux', 'ProvisioningState/succeeded']
  ]
});

/** The command demi-run would receive on the VM: the `--scripts` payload with one quoting level removed. */
function innerOf(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demi-payload-'));
  const stub = path.join(dir, 'demi-run');
  const captured = path.join(dir, 'inner.sh');
  fs.writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s' "$1" > ${captured}\n`, { mode: 0o755 });
  const unwrap = spawnSync('bash', ['-c', payload.replace('sudo -u demi /usr/local/bin/demi-run', stub)],
    { encoding: 'utf8' });
  const inner = fs.existsSync(captured) ? fs.readFileSync(captured, 'utf8') : '';
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(unwrap.status, 0, unwrap.stderr);
  return inner;
}

/** Runs an unwrapped command here, in a temp dir standing in for the devbox checkout. */
function runInner(inner) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demi-checkout-'));
  const res = spawnSync('bash', ['-c', inner.replace(/^cd \/opt\/eagle-demi /, `cd ${dir} `)], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return res;
}

/** Runs the script with DEVBOX_RUNNER set to a throwaway wrapper whose body is `body`. */
function withRunner(body, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demi-runner-'));
  const runner = path.join(dir, 'runner');
  fs.writeFileSync(runner, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  const r = run(args, { env: { DEVBOX_RUNNER: runner } });
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

const creates = (calls) => calls.filter(c => c.startsWith('role assignment create'));
const deletes = (calls) => calls.filter(c => c.startsWith('role assignment delete'));

/**
 * The steps one payload carries, in the order the devbox runs them. A call is several steps now, so
 * a run reads as the flattened list of everything it did.
 */
const phases = (c) => {
  const out = [];
  if (c.includes('--check')) out.push('check');
  else if (c.includes('apply-search-definitions.js --live')) out.push('index');
  else if (c.includes('apply-search-definitions.js')) out.push('dry');
  if (c.includes('put-search-datasources.js')) out.push('datasource');
  if (c.includes('reset-and-run-indexers.js')) out.push('indexers');
  return out.length ? out : ['other'];
};

const order = (r) => r.remote.flatMap(phases);
const indexerPayload = (r) => r.payloads.find(p => p.includes('reset-and-run-indexers.js'));

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

  await t.test('a drift check is one call, and it grants and revokes around it', () => {
    const r = run(['drift']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(creates(r.calls).length, 1);
    assert.strictEqual(deletes(r.calls).length, 1, 'the grant must not outlive the check');
    // Each invoke is a 20-45 s ARM long poll, so the call count is the wall time.
    assert.strictEqual(r.remote.length, 1, `drift is one run-command call: ${r.remote.length}`);
    assert.ok(r.remote[0].includes('apply-search-definitions.js --check'));
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

  await t.test('drift over several indexes fails when any one of them drifts', () => {
    // Every name runs in one payload and every DEMI_EXIT line lands in the same output, so a
    // verdict read off that text green-lights a release whenever one index happens to be clean.
    // Both positions: whether the dirty index is checked first or last must not change the answer.
    for (const dirty of ['documents', 'projects']) {
      const clean = dirty === 'documents' ? 'projects' : 'documents';
      const r = run(['drift', '--only', 'documents,projects'], { env: { AZ_DRIFT: dirty } });
      assert.strictEqual(r.status, 1, `${dirty} drifted, so the run must fail: ${r.stdout}`);
      assert.match(r.stdout, new RegExp(`drift ${dirty}: missing fields fileSize`));
      assert.match(r.stdout, new RegExp(`ok ${clean}`),
        'the clean index still reports, it just does not decide');
      assert.match(r.stderr, /drift detected, or the check itself failed/);
      assert.strictEqual(r.remote.length, 1, 'both names ride one call');
      assert.ok(r.remote[0].includes('for n in documents projects'));
    }
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

  await t.test('apply stops before any write when one index fails its dry run', () => {
    // "always dry-runs first" has to mean all of them: a --only list that dry-runs one index clean
    // and one dirty must not PUT the clean one live. Both positions, for the same reason as the
    // drift case — the failing index is as likely to be the first step as the last.
    for (const failing of ['documents', 'projects']) {
      const r = run(['apply', '--only', 'documents,projects', '--yes'],
        { env: { AZ_DRY_FAIL: failing } });
      assert.strictEqual(r.status, 1, `${failing} failed its dry run: ${r.stdout}`);
      assert.match(r.stderr, /the dry run failed — nothing was written/);
      assert.ok(!r.stdout.includes('About to write'), 'the run must not reach the write plan');
      assert.ok(r.remote.every(c => !c.includes('--live')),
        `no index may be written: ${r.remote.filter(c => c.includes('--live')).join(' | ')}`);
      assert.strictEqual(deletes(r.calls).length, creates(r.calls).length, 'no grant left standing');
    }
  });

  await t.test('apply --yes writes in order: index, data source, indexer reset', () => {
    const r = run(['apply', '--env', 'prod', '--only', 'documents', '--yes'],
      { env: { AZ_DS_DIFFERS: '1' } });
    assert.strictEqual(r.status, 0, r.stderr);

    // The order is the whole point: an index widened without the data source fills with nulls, and
    // a reset before the PUT re-pulls the old column list. It is now the && inside one payload.
    assert.deepStrictEqual(order(r), ['dry', 'index', 'datasource', 'indexers'], order(r).join(','));

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

  await t.test('the poll settings reach the payload instead of being slept on here', () => {
    // The wait runs on the VM. If these did not travel with it, the devbox would fall back to its
    // 30 s default and this suite would really sleep through an indexer run.
    const r = run(['apply', '--env', 'prod', '--only', 'documents', '--yes'],
      { env: { AZ_DS_DIFFERS: '1' } });
    assert.strictEqual(r.status, 0, r.stderr);
    const payload = indexerPayload(r);
    // `\S*` around each value: the payload carries it single-quoted twice over.
    assert.match(payload, /DEMI_POLL_SLEEP=\S*0\S/);
    assert.match(payload, /DEMI_TIMEOUT=\S*1800\S/);
    assert.match(payload, /DEMI_MODE=\S*reset\S/);
    assert.match(payload, /reset-and-run-indexers\.js documents-indexer/);
    // What the VM printed is what the operator sees, poll lines included.
    assert.match(r.stdout, /DEMI_POLL documents-indexer inProgress items=0/);
  });

  await t.test('an apply stays inside four run-command calls', () => {
    // Each invoke is a 20-45 s ARM long poll. A call per index plus a call per 30 s poll is what
    // made a 360-row index take an hour and then miss its own 30-minute deadline.
    const r = run(['apply', '--env', 'prod', '--only', 'documents,projects', '--yes'],
      { env: { AZ_DS_DIFFERS: '1' } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.payloads.length <= 4, `an apply must stay under four calls, got ${r.payloads.length}`);
  });

  await t.test('apply skips the data source and the reset when nothing differs', () => {
    const r = run(['apply', '--only', 'documents', '--yes']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /no data source differs, so no indexer reset/);
    assert.ok(r.remote.every(c => !c.includes('put-search-datasources') && !c.includes('reset-and-run-indexers')),
      'a reset re-pulls every row; it happens only when a projection actually changed');
  });

  await t.test('--datasources PUTs the named data sources before the dry run', () => {
    // A new indexer's data source does not exist yet, so the dry run refuses on the missing name
    // and the write phase that would have created it is never reached. The pre-create step is the
    // only way in, and it has to land ahead of the dry run to be any use.
    const r = run(['apply', '--only', 'activities', '--datasources', 'demi-updates-ds,demi-notifications-ds', '--yes']);
    assert.strictEqual(r.status, 0, r.stderr);

    // The second data source PUT is the writing half: a pre-created name is equal to the committed
    // copy by the time the dry run reads it, so it can only reach the reset by being carried there.
    assert.deepStrictEqual(order(r),
      ['datasource', 'dry', 'index', 'datasource', 'indexers'], order(r).join(','));
    assert.match(r.stdout, /reset and run indexer\(s\): activities-indexer,project-notifications-indexer/);
    // Both indexers ride the one call, in the order their data sources were named.
    assert.match(indexerPayload(r),
      /reset-and-run-indexers\.js activities-indexer project-notifications-indexer/);

    const ds = r.remote.find(c => c.includes('put-search-datasources.js'));
    assert.match(ds, /cp azure\/search\/datasources\/demi-updates-ds\.json azure\/search\/datasources\/demi-notifications-ds\.json \/tmp\/demi-ds\//);
    assert.ok(!ds.includes('demi-chunks-ds'), 'only the named data sources are written');
    // Without the pull, a data source added in this commit is not in the devbox checkout yet: the
    // dry run used to be the step that refreshed it, and this one runs before the dry run.
    assert.match(ds, /git pull --ff-only && \{ rm -rf \/tmp\/demi-ds/);
    assert.match(r.stdout, /pre-created data source\(s\): demi-updates-ds,demi-notifications-ds/);
    assert.strictEqual(deletes(r.calls).length, creates(r.calls).length, 'no grant left standing');
  });

  await t.test('a data source named by --datasources is reset even when nothing DIFFERS', () => {
    // The pre-create makes the live data source equal to the committed one, so the dry run has
    // nothing left to report on it. Taking the reset list from DIFFERS alone would leave
    // documents-indexer on its old high-water mark: every row it already holds keeps the new
    // column null, and no step of the run fails.
    const r = run(['apply', '--only', 'documents', '--datasources', 'demi-documents-ds', '--yes']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes('no data source differs'), r.stdout);
    assert.match(r.stdout, /PUT data source\(s\): demi-documents-ds/);
    assert.match(r.stdout, /reset and run indexer\(s\): documents-indexer/);
    assert.deepStrictEqual(order(r),
      ['datasource', 'dry', 'index', 'datasource', 'indexers'], order(r).join(','));
    assert.match(r.stdout, /documents-indexer finished, 61587 processed/);
    assert.strictEqual(deletes(r.calls).length, creates(r.calls).length, 'no grant left standing');

    // Named AND reported as differing is one data source, not two: a repeated name would reset the
    // same indexer twice and re-pull everything a second time.
    const both = run(['apply', '--only', 'documents', '--datasources', 'demi-documents-ds', '--yes'],
      { env: { AZ_DS_DIFFERS: '1' } });
    assert.strictEqual(both.status, 0, both.stderr);
    assert.match(both.stdout, /PUT data source\(s\): demi-documents-ds\n/);
    assert.match(both.stdout, /reset and run indexer\(s\): documents-indexer\n/);
    assert.match(indexerPayload(both), /reset-and-run-indexers\.js documents-indexer\n/);
  });

  await t.test('--datasources asks before its own PUT, and a no writes nothing', () => {
    // This PUT lands before the plan and its prompt, so it needs a prompt of its own: otherwise
    // "aborted — nothing was written" is printed after data sources are already on the service.
    const r = run(['apply', '--only', 'activities', '--datasources', 'demi-updates-ds'],
      { input: '\n' });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /will PUT data source\(s\) demi-updates-ds before the dry run/);
    assert.match(r.stderr, /aborted — nothing was written/);
    assert.deepStrictEqual(r.remote, [], 'the devbox is not reached at all before the answer');
    assert.strictEqual(creates(r.calls).length, 0, 'no grant is taken for a run that stops here');
  });

  await t.test('refuses to reset an indexer whose last execution is still running', () => {
    // A PT5M tick already in flight writes its old high-water mark back when it finishes, undoing
    // the clear. The run that follows then reports 0 rows and reads like a broken reset.
    const r = run(['apply', '--only', 'documents', '--yes'],
      { env: { AZ_DS_DIFFERS: '1', AZ_INDEXER_INPROGRESS: '1' } });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /documents-indexer is running now/);
    assert.ok(!r.stdout.includes('DEMI_RESET '), 'the reset must not have been posted');
    assert.strictEqual(deletes(r.calls).length, creates(r.calls).length);
  });

  await t.test('--no-wait stops after the run is posted and names the follow-up', () => {
    // chunks takes hours and run-command gives up after 90 minutes, so the only way to start it is
    // to stop waiting — which also closes the role grant in seconds instead of hours.
    const r = run(['apply', '--env', 'prod', '--only', 'chunks', '--datasources', 'demi-chunks-ds',
      '--yes', '--no-wait']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(indexerPayload(r), /DEMI_NO_WAIT=\S*1\S/);
    assert.match(r.stdout, /DEMI_NOWAIT chunks-indexer/);
    assert.ok(!r.stdout.includes('finished,'), 'nothing finished; the run was only posted');
    assert.match(r.stdout,
      /scripts\/demi-devbox\.sh watch --env prod --datasources demi-chunks-ds/,
      'the operator needs the command that picks the wait back up');
    assert.strictEqual(deletes(r.calls).length, creates(r.calls).length, 'the grant is given back');
  });

  await t.test('chunks-indexer gets the long deadline', () => {
    // 1.1M rows do not finish in the 30 minutes everything else gets, and the old deadline failed
    // the run instead of reporting it was still going.
    const r = run(['apply', '--env', 'prod', '--only', 'chunks', '--datasources', 'demi-chunks-ds',
      '--yes']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(indexerPayload(r), /DEMI_TIMEOUT=\S*4800\S/);
    assert.match(r.stdout, /gives\s+up after 80 minutes/,
      'the plan warns that a wait this long cannot finish inside one call');
  });

  await t.test('an indexer still running at the deadline is a warning, not a failure', () => {
    // The run was posted and the indexer is working. Exiting 1 there is what killed the chunks
    // chain: it read as "the apply failed" when nothing had.
    const r = run(['apply', '--env', 'prod', '--only', 'chunks', '--datasources', 'demi-chunks-ds',
      '--yes'], { env: { AZ_INDEXER_OUTCOME: 'warn' } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /chunks-indexer still running after 4800s/);
    assert.ok(!r.stdout.includes('finished,'), 'it has not finished, and must not say it did');
  });

  await t.test('a reset that did not take fails the run', () => {
    // An execution that kept its old high-water mark re-pulls nothing, so every new field stays
    // null and the apply looks like it worked.
    const r = run(['apply', '--only', 'documents', '--datasources', 'demi-documents-ds', '--yes'],
      { env: { AZ_INDEXER_OUTCOME: 'notreset' } });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /the reset did not take/);
    assert.strictEqual(deletes(r.calls).length, creates(r.calls).length);
  });

  await t.test('an indexer run that ends in a failure status exits non-zero', () => {
    const r = run(['apply', '--only', 'documents', '--datasources', 'demi-documents-ds', '--yes'],
      { env: { AZ_INDEXER_OUTCOME: 'failure' } });
    assert.strictEqual(r.status, 1);
    assert.match(r.stdout, /DEMI_FAIL documents-indexer ended transientFailure/);
    assert.match(r.stderr, /reset and run of documents-indexer failed/);
  });

  await t.test('a 409 on the run is not a failure', () => {
    // The indexer was already going. reset-and-run-indexers.js decides whether that execution is
    // the one asked for; what is pinned here is that the status alone does not fail the apply.
    const r = run(['apply', '--only', 'documents', '--datasources', 'demi-documents-ds', '--yes'],
      { env: { AZ_RUN_STATUS: '409' } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /documents-indexer finished, 61587 processed/);
  });

  await t.test('watch waits without resetting anything', () => {
    const r = run(['watch', '--env', 'prod', '--datasources', 'demi-chunks-ds']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(indexerPayload(r), /DEMI_MODE=\S*watch\S/);
    assert.match(indexerPayload(r), /reset-and-run-indexers\.js chunks-indexer/);
    assert.ok(r.remote.every(c => !c.includes('--live') && !c.includes('put-search-datasources')),
      'watch writes nothing');

    const bare = run(['watch', '--env', 'prod']);
    assert.strictEqual(bare.status, 1);
    assert.match(bare.stderr, /watch needs --datasources/);
  });

  await t.test('--only reaches the devbox and nothing else does', () => {
    const r = run(['drift', '--only', 'projects']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.remote.some(c => c.includes('for n in projects')));
  });

  await t.test('every payload sent to the VM is valid bash at both quoting levels', () => {
    // Nothing here parses these before the VM does. The command is built on this machine, quoted
    // into `demi-run '...'`, quoted again into `--scripts "..."`, and it carries loops, braces and
    // env assignments — a quoting bug arrives as a shell error 60 seconds later on a box with a
    // live role grant open.
    const r = run(['apply', '--env', 'prod', '--only', 'documents', '--yes'],
      { env: { AZ_DS_DIFFERS: '1' } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.payloads.length, 3,
      `dry, write, indexers — one call each, got ${r.payloads.length}`);

    for (const payload of r.payloads) {
      const outerCheck = spawnSync('bash', ['-n', '-c', payload], { encoding: 'utf8' });
      assert.strictEqual(outerCheck.status, 0, `--scripts is not valid bash: ${outerCheck.stderr}\n${payload}`);

      // Unwrap it the way the VM does, then check the command that actually runs.
      const inner = innerOf(payload);
      const innerCheck = spawnSync('bash', ['-n', '-c', inner], { encoding: 'utf8' });
      assert.strictEqual(innerCheck.status, 0, `the command demi-run receives is not valid bash: ${innerCheck.stderr}\n${inner}`);
      assert.match(inner, /^cd \/opt\/eagle-demi &&/, 'every command runs in the checkout');
      assert.match(inner, /echo DEMI_EXIT=\$\?$/, 'every command must carry its exit code back');
    }
  });

  const firstIndex = (calls, prefix) => calls.findIndex(c => c.startsWith(prefix));
  const lastIndex = (calls, prefix) => calls.map(c => c.startsWith(prefix)).lastIndexOf(true);
  const named = (calls, verb) => calls.filter(c => c.startsWith(`vm run-command ${verb} `))
    .map(c => / --name (\S+)/.exec(c)[1]);
  const checks = (r) => r.calls.filter(c => c.startsWith('vm get-instance-view')).length;
  const starts = (r) => r.calls.filter(c => c.startsWith('vm start'));
  const NOT_READY = iv({ agent: 'Not Ready', msg: 'VM status blob is found but not yet populated.' });
  const MANAGED = { DEVBOX_RUN_MODE: 'managed' };

  await t.test('waits for the VM agent before the first command', () => {
    // A run-command posted while the agent is still busy with extensions queues behind them.
    const r = run(['drift'], { env: { AZ_IV: NOT_READY, AZ_READY_AFTER: '2' } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(checks(r), 3);
    assert.ok(lastIndex(r.calls, 'vm get-instance-view') < firstIndex(r.calls, 'vm run-command invoke'),
      'no command may be posted before the agent is Ready');
    assert.match(r.stderr, /waiting for demi-devbox-test: power=running agent=Not Ready/);
  });

  await t.test('keeps waiting while an extension is transitioning, even with the agent Ready', () => {
    const r = run(['drift'], {
      env: { AZ_IV: iv({ ext: [['ChangeTracking-Linux', 'ProvisioningState/transitioning']] }), AZ_READY_AFTER: '1' }
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(checks(r), 2);
    assert.match(r.stderr, /agent=Ready .*extensions busy: ChangeTracking-Linux/);
  });

  await t.test('a failed extension does not block, whatever its case, and is named', () => {
    // A failed handler never settles; waiting on it would hold every run for the full cap.
    const r = run(['drift'], {
      env: { AZ_IV: iv({ ext: [['ChangeTracking-Linux', 'ProvisioningState/Failed/1011']] }), AZ_READY_AFTER: '99' }
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(checks(r), 1);
    assert.match(r.stderr, /ignoring failed or NotReady on demi-devbox-test: ChangeTracking-Linux/);
  });

  await t.test('an extension with no status yet does not block', () => {
    const r = run(['drift'], { env: { AZ_IV: iv({ ext: [['MDE.Linux']] }), AZ_READY_AFTER: '99' } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(checks(r), 1);
  });

  await t.test('the prod devbox shape passes once its agent is Ready', () => {
    // Read from demi-devbox-prod on 2026-10-01: every extension succeeded, the ChangeTracking
    // handler stuck at NotReady/1011.
    const r = run(['drift', '--env', 'prod'], { env: { AZ_IV: PROD_IV, AZ_READY_AFTER: '99' } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(checks(r), 1);
    assert.match(r.stderr,
      /ignoring failed or NotReady on demi-devbox-prod: Microsoft\.Azure\.ChangeTrackingAndInventory\.ChangeTracking-Linux/);
  });

  await t.test('checks the agent before the grant, and not again inside it', () => {
    // A check under the grant would hold the role open while waiting.
    const r = run(['drift']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(checks(r), 1);
    assert.ok(firstIndex(r.calls, 'vm get-instance-view') < firstIndex(r.calls, 'role assignment create'));
  });

  await t.test('apply checks the agent again after its prompt', () => {
    // The prompt can sit unanswered long enough for the agent to pick up new extension work.
    const r = run(['apply', '--only', 'documents'], { env: { AZ_DS_DIFFERS: '1' }, input: 'y\n' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(checks(r), 2);
    assert.ok(lastIndex(r.calls, 'vm get-instance-view') > firstIndex(r.calls, 'vm run-command invoke'),
      'the second check comes after the dry run, before the write');
  });

  await t.test('gives up on an agent that never settles and names what blocked it', () => {
    const r = run(['drift', '--env', 'prod'], {
      env: {
        AZ_IV: iv({ agent: 'Not Ready', msg: 'VM status blob is found but not yet populated.',
          ext: [['ChangeTracking-Linux', 'ProvisioningState/transitioning']] }),
        AZ_READY_AFTER: '99',
        DEVBOX_READY_TIMEOUT: '0'
      }
    });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /demi-devbox-prod not ready after 0s/);
    assert.match(r.stderr, /agent=Not Ready \(VM status blob is found but not yet populated\.\)/);
    assert.match(r.stderr, /extensions busy: ChangeTracking-Linux/);
    assert.deepStrictEqual(r.remote, [], 'nothing may be posted to a box that is not ready');
    assert.deepStrictEqual(creates(r.calls), [], 'no grant is taken for a run that stops here');
  });

  await t.test('stops at once when the instance view cannot be read', () => {
    const r = run(['drift'], { env: { AZ_IV_FAIL: '1' } });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /AuthorizationFailed/);
    assert.match(r.stderr, /could not read the instance view of demi-devbox-test/);
    assert.strictEqual(checks(r), 1, 'an az error is not retried for 20 minutes');
    assert.deepStrictEqual(r.remote, []);
  });

  await t.test('leaves a running VM alone while its agent settles', () => {
    const r = run(['drift'], { env: { AZ_IV: NOT_READY, AZ_READY_AFTER: '1' } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(starts(r), []);
  });

  await t.test('starts a stopped VM once, without blocking on the start', () => {
    const r = run(['drift'], { env: { AZ_IV: iv({ power: 'stopped', agent: 'none' }), AZ_READY_AFTER: '3' } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(starts(r).length, 1, starts(r).join('\n'));
    assert.match(starts(r)[0], /--no-wait/, 'the ready loop is the bound, not the start call');
  });

  await t.test('does not post a start while one is already in flight', () => {
    const r = run(['drift'], { env: { AZ_IV: iv({ power: 'starting', agent: 'none' }), AZ_READY_AFTER: '2' } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(starts(r), []);
  });

  await t.test('does not post a start while the VM is deallocating', () => {
    const r = run(['drift'], { env: { AZ_IV: iv({ power: 'deallocating', agent: 'none' }), AZ_READY_AFTER: '2' } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(starts(r), []);
  });

  await t.test('says so when a posted start does not take', () => {
    const r = run(['drift'], {
      env: { AZ_IV: iv({ power: 'deallocated', agent: 'none' }), AZ_READY_AFTER: '99', DEVBOX_START_GRACE: '0' }
    });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /demi-devbox-test is still deallocated 0s after the start was posted: the start did not take/);
    assert.strictEqual(starts(r).length, 1);
    assert.deepStrictEqual(r.remote, []);
  });

  await t.test('runs through invoke unless managed mode is asked for', () => {
    const r = run(['drift']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.remote.length, 1);
    assert.match(r.remote[0], /^vm run-command invoke .*--command-id RunShellScript/);
    assert.ok(r.calls.every(c => !c.startsWith('storage ')), 'invoke needs no output storage');
  });

  await t.test('managed run prints the whole output and exits with the remote exit code', () => {
    // Action run-command cuts output at 4 KB; a managed one writes all of it to a blob.
    const r = run(['run', '--', 'seq 1 3000'],
      { env: { ...MANAGED, AZ_RUN_LINES: '3000', AZ_RUN_EXIT: '3' } });
    assert.strictEqual(r.status, 3, r.stderr);
    assert.ok(r.stdout.length > 4096, `got ${r.stdout.length} bytes`);
    assert.match(r.stdout, /^1$/m);
    assert.match(r.stdout, /^3000$/m);
    assert.match(r.payloads[0], /seq 1 3000/);
    assert.match(r.remote[0], /--async-execution true/);
  });

  await t.test('a managed run under a role grant stops at 90 minutes, a plain run at 4 hours', () => {
    // The grant stays open for as long as the client waits, so it must not inherit run's 4 hours.
    const granted = run(['drift'], { env: MANAGED });
    assert.strictEqual(granted.status, 0, granted.stderr);
    assert.match(granted.remote[0], /--timeout-in-seconds 5400 /);
    const plain = run(['run', '--', 'true'], { env: { ...MANAGED, AZ_RUN_LINES: '1' } });
    assert.match(plain.remote[0], /--timeout-in-seconds 14400 /);
  });

  await t.test('managed run prints the remote stderr', () => {
    const r = run(['run', '--', 'true'], { env: { ...MANAGED, AZ_STDERR_TEXT: 'warning from node' } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /warning from node/);
  });

  await t.test('waits for the run to finish before reading its output', () => {
    const r = run(['drift'], { env: { ...MANAGED, AZ_PENDING_POLLS: '2' } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.calls.filter(c => c.startsWith('vm run-command show')).length, 3);
    assert.ok(lastIndex(r.calls, 'vm run-command show') < firstIndex(r.calls, 'storage blob download'));
  });

  await t.test('a run command whose provisioning was canceled ends the wait', () => {
    const r = run(['drift'], { env: { ...MANAGED, AZ_PROV_STATE: 'Canceled', AZ_EXEC_STATE: 'Pending' } });
    assert.strictEqual(r.status, 1);
    assert.strictEqual(r.calls.filter(c => c.startsWith('vm run-command show')).length, 1);
  });

  await t.test('deletes the run-command resource and its blobs after a run that succeeded', () => {
    // A VM holds at most 25 managed run commands.
    const r = run(['drift'], { env: MANAGED });
    assert.strictEqual(r.status, 0, r.stderr);
    const [name] = named(r.calls, 'create');
    assert.deepStrictEqual(named(r.calls, 'delete'), [name]);
    assert.match(r.calls.find(c => c.startsWith('vm run-command delete')), /--no-wait/);
    assert.ok(r.calls.some(c => c.startsWith('storage blob delete-batch') && c.includes(`--pattern ${name}/*`)));
    assert.ok(!r.stderr.includes('may reappear'), r.stderr);
  });

  await t.test('deletes the run-command resource after a run that failed', () => {
    const r = run(['drift'], { env: { ...MANAGED, AZ_EXEC_STATE: 'Failed' } });
    assert.strictEqual(r.status, 1);
    assert.strictEqual(named(r.calls, 'create').length, 1);
    assert.deepStrictEqual(named(r.calls, 'delete'), named(r.calls, 'create'));
  });

  await t.test('a run still going at the deadline is deleted, and its blobs may come back', () => {
    const r = run(['drift'], { env: { ...MANAGED, AZ_RUNNING_POLLS: '99', DEVBOX_RUN_TIMEOUT: '0' } });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /still running 0s after it started; deleting it/);
    assert.deepStrictEqual(named(r.calls, 'delete'), named(r.calls, 'create'));
    // The script on the VM can still append through its SAS after the blobs are deleted.
    assert.match(r.stderr, /may reappear until \d{4}-\d\d-\d\dT\d\d:\d\dZ/);
  });

  await t.test('time in the agent queue does not count against the run deadline', () => {
    // On prod a create waits 15-31 minutes before its script starts.
    const r = run(['drift'], {
      // About 6 s queued against a 1 s run timeout plus 3 s of grace.
      env: { ...MANAGED, AZ_PENDING_POLLS: '6', DEVBOX_RUN_POLL_SLEEP: '1', DEVBOX_RUN_TIMEOUT: '1', DEVBOX_READY_TIMEOUT: '0' }
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /ok documents/);
  });

  await t.test('a run that never leaves the queue is deleted and says it never started', () => {
    const r = run(['drift'], { env: { ...MANAGED, AZ_PENDING_POLLS: '99', DEVBOX_QUEUE_TIMEOUT: '0' } });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /never started: still 'creating pending' after 0s in the VM agent's queue/);
    assert.deepStrictEqual(named(r.calls, 'delete'), named(r.calls, 'create'));
  });

  await t.test('an interrupt during create removes the SAS file, the run command and the blobs', () => {
    const r = run(['run', '--', 'true'], {
      env: { ...MANAGED, AZ_CREATE_SLEEP: '4' }, timeout: 1500, killSignal: 'SIGTERM'
    });
    assert.strictEqual(r.status, 143, `${r.signal} ${r.stderr}`);
    const [name] = named(r.calls, 'create');
    assert.deepStrictEqual(named(r.calls, 'delete'), [name]);
    assert.ok(r.calls.some(c => c.startsWith('storage blob delete-batch') && c.includes(`--pattern ${name}/*`)));
    assert.ok(r.sasPath && !fs.existsSync(r.sasPath), `SAS file left at ${r.sasPath}`);
  });

  await t.test('a failed create shows its error code, never the SAS it echoes', () => {
    const r = run(['run', '--', 'true'], { env: { ...MANAGED, AZ_CREATE_FAIL: '1' } });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /run-command create failed \(\(AuthorizationFailed\)\)/);
    assert.ok(!r.stderr.includes('FAKESIG') && !r.stdout.includes('FAKESIG'), r.stderr);
  });

  await t.test('cleanup after a failed create says nothing about the run command that was never made', () => {
    const r = run(['run', '--', 'true'], { env: { ...MANAGED, AZ_CREATE_FAIL: '1', AZ_DELETE_NOTFOUND: '1' } });
    assert.strictEqual(r.status, 1);
    assert.strictEqual(named(r.calls, 'delete').length, 1);
    assert.ok(!r.stderr.includes('could not delete run-command'), r.stderr);
  });

  await t.test('a failed output download keeps the blobs and says where they are', () => {
    const r = run(['drift'], { env: { ...MANAGED, AZ_DOWNLOAD_FAIL: '1' } });
    assert.strictEqual(r.status, 1);
    const [name] = named(r.calls, 'create');
    assert.match(r.stderr, new RegExp(`could not download demifctestfake/devbox-run-output/${name}/stdout; the blobs are kept`));
    assert.match(r.stderr, /AuthorizationFailure/);
    assert.ok(!r.stderr.includes('no output blob'), r.stderr);
    assert.ok(r.calls.every(c => !c.startsWith('storage blob delete-batch')), 'the output may still be there');
    assert.deepStrictEqual(named(r.calls, 'delete'), [name]);
  });

  await t.test('an interrupted run deletes its run-command resource', () => {
    const r = run(['run', '--', 'true'], {
      env: { ...MANAGED, AZ_PENDING_POLLS: '1000000' }, timeout: 3000, killSignal: 'SIGTERM'
    });
    assert.strictEqual(r.status, 143, `${r.signal} ${r.stderr}`);
    assert.strictEqual(named(r.calls, 'create').length, 1);
    assert.deepStrictEqual(named(r.calls, 'delete'), named(r.calls, 'create'));
  });

  await t.test('a missing output blob fails the run and names the role, without the SAS', () => {
    // The VM writes through a SAS that carries only the operator's own blob roles.
    const r = run(['drift'], { env: { ...MANAGED, AZ_NO_BLOB: '1', AZ_EXEC_STATE: 'Failed' } });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr,
      /no output blob for demi-run-\S+ \(StatusCode=403, ErrorCode=AuthorizationPermissionMismatch\)/);
    assert.match(r.stderr, /Storage Blob Data Contributor on demifctestfake/);
    assert.ok(!r.stderr.includes('FAKESIG'), 'the storage error echoes query parameters');
    assert.deepStrictEqual(named(r.calls, 'delete'), named(r.calls, 'create'));
    assert.ok(r.calls.some(c => c.startsWith('storage blob delete-batch')), 'a missing blob leaves nothing to keep');
  });

  await t.test('a missing output blob for another reason names no role', () => {
    const r = run(['drift'], {
      env: { ...MANAGED, AZ_NO_BLOB: '1', AZ_EXEC_STATE: 'Failed',
        AZ_EXEC_MESSAGE: 'Execution failed: StatusCode=404, ErrorCode=ContainerNotFound' }
    });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /\(StatusCode=404, ErrorCode=ContainerNotFound\)/);
    assert.ok(!r.stderr.includes('Storage Blob Data Contributor'), r.stderr);
  });

  await t.test('the SAS reaches az through a 0600 file, never argv or the terminal', () => {
    const r = run(['run', '--', 'true'], { env: { ...MANAGED, AZ_RUN_LINES: '1' } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.remote[0], /--output-blob-uri @\S+ --error-blob-uri @\S+/);
    assert.match(r.sasSeen, /sig=FAKESIG/, 'the file az read held the SAS');
    assert.strictEqual(r.sasMode, '600');
    assert.ok(r.calls.every(c => !c.includes('FAKESIG')), 'no az argv may carry it');
    assert.ok(!r.stdout.includes('FAKESIG') && !r.stderr.includes('FAKESIG'));
  });

  await t.test('the SAS is write-only and outlives the run by a margin', () => {
    const t0 = Date.now();
    const r = run(['run', '--', 'true'],
      { env: { ...MANAGED, AZ_RUN_LINES: '1', DEVBOX_RUN_TIMEOUT: '7200', DEVBOX_QUEUE_TIMEOUT: '1200' } });
    assert.strictEqual(r.status, 0, r.stderr);
    const sas = r.calls.find(c => c.startsWith('storage blob generate-sas'));
    assert.match(sas, /--permissions acw /);
    const expiry = Date.parse(/--expiry (\S+)/.exec(sas)[1]);
    const want = t0 + (7200 + 1200 + 600) * 1000;
    assert.ok(Math.abs(expiry - want) < 120000, `expiry ${new Date(expiry).toISOString()}`);
  });

  await t.test('the SAS lifetime stops at the 7 day user-delegation limit', () => {
    const t0 = Date.now();
    const r = run(['run', '--', 'true'], { env: { ...MANAGED, AZ_RUN_LINES: '1', DEVBOX_RUN_TIMEOUT: '9999999' } });
    assert.strictEqual(r.status, 0, r.stderr);
    const expiry = Date.parse(/--expiry (\S+)/.exec(r.calls.find(c => c.startsWith('storage blob generate-sas')))[1]);
    assert.ok(expiry <= t0 + 7 * 86400 * 1000 + 60000, new Date(expiry).toISOString());
  });

  await t.test('a container that cannot be created stops the run before anything is posted', () => {
    const r = run(['drift'], { env: { ...MANAGED, AZ_CONTAINER_FAIL: '1' } });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /could not create container devbox-run-output on demifctestfake: .*Storage Blob Data Contributor/);
    assert.deepStrictEqual(r.remote, []);
    assert.deepStrictEqual(creates(r.calls), [], 'no grant either');
  });

  await t.test('refuses an unknown DEVBOX_RUN_MODE and names the valid ones', () => {
    const r = run(['drift'], { env: { DEVBOX_RUN_MODE: 'ssh' } });
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /unknown DEVBOX_RUN_MODE 'ssh', want invoke\|managed/);
    assert.deepStrictEqual(r.calls, []);
  });

  await t.test('refuses timing settings that are not whole seconds', () => {
    const sleeps = run(['drift'], { env: { DEVBOX_READY_SLEEPS: '5 soon' } });
    assert.strictEqual(sleeps.status, 2);
    assert.match(sleeps.stderr, /DEVBOX_READY_SLEEPS must be seconds/);
    const timeout = run(['drift'], { env: { DEVBOX_RUN_TIMEOUT: '1h' } });
    assert.strictEqual(timeout.status, 2);
    assert.match(timeout.stderr, /DEVBOX_RUN_TIMEOUT must be a whole number of seconds, got '1h'/);
  });

  await t.test('run needs a command', () => {
    const r = run(['run']);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /run needs a command after --/);
    assert.deepStrictEqual(r.calls, []);
  });

  await t.test('run takes no search flags, and the search actions take no command', () => {
    const flagged = run(['run', '--only', 'documents', '--', 'true']);
    assert.strictEqual(flagged.status, 2);
    assert.match(flagged.stderr, /run takes only --env and -- <command>/);
    const commanded = run(['drift', '--', 'true']);
    assert.strictEqual(commanded.status, 2);
    assert.match(commanded.stderr, /-- <command> belongs to run, not drift/);
  });

  await t.test('run says the output was lost when no exit code comes back', () => {
    const r = run(['run', '--', 'true'], { env: { AZ_NO_EXIT_LINE: '1' } });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /no DEMI_EXIT line came back from demi-devbox-test: the command may have run, but its output was lost/);
  });

  await t.test('run keeps each argument intact on the VM', () => {
    const r = run(['run', '--', 'printf', '%s|', 'a', 'c d']);
    assert.strictEqual(r.status, 0, r.stderr);
    const ran = runInner(innerOf(r.payloads[0]));
    assert.match(ran.stdout, /^a\|c d\|/);
  });

  await t.test('a trailing & or a # comment does not break the wrapper', () => {
    const comment = runInner(innerOf(run(['run', '--', 'echo hi # note']).payloads[0]));
    assert.match(comment.stdout, /^hi\nDEMI_EXIT=0$/m);
    const background = runInner(innerOf(run(['run', '--', 'true &']).payloads[0]));
    assert.match(background.stdout, /DEMI_EXIT=0/, background.stderr);
  });

  await t.test('DEVBOX_RUNNER replaces every az call to the VM', () => {
    const r = withRunner('echo "from runner"; echo DEMI_EXIT=0', ['run', '--', 'true']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /from runner/);
    assert.ok(r.calls.every(c => !c.startsWith('vm ') && !c.startsWith('storage ')), r.calls.join('\n'));
  });

  await t.test('a failing DEVBOX_RUNNER still shows what it printed', () => {
    const r = withRunner('echo "partial output"; exit 5', ['drift']);
    assert.strictEqual(r.status, 1);
    assert.match(r.stdout, /partial output/);
    assert.match(r.stderr, /DEVBOX_RUNNER exited 5/);
  });

  await t.test('refuses a DEVBOX_RUNNER that is this script', () => {
    const r = run(['run', '--', 'true'], { env: { DEVBOX_RUNNER: SCRIPT } });
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /DEVBOX_RUNNER points at this script/);
  });

  await t.test('the re-entrant phases refuse to run outside a grant', () => {
    // They exist so ONE grant covers the apply and its wait; typed by hand they would run
    // ungranted and 403 on the devbox.
    for (const action of ['__apply-run', '__watch-run']) {
      const r = run([action, '--env', 'test']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /internal; use drift or apply/);
    }
  });
});
