'use strict';

// Opens the works-backup the loader sealed to the operator, once the operator has sealed it back to the devbox
// (`works:extract reseal --purpose works-backup`). Every decryption stays in memory.

const crypto = require('crypto');
const { ENV, MAX_BYTES, devboxKeysOf } = require('./works-import-inputs');
const { openEnvelope, readCapped, sha256Hex, verify } = require('../utils/import-envelope');

const PURPOSE = 'works-backup';

const refuse = (message) => { throw new Error(message); };
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const objects = v => Array.isArray(v) && v.every(isObject);

// JSON.parse errors quote the input, so its message never reaches the caller.
function payloadOf(plaintext, batchId) {
  let backup;
  try {
    backup = JSON.parse(plaintext.toString('utf8'));
  } catch {
    refuse('works-backup is not JSON');
  }
  const shaped = isObject(backup) && objects(backup.documents) && objects(backup.projects)
    && (backup.projectEntries === undefined || objects(backup.projectEntries));
  if (!shaped) refuse('works-backup is malformed');
  if (backup.batchId !== batchId) refuse('works-backup is not for this batch');
  return backup;
}

/**
 * The backup load-business-works.js wrote in startBatch: `{batchId, documents, projects, projectEntries}`. The
 * plaintext is checked against the devbox signature, `expectSha256` and the batch header's backupSha256 before it is parsed.
 */
function openBackup({ sealedPath, expectSha256, devboxKeyPath, expectDevboxFingerprint, batchId, batchBackupSha256 }) {
  const keys = devboxKeysOf(devboxKeyPath, expectDevboxFingerprint);
  const opened = openEnvelope(readCapped(sealedPath, MAX_BYTES.backup, { label: 'the works-backup' }), {
    purpose: PURPOSE, env: ENV, keyFingerprint: keys.fingerprint, privateKey: keys.rsa
  });
  const sha256 = sha256Hex(opened.plaintext);
  if (!verify(crypto.createPublicKey(keys.ed25519), { purpose: PURPOSE, env: ENV, sha256 }, opened.signature)) {
    refuse('works-backup signature does not verify');
  }
  if (sha256 !== String(expectSha256).toLowerCase()) refuse('works-backup SHA-256 does not match expectSha256');
  if (sha256 !== String(batchBackupSha256).toLowerCase()) refuse('works-backup SHA-256 does not match the batch header backupSha256');
  return payloadOf(opened.plaintext, batchId);
}

module.exports = { openBackup };
