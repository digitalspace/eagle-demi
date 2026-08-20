'use strict';

/**
 * The retry loop in `scripts/pull-from-container.sh` is the whole reason that script exists.
 *
 * App Service SSH has no sftp subsystem, so a file has to come out through `cat` — and a `cat` that
 * dies mid-stream still exits 0, leaving a truncated file that looks like a successful pull. That is
 * not hypothetical: the 2026-08-20 chunk export arrived as 568 MB of a 992 MB file, reported as a
 * success, and was only caught by an md5 afterwards.
 *
 * So this test does not check that a clean transfer works. It makes one part arrive truncated, and
 * asserts the script noticed, refetched it, and only then assembled a file whose md5 matches the
 * source. `PULL_SSH_CMD` stands in for ssh; `/home/` is mapped into a scratch directory so the
 * "container" side is just the filesystem.
 */

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'pull-from-container.sh');

/** Stands in for `ssh <host>`: runs its one command argument locally, and drops the first read of
 *  `$FLAKY` after 10 bytes — the tunnel dying mid-stream, exit code 0 and all. */
const FAKE_SSH = `#!/usr/bin/env bash
cmd="\${1//\\/home\\//$\{SCRATCH}/}"
if [[ "$cmd" == cat*"$\{FLAKY}"* && ! -e "$\{SCRATCH}/.flaked" ]]; then
  touch "$\{SCRATCH}/.flaked"
  bash -c "$cmd" | head -c 10
  exit 0
fi
exec bash -c "$cmd"
`;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demi-pull-'));
  const ssh = path.join(dir, 'fake-ssh.sh');
  fs.writeFileSync(ssh, FAKE_SSH, { mode: 0o755 });
  // 8 KB at 1 KB a part is eight parts, enough for part-aab to be neither the first nor the last —
  // a truncation at either end is the easy case.
  const source = crypto.randomBytes(8 * 1024);
  fs.writeFileSync(path.join(dir, 'big.bin'), source);
  return { dir, ssh, source };
}

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

test('a part that arrives truncated is refetched, and the assembled file matches the source', () => {
  const { dir, ssh, source } = setup();
  const dest = path.join(dir, 'pulled.bin');

  const out = execFileSync('bash', [SCRIPT, '/home/big.bin', dest], {
    encoding: 'utf8',
    env: { ...process.env, PULL_SSH_CMD: `bash ${ssh}`, SCRATCH: dir, FLAKY: 'part-aab', PART_SIZE: '1K' },
  });

  assert.ok(fs.existsSync(path.join(dir, '.flaked')), 'the stub must actually have truncated a part');
  assert.strictEqual(md5(fs.readFileSync(dest)), md5(source), 'the pulled file must be byte-identical');
  assert.match(out, /matches the container's/);
  // The remote scratch directory is the file again in size; leaving it behind fills /home.
  assert.ok(!fs.existsSync(path.join(dir, '.pull-big.bin')), 'the remote work directory is cleaned up');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a part that never matches fails the run instead of assembling a short file', () => {
  const { dir } = setup();
  const dest = path.join(dir, 'pulled.bin');

  // No `.flaked` marker is written when FLAKY_ALWAYS is set, so every attempt at that part is short
  // and the script exhausts its retries.
  const ssh2 = path.join(dir, 'fake-ssh-always.sh');
  fs.writeFileSync(ssh2, FAKE_SSH.replace('&& ! -e "${SCRATCH}/.flaked" ', ''), { mode: 0o755 });

  assert.throws(() => execFileSync('bash', [SCRIPT, '/home/big.bin', dest], {
    encoding: 'utf8', stdio: 'pipe',
    env: { ...process.env, PULL_SSH_CMD: `bash ${ssh2}`, SCRATCH: dir, FLAKY: 'part-aab', PART_SIZE: '1K' },
  }), /Command failed/);

  assert.ok(!fs.existsSync(dest), 'nothing is assembled when a part could not be verified');
  fs.rmSync(dir, { recursive: true, force: true });
});
