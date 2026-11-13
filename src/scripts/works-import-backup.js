'use strict';

// Opens the works-backup the loader sealed to the operator, once the operator has sealed it back to the devbox
// (`works:extract open`, then `seal --purpose works-backup`). Every decryption stays in memory.

const crypto = require('crypto');
const { ENV, MAX_BYTES, checkKeyFile } = require('./works-import-inputs');
const { devboxKeysFromPem, openEnvelope, readCapped, sha256Hex, verify } = require('../utils/import-envelope');

const PURPOSE = 'works-backup';

const refuse = (message) => { throw new Error(message); };

// JSON.parse errors quote the input, so its message never reaches the caller.
function payloadOf(plaintext) {
  try {
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    return refuse('works-backup is not JSON');
  }
}

/**
 * The backup load-business-works.js wrote in startBatch: `{batchId, documents, projects}`. The plaintext is checked
 * against the devbox signature, `expectSha256` and the batch header's backupSha256 before it is parsed.
 */
function openBackup({ sealedPath, expectSha256, devboxKeyPath, batchBackupSha256 }) {
  checkKeyFile(devboxKeyPath);
  const keys = devboxKeysFromPem(readCapped(devboxKeyPath, MAX_BYTES.key).toString('utf8'));
  const opened = openEnvelope(readCapped(sealedPath, MAX_BYTES.backup), {
    purpose: PURPOSE, env: ENV, keyFingerprint: keys.fingerprint, privateKey: keys.rsa
  });
  const sha256 = sha256Hex(opened.plaintext);
  if (!verify(crypto.createPublicKey(keys.ed25519), { purpose: PURPOSE, env: ENV, sha256 }, opened.signature)) {
    refuse('works-backup signature does not verify');
  }
  if (sha256 !== String(expectSha256).toLowerCase()) refuse('works-backup SHA-256 does not match expectSha256');
  if (sha256 !== String(batchBackupSha256).toLowerCase()) refuse('works-backup SHA-256 does not match the batch header backupSha256');
  return payloadOf(opened.plaintext);
}

module.exports = { openBackup };
