'use strict';

// The fake devbox runs any payload without a scripted reply here, with fake `az` and `node` on
// PATH, so the VM-side pid, boot id and secret guards run for real.

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'reseed-test.sh');
const TEST_SUB = '7897ceb1-9a86-4639-87d7-7f9ff67142b3';
const SECRET = 'fake-secret-value-7f3a';
// 10:00 and 18:00 Pacific daylight time.
const MORNING = Date.UTC(2026, 9, 28, 17, 0, 0) / 1000;
const LATE = Date.UTC(2026, 9, 29, 1, 0, 0) / 1000;
const ALL_SEED = 'A1,A4,A7,A9';
const BOOT_ID = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();

const FAKE_DEVBOX = `#!/usr/bin/env bash
state="$FAKE_DIR"
n=$(( $(cat "$state/calls" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$state/calls"
payload=""; head=(); seen=""
for a in "$@"; do
  if [[ -n "$seen" ]]; then payload="$a"; else head+=("$a"); fi
  [[ "$a" == "--" ]] && seen=1
done
printf 'CALL %s argv=%s keep=%s checkout=%s\\n' "$n" "\${head[*]}" "\${DEVBOX_KEEP_RUNNING-unset}" "\${DEVBOX_CHECKOUT-unset}" >> "$state/devbox.log"
printf '%s' "$payload" > "$state/payload-$n"
if [[ -f "$state/reply-$n" ]]; then
  cat "$state/reply-$n"
  exit "$(cat "$state/exit-$n" 2>/dev/null || echo 0)"
fi
cd "$FAKE_CHECKOUT" && PATH="$FAKE_REMOTE_BIN:$PATH" bash -c "{
$payload
}; echo DEMI_EXIT=\\$?" 2>&1
`;

const FAKE_REMOTE_AZ = `#!/usr/bin/env bash
[[ "$1 $2" == "keyvault secret" ]] && printf '%s\\n' "$FAKE_SECRET"
exit 0
`;

const FAKE_NODE = `#!/usr/bin/env bash
{ printf 'NODE'; printf ' %s' "$@"; printf ' secret=%s\\n' "\${TRACK_CLIENT_SECRET:+set}"; } >> "$FAKE_DIR/node.log"
prev=""
for a in "$@"; do [[ "$prev" == --summary ]] && printf '{}' > "$a"; prev="$a"; done
exit 0
`;

const FAKE_AZ = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DIR/az.log"
case "$1 $2" in
  "resource list") echo c4b0a8-test-rg ;;
  "vm get-instance-view") echo "\${FAKE_POWER:-PowerState/running}" ;;
esac
exit 0
`;

const FAKE_PUBLIC_CHECK = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DIR/public-check.log"
exit 0
`;

const FAKE_CURL = `#!/usr/bin/env bash
exit 7
`;

function writeExec(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

/** One sandbox per test: run dir r1, fakes, logs. */
function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reseed-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remoteBin = path.join(dir, 'remote-bin');
  const localBin = path.join(dir, 'local-bin');
  const checkout = path.join(dir, 'checkout');
  for (const d of [remoteBin, localBin, checkout, path.join(dir, 'state', 'r1')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  writeExec(path.join(dir, 'demi-devbox.sh'), FAKE_DEVBOX);
  writeExec(path.join(dir, 'az'), FAKE_AZ);
  writeExec(path.join(dir, 'public-check'), FAKE_PUBLIC_CHECK);
  writeExec(path.join(remoteBin, 'az'), FAKE_REMOTE_AZ);
  writeExec(path.join(remoteBin, 'node'), FAKE_NODE);
  writeExec(path.join(localBin, 'curl'), FAKE_CURL);

  const baseEnv = {
    PATH: `${localBin}:${process.env.PATH}`,
    HOME: dir,
    USER: 'operator',
    DEMI_DEVBOX: path.join(dir, 'demi-devbox.sh'),
    AZ: path.join(dir, 'az'),
    PUBLIC_CHECK: path.join(dir, 'public-check'),
    RESEED_STATE: path.join(dir, 'state'),
    RESEED_VM_ROOT: path.join(dir, 'vm'),
    RESEED_NOW: String(MORNING),
    RESEED_PAUSE: '0',
    FAKE_DIR: dir,
    FAKE_CHECKOUT: checkout,
    FAKE_REMOTE_BIN: remoteBin,
    FAKE_SECRET: SECRET
  };
  const read = name => {
    const file = path.join(dir, name);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  };
  const calls = () => read('devbox.log').split('\n').filter(Boolean);
  const ctx = {
    dir,
    run(args, env = {}) {
      const r = spawnSync('bash', [SCRIPT, ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8' });
      return { status: r.status, out: r.stdout + r.stderr };
    },
    calls,
    payloads: () => calls().map((_, i) => read(`payload-${i + 1}`)),
    read,
    /** Scripted answer for the next devbox call plus `offset`. */
    reply(text, { exit = 0, offset = 0 } = {}) {
      const n = calls().length + 1 + offset;
      fs.writeFileSync(path.join(dir, `reply-${n}`), text);
      fs.writeFileSync(path.join(dir, `exit-${n}`), String(exit));
    },
    vmFile: (...p) => path.join(dir, 'vm', ...p),
    localFile: (...p) => path.join(dir, 'state', ...p)
  };
  return ctx;
}

const keepRow = (over = {}) => ({
  id: '6abf251529e23409d1307085', rowId: 'eagle-6abf251529e23409d1307085',
  trackProjectId: null, surplus: true, kept: true, ...over
});

const seedSummary = (over = {}) => ({
  mode: 'dry', failures: [], track: { source: 'api', count: 386 },
  reconcile: {
    documents: { inCosmos: 62326, wouldDelete: 751, ceiling: 1247 },
    projects: { wouldDelete: 17, wouldKeep: ['eagle-6abf251529e23409d1307085'], ceiling: 50 }
  },
  keep: [keepRow()],
  ...over
});

const finished = (summary, rc = 0) =>
  `RESEED_RC=${rc}\nRESEED_SUMMARY_BEGIN\n${JSON.stringify(summary)}\nRESEED_SUMMARY_END\nDEMI_EXIT=0\n`;

/** Starts a dry `step` and answers its wait with `summary`. Returns the wait result. */
function waitStep(ctx, step, summary, args = []) {
  const started = ctx.run([step, '--run', 'r1']);
  assert.strictEqual(started.status, 0, started.out);
  ctx.reply(finished(summary));
  return ctx.run(['wait', step, '--run', 'r1', ...args]);
}
const waitSeed = (ctx, summary, args) => waitStep(ctx, 'seed', summary, args);

const readsCounts = (over = {}) => ({ fetched: 144, written: 144, skipped: 0, dropped: 0, errors: 0, ...over });
const readsSummary = (stages, unfinished) => ({ live: false, stages, skipped: [], unfinished });

function passDrySeed(ctx, env = {}) {
  const started = ctx.run(['seed', '--run', 'r1'], env);
  assert.strictEqual(started.status, 0, started.out);
  ctx.reply(finished(seedSummary()));
  const waited = ctx.run(['wait', 'seed', '--run', 'r1'], env);
  assert.strictEqual(waited.status, 0, waited.out);
}

/** The detached fake node ends on its own; this waits for its rc file, bounded. */
function waitForFile(file) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(file)) {
    assert.ok(Date.now() < deadline, `${file} never appeared`);
    spawnSync('sleep', ['0.05']);
  }
}

test('--help exits 0', () => {
  const r = spawnSync('bash', [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /scripts\/reseed-test\.sh seed/);
});

test('there is no --env flag', t => {
  const ctx = sandbox(t);
  const r = ctx.run(['seed', '--run', 'r1', '--env', 'prod']);
  assert.strictEqual(r.status, 2);
  assert.deepStrictEqual(ctx.calls(), []);
});

test('seed is dry unless --live', t => {
  const ctx = sandbox(t);
  const r = ctx.run(['seed', '--run', 'r1']);
  assert.strictEqual(r.status, 0, r.out);
  waitForFile(ctx.vmFile('r1', 'seed-dry.rc'));
  const node = ctx.read('node.log');
  assert.match(node, /seed-nosql\.js --reconcile --keep-ids \S+\/r1\/keep-ids\.txt --summary/);
  assert.doesNotMatch(node, /--live/);
});

test('seed --live refuses without A1,A4,A7,A9 and never calls the devbox', t => {
  const ctx = sandbox(t);
  passDrySeed(ctx);
  const before = ctx.calls().length;
  const r = ctx.run(['seed', '--run', 'r1', '--live', '--approved', 'A1,A4,A7']);
  assert.strictEqual(r.status, 2);
  assert.match(r.out, /missing A9/);
  assert.strictEqual(ctx.calls().length, before);
});

test('seed --live refuses without a passing dry run in the same run', t => {
  const ctx = sandbox(t);
  const r = ctx.run(['seed', '--run', 'r1', '--live', '--approved', ALL_SEED]);
  assert.strictEqual(r.status, 2);
  assert.match(r.out, /needs a passing dry run of seed/);
  assert.deepStrictEqual(ctx.calls(), []);
});

test('seed --live refuses a passing dry run older than 24 hours', t => {
  const ctx = sandbox(t);
  passDrySeed(ctx);
  const before = ctx.calls().length;
  const r = ctx.run(['seed', '--run', 'r1', '--live', '--approved', ALL_SEED],
    { RESEED_NOW: String(MORNING + 86401) });
  assert.strictEqual(r.status, 2);
  assert.match(r.out, /older than 24 hours/);
  assert.strictEqual(ctx.calls().length, before);
});

test('seed --live with --max-surplus also needs A2', t => {
  const ctx = sandbox(t);
  passDrySeed(ctx);
  const r = ctx.run(['seed', '--run', 'r1', '--live', '--approved', ALL_SEED, '--max-surplus', '1400']);
  assert.strictEqual(r.status, 2);
  assert.match(r.out, /missing A2/);
});

test('seed --live with its approvals and a dry pass starts live and logs the approvals', t => {
  const ctx = sandbox(t);
  passDrySeed(ctx);
  const r = ctx.run(['seed', '--run', 'r1', '--live', '--approved', ALL_SEED]);
  assert.strictEqual(r.status, 0, r.out);
  waitForFile(ctx.vmFile('r1', 'seed-live.rc'));
  assert.match(ctx.read('node.log'), /seed-nosql\.js .*--live/);
  assert.match(fs.readFileSync(ctx.localFile('r1', 'approvals.log'), 'utf8'),
    /^\S+Z operator step=seed approved=A1,A4,A7,A9\n$/);
});

test('every devbox call is --env test with DEVBOX_KEEP_RUNNING=1', t => {
  const ctx = sandbox(t);
  ctx.reply('checkout a -> b\nDEMI_EXIT=0\n');
  ctx.run(['update']);
  ctx.reply('{"counts":{},"indexProgress":{}}\nDEMI_EXIT=0\n');
  ctx.reply('drift clean\n', { offset: 1 });
  ctx.run(['baseline', '--run', 'r1']);
  passDrySeed(ctx);
  ctx.reply('line\nDEMI_EXIT=0\n');
  ctx.run(['logs', 'seed', '--run', 'r1']);
  ctx.run(['stop']);
  const calls = ctx.calls();
  assert.strictEqual(calls.length, 7);
  assert.deepStrictEqual(calls.filter(c => !/ argv=run --env test -- keep=1 /.test(c) &&
    !/ argv=drift --env test keep=1 /.test(c)), []);
  assert.strictEqual(calls.filter(c => / argv=drift --env test keep=1 /.test(c)).length, 1);
});

test('payload reads secrets from demi-kv-test inside the command and prints none', t => {
  const ctx = sandbox(t);
  const r = ctx.run(['seed', '--run', 'r1']);
  assert.strictEqual(r.status, 0, r.out);
  waitForFile(ctx.vmFile('r1', 'seed-dry.rc'));
  const payload = ctx.payloads()[0];
  assert.ok(payload.includes('TRACK_CLIENT_SECRET=$(az keyvault secret show --vault-name demi-kv-test ' +
    '-n track-client-secret --query value -o tsv)\n[ -n "$TRACK_CLIENT_SECRET" ] || exit 3'));
  assert.match(ctx.read('node.log'), /secret=set/);
  assert.ok(!r.out.includes(SECRET));
  const files = fs.readdirSync(ctx.dir, { recursive: true })
    .map(f => path.join(ctx.dir, f)).filter(f => fs.statSync(f).isFile());
  assert.deepStrictEqual(files.filter(f => fs.readFileSync(f, 'utf8').includes(SECRET)), []);
});

test('seed stops on the VM when the secret reads empty', t => {
  const ctx = sandbox(t);
  const r = ctx.run(['seed', '--run', 'r1'], { FAKE_SECRET: '' });
  assert.strictEqual(r.status, 1);
  assert.match(r.out, /secret read empty/);
  assert.strictEqual(ctx.read('node.log'), '');
});

test("start refuses while the step's pid is alive", t => {
  const ctx = sandbox(t);
  fs.mkdirSync(ctx.vmFile('r1'), { recursive: true });
  fs.writeFileSync(ctx.vmFile('r1', 'seed-dry.pid'), `${process.pid}\n${BOOT_ID}\n`);
  const r = ctx.run(['seed', '--run', 'r1']);
  assert.strictEqual(r.status, 1);
  assert.match(r.out, /still running/);
  assert.strictEqual(ctx.read('node.log'), '');
});

test('wait fails when track source is file', t => {
  const ctx = sandbox(t);
  const r = waitSeed(ctx, seedSummary({ track: { source: 'file', count: 382 } }));
  assert.strictEqual(r.status, 1);
  assert.match(r.out, /FAIL track\.source is file, not api/);
});

test('wait fails when a keep id has a Track match', t => {
  const ctx = sandbox(t);
  const r = waitSeed(ctx, seedSummary({ keep: [keepRow({ trackProjectId: 42 })] }));
  assert.strictEqual(r.status, 1);
  assert.match(r.out, /FAIL keep id 6abf251529e23409d1307085 matches Track project 42: stop for A9/);
});

test('wait fails when a keep id is listed for delete', t => {
  const ctx = sandbox(t);
  const r = waitSeed(ctx, seedSummary({ keep: [keepRow({ kept: false })] }));
  assert.strictEqual(r.status, 1);
  assert.match(r.out, /FAIL keep id 6abf251529e23409d1307085 is listed for delete/);
});

test('wait prints the --max-surplus a refused reconcile needs', t => {
  const ctx = sandbox(t);
  const r = waitSeed(ctx, seedSummary({
    failures: ['--reconcile refused before any delete — nothing removed from either container: ' +
      'documents surplus 1300 exceeds the ceiling 1247. Re-run with --max-surplus <n> if the deletion really is that large.'],
    reconcile: {
      documents: { wouldDelete: 1300, wouldKeep: 2, ceiling: 1247 },
      projects: { wouldDelete: 17, wouldKeep: ['x'], ceiling: 50 }
    }
  }));
  assert.strictEqual(r.status, 1);
  assert.match(r.out, /NEED --max-surplus 1302 /);
});

test('wait fails a refusal with no reconcile block and prints no --max-surplus hint', t => {
  const ctx = sandbox(t);
  const refusal = '--reconcile refused before any delete — nothing removed from either container: ' +
    'the documents fetch was never verified complete against a searchResultsTotal';
  const r = waitSeed(ctx, seedSummary({ failures: [refusal], reconcile: null }));
  assert.strictEqual(r.status, 1);
  assert.ok(r.out.includes(`FAIL seed failure: ${refusal}`), r.out);
  assert.doesNotMatch(r.out, /NEED --max-surplus/);
});

test('wait never sends a remote timeout above 900 s', t => {
  const ctx = sandbox(t);
  ctx.run(['seed', '--run', 'r1']);
  ctx.reply('RESEED_STATE=running\nDEMI_EXIT=0\n');
  ctx.reply(finished(seedSummary()), { offset: 1 });
  const r = ctx.run(['wait', 'seed', '--run', 'r1', '--max-wait', '100000']);
  assert.strictEqual(r.status, 0, r.out);
  const waits = ctx.payloads().slice(1);
  assert.strictEqual(waits.length, 2);
  assert.ok(waits.every(p => p.includes('timeout 900 ')));
  const timeouts = waits.join('\n').match(/timeout \d+/g).map(s => Number(s.split(' ')[1]));
  assert.deepStrictEqual(timeouts.filter(s => s > 900), []);
});

test('wait retries a did-not-run result', t => {
  const ctx = sandbox(t);
  ctx.run(['seed', '--run', 'r1']);
  ctx.reply('ERROR: (Conflict) Run command extension execution is in progress.\n' +
    'demi-devbox: the command did not run on demi-devbox-test\n', { exit: 1 });
  ctx.reply(finished(seedSummary()), { offset: 1 });
  const r = ctx.run(['wait', 'seed', '--run', 'r1']);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /PASS seed dry/);
  assert.strictEqual(ctx.calls().length, 3);
});

test('wait fails at once when the pid died with no rc file', t => {
  const ctx = sandbox(t);
  ctx.run(['seed', '--run', 'r1']);
  waitForFile(ctx.vmFile('r1', 'seed-dry.rc'));
  fs.rmSync(ctx.vmFile('r1', 'seed-dry.rc'));
  const dead = spawnSync('true').pid;
  fs.writeFileSync(ctx.vmFile('r1', 'seed-dry.pid'), `${dead}\n${BOOT_ID}\n`);
  const r = ctx.run(['wait', 'seed', '--run', 'r1', '--max-wait', '0']);
  assert.strictEqual(r.status, 1);
  assert.match(r.out, /died without writing an exit code/);
  assert.strictEqual(ctx.calls().length, 2);
});

test('wait fails at once when the boot id changed', t => {
  const ctx = sandbox(t);
  ctx.run(['seed', '--run', 'r1']);
  waitForFile(ctx.vmFile('r1', 'seed-dry.rc'));
  fs.rmSync(ctx.vmFile('r1', 'seed-dry.rc'));
  fs.writeFileSync(ctx.vmFile('r1', 'seed-dry.pid'), `${process.pid}\nanother-boot\n`);
  const r = ctx.run(['wait', 'seed', '--run', 'r1', '--max-wait', '0']);
  assert.strictEqual(r.status, 1);
  assert.match(r.out, /rebooted/);
});

test('wait refuses to start a deallocated VM', t => {
  const ctx = sandbox(t);
  ctx.run(['seed', '--run', 'r1']);
  const r = ctx.run(['wait', 'seed', '--run', 'r1'], { FAKE_POWER: 'PowerState/deallocated' });
  assert.strictEqual(r.status, 1);
  assert.match(r.out, /is deallocated; not starting it/);
  assert.strictEqual(ctx.calls().length, 1);
});

test('seed --live refuses when fewer than 90 minutes remain before 19:00 Pacific', t => {
  const ctx = sandbox(t);
  const late = { RESEED_NOW: String(LATE) };
  passDrySeed(ctx, late);
  const before = ctx.calls().length;
  const r = ctx.run(['seed', '--run', 'r1', '--live', '--approved', ALL_SEED], late);
  assert.strictEqual(r.status, 2);
  assert.match(r.out, /60 minutes remain before the 19:00 Pacific auto-shutdown/);
  assert.strictEqual(ctx.calls().length, before);
});

test('seed --live --past-shutdown-ok starts inside the window and is logged', t => {
  const ctx = sandbox(t);
  const late = { RESEED_NOW: String(LATE) };
  passDrySeed(ctx, late);
  const r = ctx.run(['seed', '--run', 'r1', '--live', '--approved', ALL_SEED, '--past-shutdown-ok'], late);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(fs.readFileSync(ctx.localFile('r1', 'approvals.log'), 'utf8'),
    /step=seed approved=A1,A4,A7,A9 past-shutdown-ok minutes-left=60\n$/);
});

test('preflight sends no git pull; update does', t => {
  const ctx = sandbox(t);
  ctx.reply('checkout ok\nDEMI_EXIT=0\n');
  const pre = ctx.run(['preflight', '--run', 'r2']);
  assert.strictEqual(pre.status, 0, pre.out);
  ctx.reply('checkout a -> b\nDEMI_EXIT=0\n');
  const upd = ctx.run(['update']);
  assert.strictEqual(upd.status, 0, upd.out);
  const [preflight, update] = ctx.payloads();
  assert.doesNotMatch(preflight, /git pull|yarn install/);
  assert.match(update, /git pull --ff-only/);
  assert.match(update, /git diff --quiet "\$old" "\$new" -- yarn\.lock; then yarn install --immutable/);
});

test('stop refuses while a pid is alive', t => {
  const ctx = sandbox(t);
  fs.mkdirSync(ctx.vmFile('r1'), { recursive: true });
  fs.writeFileSync(ctx.vmFile('r1', 'public-reads-live.pid'), `${process.pid}\n${BOOT_ID}\n`);
  const r = ctx.run(['stop']);
  assert.strictEqual(r.status, 1);
  assert.match(r.out, /still running/);
  assert.doesNotMatch(ctx.read('az.log'), /vm deallocate/);
});

test('stop deallocates the test VM when no step runs', t => {
  const ctx = sandbox(t);
  const r = ctx.run(['stop']);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(ctx.read('az.log'),
    new RegExp(`vm deallocate --subscription ${TEST_SUB} -g c4b0a8-test-rg -n demi-devbox-test`));
});

test('public-reads --live refuses without a passing seed --live', t => {
  const ctx = sandbox(t);
  const r = ctx.run(['public-reads', '--run', 'r1', '--live']);
  assert.strictEqual(r.status, 2);
  assert.match(r.out, /needs a passing seed --live/);
  assert.deepStrictEqual(ctx.calls(), []);
});

test('public-reads wait passes dropped-only stages with a NOTE', t => {
  const ctx = sandbox(t);
  const r = waitStep(ctx, 'public-reads', readsSummary({
    organizations: readsCounts(),
    comments: readsCounts({ written: 99, skipped: 45, dropped: 45 })
  }, ['comments']));
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /NOTE comments dropped=45 \(rows whose parent is not in DEMI\)/);
  assert.doesNotMatch(r.out, /FAIL/);
});

test('public-reads wait fails a stage with errors', t => {
  const ctx = sandbox(t);
  const r = waitStep(ctx, 'public-reads', readsSummary({
    comments: readsCounts({ dropped: 45, errors: 2 })
  }, ['comments']));
  assert.strictEqual(r.status, 1);
  assert.match(r.out, /FAIL stage comments errors=2/);
  assert.doesNotMatch(r.out, /NOTE comments/);
});

test('public-reads wait fails an unfinished stage that has no counts', t => {
  const ctx = sandbox(t);
  const r = waitStep(ctx, 'public-reads', readsSummary({ organizations: readsCounts() }, ['notifications']));
  assert.strictEqual(r.status, 1);
  assert.match(r.out, /FAIL stage unfinished: notifications \(it threw before reporting counts\)/);
});

test('residue --live refuses without STAFF_TOKEN and runs no public check', t => {
  const ctx = sandbox(t);
  const ids = path.join(ctx.dir, 'ids.txt');
  fs.writeFileSync(ids, 'abc\n');
  assert.strictEqual(ctx.run(['residue', '--run', 'r1']).status, 0);
  const before = ctx.read('public-check.log');
  const r = ctx.run(['residue', '--run', 'r1', '--live', '--approved', 'A5', '--kind', 'updates', '--ids', ids]);
  assert.strictEqual(r.status, 2);
  assert.match(r.out, /STAFF_TOKEN/);
  assert.strictEqual(ctx.read('public-check.log'), before);
});
