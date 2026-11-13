'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { openBackup } = require('../../src/scripts/works-import-backup');
const { fingerprintOf, sealEnvelope, sha256Hex, sign, writeSealed } = require('../../src/utils/import-envelope');
const { tmp, fresh, devbox, cli } = require('../fixtures/works-import/harness');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const PAYLOAD = {
  batchId: 'batch-1',
  documents: [{ id: 'work-1', projectId: 'p-1', _etag: 'etag-1' }],
  projects: [{ projectId: 'p-1', externalIds: [{ system: 'track', value: '7' }], staffNotes: [] }],
  projectEntries: [{ action: 'addExternalId', projectId: 'p-1', pair: { system: 'track', value: '7' } }]
};
const plaintext = Buffer.from(JSON.stringify(PAYLOAD));

function devboxKeyFile() {
  const dir = fresh('devbox-key');
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'devbox-key.pem');
  fs.writeFileSync(file, [devbox.rsa.privateKey, devbox.ed.privateKey].map(k => k.export({ type: 'pkcs8', format: 'pem' })).join(''), { mode: 0o600 });
  return file;
}

const devboxKeyPath = devboxKeyFile();
const base = { devboxKeyPath, expectDevboxFingerprint: devbox.fingerprint, batchId: PAYLOAD.batchId };

// The loader seals the backup to the operator; the operator reseals it to the devbox.
async function roundTrip() {
  const keysDir = fresh('operator');
  await cli(['keygen', '--env', 'test', '--out-dir', keysDir, '--passphrase-ref', 'operator']);
  const rsa = crypto.createPublicKey(fs.readFileSync(path.join(keysDir, 'operator-test.pub.pem')));
  const outDir = fresh('backup');
  fs.chmodSync(outDir, 0o700);
  const written = writeSealed(outDir, plaintext, {
    purpose: 'works-backup', env: 'test', recipient: { rsa, fingerprint: fingerprintOf({ rsa }) }, signingKey: devbox.ed.privateKey
  });
  const sealedPath = path.join(fresh('back'), 'works-backup.sealed.json');
  await cli(['reseal', '--env', 'test', '--purpose', 'works-backup', '--in', path.join(outDir, written.name), '--out', sealedPath,
    '--key', path.join(keysDir, 'operator-test.key.pem'), '--passphrase-ref', 'operator', '--recipient-key', devbox.pemFile,
    '--expect-fingerprint', devbox.fingerprint, '--expect-sha256', written.sha256]);
  return { ...base, sealedPath, expectSha256: written.sha256, batchBackupSha256: written.sha256 };
}

/** `body` sealed straight to the devbox and signed by `signingKey`, with both SHA-256 values matching. */
function toDevbox(body, signingKey = devbox.ed.privateKey) {
  const sealedPath = path.join(fresh('sealed'), 'works-backup.sealed.json');
  const sha256 = sha256Hex(body);
  fs.writeFileSync(sealedPath, sealEnvelope(Buffer.from(body), {
    purpose: 'works-backup', env: 'test', keyFingerprint: devbox.fingerprint, recipientKey: devbox.rsa.publicKey,
    signature: sign(signingKey, { purpose: 'works-backup', env: 'test', sha256 })
  }));
  return { ...base, sealedPath, expectSha256: sha256, batchBackupSha256: sha256 };
}

const withBody = changes => toDevbox(JSON.stringify({ ...PAYLOAD, ...changes }));

let given;
test.before(async () => { given = await roundTrip(); });

test('a works-backup resealed by the operator opens to the payload the loader sealed', () => {
  assert.deepEqual(openBackup(given), PAYLOAD);
});

test('refuses a works-backup whose SHA-256 is not expectSha256', () => {
  assert.throws(() => openBackup({ ...given, expectSha256: sha256Hex('other') }), /does not match expectSha256/);
});

test('refuses a works-backup whose SHA-256 is not the batch header backupSha256', () => {
  assert.throws(() => openBackup({ ...given, batchBackupSha256: sha256Hex('other') }), /does not match the batch header backupSha256/);
});

test('refuses a works-backup another key signed', () => {
  const forged = toDevbox(plaintext, crypto.generateKeyPairSync('ed25519').privateKey);
  assert.throws(() => openBackup(forged), /works-backup signature does not verify/);
});

test('refuses a devbox key whose fingerprint is not expectDevboxFingerprint', () => {
  assert.throws(() => openBackup({ ...given, expectDevboxFingerprint: '0'.repeat(64) }), /fingerprint of the devbox key does not match/);
});

test('refuses a works-backup of another batch', () => {
  assert.throws(() => openBackup({ ...given, batchId: 'batch-2' }), /works-backup is not for this batch/);
});

test('refuses a works-backup whose documents, projects or projectEntries are not arrays of objects', () => {
  assert.throws(() => openBackup(withBody({ documents: {} })), /works-backup is malformed/);
  assert.throws(() => openBackup(withBody({ projects: ['p-1'] })), /works-backup is malformed/);
  assert.throws(() => openBackup(withBody({ projectEntries: undefined })), /works-backup is malformed/);
});

test('a works-backup that is not JSON is refused without quoting it', () => {
  // An exact message match also proves the marker in the body is not quoted.
  assert.throws(() => openBackup(toDevbox('{"batchId":"marker-6f1d2c"')), { message: 'works-backup is not JSON' });
});

test('refuses a devbox key file that group or others may read', () => {
  const file = devboxKeyFile();
  fs.chmodSync(file, 0o644);
  assert.throws(() => openBackup({ ...given, devboxKeyPath: file }), /devbox key must be a 0600 file/);
});

test('refuses a devbox key that is a symbolic link', () => {
  const link = path.join(path.dirname(devboxKeyFile()), 'link.pem');
  fs.symlinkSync(devboxKeyPath, link);
  assert.throws(() => openBackup({ ...given, devboxKeyPath: link }), /the devbox key is a symbolic link/);
});

test('refuses a devbox key whose folder is a symbolic link', () => {
  const link = path.join(fresh('key-link'), 'folder');
  fs.symlinkSync(path.dirname(devboxKeyPath), link);
  assert.throws(() => openBackup({ ...given, devboxKeyPath: path.join(link, path.basename(devboxKeyPath)) }),
    { message: 'the devbox key folder must be 0700 and this user\'s' });
});

test('a missing devbox key is refused without its path', () => {
  const missing = path.join(path.dirname(devboxKeyFile()), 'absent.pem');
  assert.throws(() => openBackup({ ...given, devboxKeyPath: missing }), { message: 'the devbox key cannot be opened' });
  assert.throws(() => openBackup({ ...given, devboxKeyPath: path.join(missing, 'key.pem') }),
    { message: 'the devbox key folder must be 0700 and this user\'s' });
});
