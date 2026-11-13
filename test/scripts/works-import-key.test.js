'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, KEY_FILE } = require('../../src/scripts/works-import-key');
const { devboxKeysFromPem, publicKeysFromPem, fingerprintOf } = require('../../src/utils/import-envelope');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'works-import-key-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function keygen(dir, ...flags) {
  const lines = [];
  await run(['--dir', dir, ...flags], { write: line => lines.push(line) });
  return { lines, pem: fs.readFileSync(path.join(dir, KEY_FILE), 'utf8') };
}

test('writes one PEM the loader reads, 0600 in a 0700 directory, and prints its public keys and fingerprint', async () => {
  const dir = path.join(tmp, 'fresh');
  const { lines, pem } = await keygen(dir);
  const keys = devboxKeysFromPem(pem);
  assert.equal(keys.rsa.asymmetricKeyDetails.modulusLength, 4096);
  assert.equal(fs.statSync(path.join(dir, KEY_FILE)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const printed = publicKeysFromPem(lines.join('\n'));
  assert.equal(fingerprintOf(printed), keys.fingerprint);
  assert.ok(lines.includes(`fingerprint=${keys.fingerprint}`));
  assert.ok(!lines.join('\n').includes('PRIVATE KEY'));
});

test('works-import-key refuses to overwrite without --rotate', async () => {
  const dir = path.join(tmp, 'kept');
  const { pem } = await keygen(dir);
  await assert.rejects(keygen(dir), /pass --rotate/);
  assert.equal(fs.readFileSync(path.join(dir, KEY_FILE), 'utf8'), pem);
});

test('--rotate replaces the key, leaves no other file, and prints the old fingerprint first', async () => {
  const dir = path.join(tmp, 'rotated');
  const first = await keygen(dir);
  const second = await keygen(dir, '--rotate');
  assert.notEqual(devboxKeysFromPem(second.pem).fingerprint, devboxKeysFromPem(first.pem).fingerprint);
  assert.deepEqual(fs.readdirSync(dir), [KEY_FILE]);
  assert.equal(second.lines[0], `oldFingerprint=${devboxKeysFromPem(first.pem).fingerprint}`);
});

test('refuses a key directory another user owns', async (t) => {
  const fstat = fs.fstatSync;
  t.mock.method(fs, 'fstatSync', (...args) => ({ ...fstat(...args), uid: process.getuid() + 1 }));
  await assert.rejects(keygen(path.join(tmp, 'foreign')), /another user/);
});

test('--rotate replaces a key that no longer parses', async () => {
  const dir = path.join(tmp, 'broken');
  await keygen(dir);
  fs.writeFileSync(path.join(dir, KEY_FILE), 'not a key');
  const { lines, pem } = await keygen(dir, '--rotate');
  assert.equal(lines[0], 'oldFingerprint=unreadable');
  assert.ok(devboxKeysFromPem(pem).fingerprint);
});

test('refuses a key directory that is a symbolic link', async () => {
  const real = path.join(tmp, 'real');
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(tmp, 'linked'));
  await assert.rejects(keygen(path.join(tmp, 'linked')), /not a directory/);
});
