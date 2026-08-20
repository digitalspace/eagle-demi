'use strict';

/**
 * The retry loop in `scripts/pull-from-container.sh` is the whole reason that script exists.
 *
 * App Service SSH has no sftp subsystem, so a file has to come out through `cat` — and a `cat` that
 * dies mid-stream still exits 0, leaving a truncated file that looks like a successful pull. That is
 * not hypothetical: the 2026-08-20 chunk export arrived as 568 MB of a 992 MB file, reported as a
 * success, and was only caught by an md5 afterwards.
 *
 * So none of these cases test a clean transfer. Each one drops a different stream mid-way — a part,
 * every attempt at a part, the manifest — and asserts the script noticed. `PULL_SSH_CMD` stands in
 * for ssh; `/home/` is mapped into a scratch directory so the "container" side is just the
 * filesystem, and every part fetch is logged so resume can be measured rather than asserted.
 */

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'pull-from-container.sh');

/**
 * Stands in for `ssh <host>`: runs its one command argument locally, logs every part fetch, and
 * truncates reads of `$FLAKY` after 10 bytes — the tunnel dying mid-stream, exit code 0 and all.
 * With `$FLAKY_ONCE` set it does that only the first time, so a later attempt succeeds.
 */
const FAKE_SSH = `#!/usr/bin/env bash
cmd="\${1//\\/home\\//$\{SCRATCH}/}"
case "$cmd" in cat*part-*) echo "$cmd" >> "$\{SCRATCH}/fetches.log";; esac
# -n on FLAKY is load-bearing: an empty one makes the pattern \`cat**\` and truncates every read.
if [[ -n "$\{FLAKY}" && "$cmd" == cat*"$\{FLAKY}"* ]]; then
  if [[ -z "$\{FLAKY_ONCE}" || ! -e "$\{SCRATCH}/.flaked" ]]; then
    touch "$\{SCRATCH}/.flaked"
    bash -c "$cmd" | head -c "$\{FLAKY_BYTES:-10}"
    exit 0
  fi
fi
exec bash -c "$cmd"
`;

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demi-pull-'));
  fs.writeFileSync(path.join(dir, 'fake-ssh.sh'), FAKE_SSH, { mode: 0o755 });
  // 8 KB at 1 KB a part is eight parts, so part-aab is neither the first nor the last — a
  // truncation at either end is the easy case.
  const source = crypto.randomBytes(8 * 1024);
  fs.writeFileSync(path.join(dir, 'big.bin'), source);
  return { dir, source, dest: path.join(dir, 'pulled.bin') };
}

/** Run the script against the stub. `flaky` is the part (or file) whose read is cut short. */
function pull(dir, dest, env = {}) {
  return execFileSync('bash', [SCRIPT, '/home/big.bin', dest], {
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      PULL_SSH_CMD: `bash ${path.join(dir, 'fake-ssh.sh')}`,
      SCRATCH: dir,
      PART_SIZE: '1K',
      FLAKY: '',
      FLAKY_ONCE: '',
      FLAKY_BYTES: '10',
      ...env,
    },
  });
}

const fetchCount = (dir) => fs.readFileSync(path.join(dir, 'fetches.log'), 'utf8').trim().split('\n').length;

test('a part that arrives truncated is refetched, and the assembled file matches the source', () => {
  const { dir, source, dest } = setup();

  const out = pull(dir, dest, { FLAKY: 'part-aab', FLAKY_ONCE: '1' });

  assert.ok(fs.existsSync(path.join(dir, '.flaked')), 'the stub must actually have truncated a part');
  assert.strictEqual(md5(fs.readFileSync(dest)), md5(source), 'the pulled file must be byte-identical');
  assert.match(out, /matches the container's/);
  // Both scratch areas are the file again in size; leaving them behind fills /home and the local disk.
  assert.ok(!fs.existsSync(path.join(dir, '.pull-big.bin')), 'the remote work directory is cleaned up');
  assert.ok(!fs.existsSync(`${dest}.parts`), 'the local parts directory is cleaned up');
  assert.ok(!fs.existsSync(`${dest}.partial`), 'no half-assembled file is left behind');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a part that never matches fails the run instead of assembling a short file', () => {
  const { dir, dest } = setup();

  assert.throws(
    () => pull(dir, dest, { FLAKY: 'part-aab' }),
    (err) => /never matched after 5 tries/.test(err.stdout),
    'must fail on the part it could not verify, not merely exit non-zero'
  );

  assert.ok(!fs.existsSync(dest), 'nothing is assembled when a part could not be verified');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a truncated manifest is caught by the whole-file md5, and leaves nothing at the destination', () => {
  // The parts all verify against a manifest that is itself short, so every per-part check passes and
  // only the whole-file comparison can catch it. Without that backstop this writes a 2 KB file over
  // an 8 KB one and calls it a success — the original failure by a different road.
  const { dir, dest } = setup();

  assert.throws(
    // 200 bytes is five whole md5 lines of the eight: enough that every part named verifies, which
    // is what makes this the case only the whole-file comparison can see. Cut shorter, the manifest
    // has no complete line at all and the emptiness guard catches it first — a different bug.
    () => pull(dir, dest, { FLAKY: 'parts.md5', FLAKY_BYTES: '200' }),
    (err) => /does not match the remote's/.test(err.stdout),
    'the whole-file md5 is the only guard that sees this'
  );

  assert.ok(!fs.existsSync(dest), 'a file that failed its md5 must not be left at the destination');
  assert.ok(!fs.existsSync(`${dest}.partial`), 'nor beside it');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a failed run resumes: the second run refetches only the part that was missing', () => {
  const { dir, source, dest } = setup();

  // Run 1 dies on part-aab every time, so seven of eight parts are pulled and verified.
  assert.throws(() => pull(dir, dest, { FLAKY: 'part-aab' }));
  const afterFirst = fetchCount(dir);
  assert.ok(afterFirst >= 8, `run 1 should have fetched every part at least once, got ${afterFirst}`);
  assert.ok(fs.existsSync(path.join(`${dest}.parts`, 'part-aaa')), 'verified parts survive a failed run');

  // Run 2 has a healthy transport. Only part-aab is missing, so only part-aab is fetched — the
  // resume that matters is the 992 MB pull that died at part 700, not a clean re-run.
  const out = pull(dir, dest);
  const secondRun = fetchCount(dir) - afterFirst;
  assert.strictEqual(secondRun, 1, `run 2 should fetch exactly the missing part, fetched ${secondRun}`);
  assert.strictEqual(md5(fs.readFileSync(dest)), md5(source));
  assert.match(out, /matches the container's/);

  fs.rmSync(dir, { recursive: true, force: true });
});
