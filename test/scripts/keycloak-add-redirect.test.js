'use strict';

// Fake oc and curl on PATH; runs from inside scripts/ so a lib path built from the caller's
// directory fails.

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPTS = path.resolve(__dirname, '..', '..', 'scripts');
const TOKEN = 'tok-123';

const b64 = (s) => Buffer.from(s).toString('base64');
const secret = (fields) =>
  JSON.stringify({ data: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, b64(v)])) });

// PATH is in the secret so loading keys outside the known six breaks the run.
const USER_SECRET = secret({
  USERNAME: 'admin',
  PASSWORD: 'pw',
  KEYCLOAK_URL: 'https://kc.invalid/auth',
  KEYCLOAK_REALM: 'master',
  PATH: '/nonexistent'
});
const CLIENT_SECRET = secret({
  KEYCLOAK_CLIENT_ID: 'svc',
  KEYCLOAK_CLIENT_SECRET: 'cs',
  KEYCLOAK_URL: 'https://kc.invalid/auth',
  KEYCLOAK_REALM: 'master'
});

const FAKE_CURL = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CURL_LOG"
url="" form="" hdr="" prev=""
for a in "$@"; do
  case "$a" in
    http*) url="$a" ;;
    client_secret@*|password@*) form+=" \${a%%@*}=$(cat "\${a#*@}")" ;;
    grant_type=*|client_id=*|username=*) form+=" $a" ;;
    @*) [[ "$prev" == -H ]] && hdr=$(cat "\${a#@}") ;;
  esac
  prev="$a"
done
case "$url" in
  *openid-connect/token)
    case "$form" in
      " grant_type=password client_id=admin-cli username=admin password=pw" | \\
      " grant_type=client_credentials client_id=svc client_secret=cs")
        echo '{"access_token":"${TOKEN}"}' ;;
      *) exit 22 ;;
    esac ;;
  *)
    [[ "$hdr" == "Authorization: Bearer ${TOKEN}" ]] || exit 22
    case "$url" in
      *'clients?clientId='*) cat "$CLIENT_FIXTURE" ;;
      */clients/*) cat > "$PUT_BODY" ;;
      *) exit 1 ;;
    esac ;;
esac
`;

/** Run the script against one client fixture; returns {status, stdout, put, calls}. */
function run(client, args, secretJson = USER_SECRET) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcar-'));
  try {
    const fixture = path.join(dir, 'client.json');
    const putBody = path.join(dir, 'put.json');
    const curlLog = path.join(dir, 'curl.log');
    fs.writeFileSync(fixture, JSON.stringify([{ id: 'uuid-1', clientId: 'epic-notify', ...client }]));
    fs.writeFileSync(path.join(dir, 'secret.json'), secretJson);
    fs.writeFileSync(path.join(dir, 'oc'), `#!/usr/bin/env bash\ncat "${dir}/secret.json"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'curl'), FAKE_CURL, { mode: 0o755 });
    fs.writeFileSync(curlLog, '');

    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      ENV: 'test',
      KC_CLIENT_ID: 'epic-notify',
      CLIENT_FIXTURE: fixture,
      PUT_BODY: putBody,
      CURL_LOG: curlLog
    };
    delete env.OC_CONTEXT;
    delete env.KC_URL_OVERRIDE;
    delete env.KC_ADMIN_SECRET;

    const res = spawnSync('bash', ['keycloak-add-redirect.sh', ...args], {
      cwd: SCRIPTS,
      encoding: 'utf8',
      timeout: 30000,
      env
    });
    return {
      status: res.status,
      stdout: res.stdout,
      put: fs.existsSync(putBody) ? JSON.parse(fs.readFileSync(putBody, 'utf8')) : null,
      calls: fs.readFileSync(curlLog, 'utf8').trim().split('\n')
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('writes with PUT and keeps the token off every argv', () => {
  const r = run({ redirectUris: [], webOrigins: [] }, ['https://n']);
  assert.strictEqual(r.status, 0);
  assert.match(r.calls.at(-1), /-X PUT .*\/clients\/uuid-1/);
  assert.ok(!r.calls.some((c) => c.includes(TOKEN) || c.includes('Bearer')), r.calls.join('\n'));
});

test('mints the token from a client-credentials secret', () => {
  const r = run({ redirectUris: [], webOrigins: [] }, ['https://n'], CLIENT_SECRET);
  assert.strictEqual(r.status, 0);
  assert.deepStrictEqual(r.put.webOrigins, ['https://n']);
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

test('an unknown flag is refused before any PUT', () => {
  const r = run({ redirectUris: [], webOrigins: [] }, ['https://n', '--dryrun']);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.put, null);
});
