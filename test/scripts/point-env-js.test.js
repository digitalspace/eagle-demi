'use strict';

/**
 * `scripts/point-env-js.sh` is the guard the 2026-08-11 incident asked for: a bundle deployed with
 * another environment's Keycloak realm looks entirely healthy.
 *
 * The guard it replaced could not fail. It matched on the OLD value (`sed dev -> test`), and the
 * committed env.js already held the test values, so `sed` matched nothing, exited 0, and the `grep`
 * after it passed on committed text. So the cases here are the ones that must be loud: a key that
 * is not in the file at all, and a file already holding the wrong environment's values.
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'point-env-js.sh');
const SOURCE = path.resolve(__dirname, '..', '..', 'frontend', 'public', 'env.js');

/** Run the script against a throwaway copy of the committed env.js and return it. */
function pointAt(env, { mutate = (s) => s, vars = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demi-envjs-'));
  const file = path.join(dir, 'env.js');
  fs.writeFileSync(file, mutate(fs.readFileSync(SOURCE, 'utf8')));
  const run = spawnSync('bash', [SCRIPT, env, file],
    { encoding: 'utf8', env: { ...process.env, ...vars } });
  const content = fs.readFileSync(file, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...run, content };
}

test('points a committed env.js at prod, whatever environment it held before', () => {
  const { status, content } = pointAt('prod',
    { vars: { NOTIFY_API_LOCATION: 'https://notify-api-prod.example.gov.bc.ca' } });
  assert.strictEqual(status, 0);
  assert.match(content, /window\.__env\.ENVIRONMENT = 'prod';/);
  assert.match(content, /window\.__env\.KEYCLOAK_URL = 'https:\/\/loginproxy\.gov\.bc\.ca\/auth';/);
  assert.match(content, /window\.__env\.configEndpoint = true;/);
});

test('test gets the test realm, not prod', () => {
  const { status, content } = pointAt('test');
  assert.strictEqual(status, 0);
  assert.match(content, /window\.__env\.KEYCLOAK_URL = 'https:\/\/test\.loginproxy\.gov\.bc\.ca\/auth';/);
  assert.match(content, /window\.__env\.ENVIRONMENT = 'test';/);
});

test('a renamed or missing key fails the deploy instead of passing silently', () => {
  const { status, stderr } = pointAt('test',
    { mutate: (s) => s.replace('window.__env.KEYCLOAK_URL', 'window.__env.KC_URL') });
  assert.strictEqual(status, 1);
  assert.match(stderr, /KEYCLOAK_URL/);
});

test('prod refuses to guess a notify host it has no value for', () => {
  const { status, stderr } = pointAt('prod', { vars: { NOTIFY_API_LOCATION: '' } });
  assert.strictEqual(status, 1);
  assert.match(stderr, /NOTIFY_API_LOCATION/);
});

test('an unknown environment is refused', () => {
  const { status } = pointAt('staging');
  assert.strictEqual(status, 1);
});
