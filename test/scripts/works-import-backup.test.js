'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { openBackup } = require('../../src/scripts/works-import-backup');
const { fingerprintOf, sealEnvelope, sha256Hex, statementOf, writeSealed } = require('../../src/utils/import-envelope');
const { tmp, fresh, devbox, cli } = require('../fixtures/works-import/harness');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const PAYLOAD = {
  batchId: 'batch-1',
  documents: [{ id: 'work-1', projectId: 'p-1', _etag: 'etag-1' }],
  projects: [{ projectId: 'p-1', externalIds: [{ system: 'track', value: '7' }], staffNotes: [] }]
};
const plaintext = Buffer.from(JSON.stringify(PAYLOAD));
const sha256 = sha256Hex(plaintext);

function devboxKeyFile() {
  const dir = fresh('devbox-key');
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'devbox-key.pem');
  fs.writeFileSync(file, [devbox.rsa.privateKey, devbox.ed.privateKey].map(k => k.export({ type: 'pkcs8', format: 'pem' })).join(''), { mode: 0o600 });
  return file;
}

// The loader seals the backup to the operator; the operator opens it and seals it back to the devbox.
async function roundTrip() {
  const keysDir = fresh('operator');
  await cli(['keygen', '--env', 'test', '--out-dir', keysDir, '--passphrase-ref', 'operator']);
  const operatorKeyPath = path.join(keysDir, 'operator-test.pub.pem');
  const rsa = crypto.createPublicKey(fs.readFileSync(operatorKeyPath));
  const outDir = fresh('backup');
  fs.chmodSync(outDir, 0o700);
  const written = writeSealed(outDir, plaintext, {
    purpose: 'works-backup', env: 'test', recipient: { rsa, fingerprint: fingerprintOf({ rsa }) }, signingKey: devbox.ed.privateKey
  });
  const review = path.join(fresh('review'), 'works-backup.json');
  await cli(['open', '--env', 'test', '--purpose', 'works-backup', '--in', path.join(outDir, written.name), '--out', review,
    '--key', path.join(keysDir, 'operator-test.key.pem'), '--passphrase-ref', 'operator', '--devbox-key', devbox.pemFile,
    '--devbox-fingerprint', devbox.fingerprint, '--expect-sha256', written.sha256]);
  const sealedPath = path.join(fresh('back'), 'works-backup.sealed.json');
  await cli(['seal', '--env', 'test', '--purpose', 'works-backup', '--in', review, '--signature', `${review}.sig`,
    '--key', path.join(keysDir, 'operator-test.key.pem'), '--passphrase-ref', 'operator',
    '--recipient-key', devbox.pemFile, '--expect-fingerprint', devbox.fingerprint, '--out', sealedPath]);
  return {
    sealedPath, expectSha256: written.sha256, devboxKeyPath: devboxKeyFile(), operatorKeyPath,
    expectOperatorFingerprint: fingerprintOf({ rsa }), batchBackupSha256: written.sha256
  };
}

let given;
test.before(async () => { given = await roundTrip(); });

test('a works-backup sealed back by the operator opens to the payload the loader sealed', () => {
  assert.deepEqual(openBackup(given), PAYLOAD);
});

test('refuses a works-backup whose SHA-256 is not expectSha256', () => {
  assert.throws(() => openBackup({ ...given, expectSha256: sha256Hex('other') }), /does not match expectSha256/);
});

test('refuses a works-backup whose SHA-256 is not the batch header backupSha256', () => {
  assert.throws(() => openBackup({ ...given, batchBackupSha256: sha256Hex('other') }), /does not match the batch header backupSha256/);
});

test('refuses an operator key whose fingerprint is not expectOperatorFingerprint', () => {
  assert.throws(() => openBackup({ ...given, expectOperatorFingerprint: '0'.repeat(64) }), /fingerprint of operator key does not match/);
});

test('refuses a works-backup another key signed', () => {
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
  const signature = crypto.sign('sha256', statementOf({ purpose: 'works-backup', env: 'test', sha256 }), {
    key: other.privateKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
  }).toString('base64');
  const sealedPath = path.join(fresh('forged'), 'works-backup.sealed.json');
  fs.writeFileSync(sealedPath, sealEnvelope(plaintext, {
    purpose: 'works-backup', env: 'test', keyFingerprint: devbox.fingerprint, recipientKey: devbox.rsa.publicKey, signature
  }));
  assert.throws(() => openBackup({ ...given, sealedPath }), /operator signature on the works-backup does not verify/);
});

test('refuses a devbox key file that group or others may read', () => {
  const devboxKeyPath = devboxKeyFile();
  fs.chmodSync(devboxKeyPath, 0o644);
  assert.throws(() => openBackup({ ...given, devboxKeyPath }), /devbox key must be a 0600 file/);
});

test('refuses a devbox key that is a symbolic link', () => {
  const devboxKeyPath = path.join(path.dirname(devboxKeyFile()), 'link.pem');
  fs.symlinkSync(given.devboxKeyPath, devboxKeyPath);
  assert.throws(() => openBackup({ ...given, devboxKeyPath }), /devbox key must be a 0600 file/);
});
