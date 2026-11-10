'use strict';

/**
 * `scripts/keycloak-add-redirect.sh` PUTs the whole client back, so a duplicate or a dropped entry
 * lands in Keycloak. Fake `oc` and `curl` on PATH serve a client fixture and capture the PUT body.
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'keycloak-add-redirect.sh');

const b64 = (s) => Buffer.from(s).toString('base64');
const SECRET = JSON.stringify({
  data: {
    USERNAME: b64('admin'),
    PASSWORD: b64('fake'),
    KEYCLOAK_URL: b64('https://kc.invalid/auth'),
    KEYCLOAK_REALM: b64('master')
  }
});

const FAKE_CURL = `#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in
    *openid-connect/token) echo '{"access_token":"t"}'; exit 0 ;;
    *'clients?clientId='*) cat "$CLIENT_FIXTURE"; exit 0 ;;
    */clients/*) cat > "$PUT_BODY"; exit 0 ;;
  esac
done
exit 1
`;

/** Run the script against one client fixture; returns {status, stdout, put} (put null if none sent). */
function run(client, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcar-'));
  const fixture = path.join(dir, 'client.json');
  const putBody = path.join(dir, 'put.json');
  fs.writeFileSync(fixture, JSON.stringify([{ id: 'uuid-1', clientId: 'epic-notify', ...client }]));
  fs.writeFileSync(path.join(dir, 'oc'), `#!/usr/bin/env bash\necho '${SECRET}'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'curl'), FAKE_CURL, { mode: 0o755 });

  const res = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      CLIENT_ID: 'epic-notify',
      CLIENT_FIXTURE: fixture,
      PUT_BODY: putBody
    }
  });
  const put = fs.existsSync(putBody) ? JSON.parse(fs.readFileSync(putBody, 'utf8')) : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: res.status, stdout: res.stdout, put };
}

test('adds only the missing entry and keeps every other one', () => {
  const r = run(
    { redirectUris: ['https://a/*', 'https://n/*'], webOrigins: ['https://a'] },
    ['https://n']
  );
  assert.strictEqual(r.status, 0);
  assert.deepStrictEqual(r.put.redirectUris, ['https://a/*', 'https://n/*']);
  assert.deepStrictEqual(r.put.webOrigins, ['https://a', 'https://n']);
  assert.match(r.stdout, /^added webOrigins https:\/\/n$/m);
});

test('sends no PUT when both entries are already present', () => {
  const r = run({ redirectUris: ['https://n/*'], webOrigins: ['https://n'] }, ['https://n']);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.put, null);
});

test('--dry-run after the origin still sends no PUT', () => {
  const r = run({ redirectUris: [], webOrigins: [] }, ['https://n', '--dry-run']);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.put, null);
});

test('an extra argument is refused before any PUT', () => {
  const r = run({ redirectUris: [], webOrigins: [] }, ['https://n', 'https://m']);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.put, null);
});
