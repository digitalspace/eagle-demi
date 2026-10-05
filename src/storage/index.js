'use strict';

/**
 * Object storage — the single entry point every caller uses.
 *
 * Hand out a short-lived download or upload URL, write an upload, copy an original to its backup,
 * stream an object in or out, delete one.
 * Nothing here exposes a bucket, a container, or a client.
 *
 * The backend is chosen by an EXPLICIT `STORAGE_BACKEND` value and an unknown value throws at
 * load. Inferring it from whichever credentials happen to be set is how this repo previously
 * activated the wrong data layer on deploy: `COSMOS_ENDPOINT` was already populated, so a
 * `Boolean(...)` switch silently flipped and every switched route 500'd. A backend switch
 * decides where documents are read from and written to — it must never be a side effect.
 */

const config = require('../config');
const { logger } = require('../utils/logger');

/** Untouched copies of originals taken before a title write; restore reads them back. */
const BACKUP_PREFIX = 'pdf-title-backup/';
// No upload link and no backup source may touch these, at any depth (an env prefix may sit before).
const PROTECTED_SEGMENT = /(^|\/)(zips|pdf-title-backup)\//;
const MAX_UPLOAD_EXPIRY_SECONDS = 300;
const CONTENT_MD5 = /^[A-Za-z0-9+/]{22}==$/;
/** Most one ranged read returns: a PDF xref table section of ~400,000 entries, 20 bytes each. */
const MAX_RANGE_BYTES = 8 * 1024 * 1024;

const BACKENDS = {
  minio: () => require('./minio'),
  azure: () => require('./azureBlob')
};

const backendName = config.storageBackend;

if (!BACKENDS[backendName]) {
  throw new Error(
    `[storage] unknown STORAGE_BACKEND "${backendName}" — expected one of: ` +
    `${Object.keys(BACKENDS).join(', ')}`
  );
}

const backend = BACKENDS[backendName]();

/**
 * A short-lived, read-only URL for downloading an object directly.
 *
 * Read-only and time-limited in both backends: a download link that could write or delete would
 * turn a leaked URL into document loss.
 *
 * @param {string} key
 * @param {object} [opts]
 * @param {number} [opts.expirySeconds=300]
 * @param {string} [opts.fileName]  suggested filename for the browser
 * @param {string} [opts.inlineType]  signs `inline` and this Content-Type; absent = attachment
 * @returns {Promise<string>}
 */
function getDownloadUrl(key, opts) {
  return backend.getDownloadUrl(key, opts);
}

/** One exact object key: non-empty, relative, no `.`/`..`/empty segment, no backslash or control. */
function isExactKey(key) {
  return typeof key === 'string' && key !== '' && !key.includes('\\') &&
    ![...key].some((c) => c.charCodeAt(0) < 0x20 || c === '\u007f') &&
    key.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function refuse(op, reason, fields) {
  logger.warn(`[storage] ${op} refused: ${reason}`, fields);
  return new Error(`[storage] ${op} refused: ${reason}`);
}

/** The backup key for an original. Fixed per original, so a restore can be paired with it. */
function backupKeyFor(key) {
  return `${BACKUP_PREFIX}${key}`;
}

/**
 * A short-lived URL that can write one exact object, for a worker that holds no storage credential.
 *
 * Never for a key under `zips/` or `pdf-title-backup/`. `contentMd5` is signed on MinIO, so the
 * store rejects a body with another digest; Content-Type cannot be bound by either backend.
 *
 * @param {string} key  the recorded key, before any environment prefix
 * @param {object} [opts]
 * @param {number} [opts.expirySeconds=300]  1 to 300
 * @param {string} [opts.contentMd5]  base64 MD5 of the exact body the worker will PUT
 * @returns {Promise<string>}
 */
async function getUploadUrl(key, { expirySeconds = MAX_UPLOAD_EXPIRY_SECONDS, contentMd5 } = {}) {
  const fields = { key: String(key), expirySeconds };
  if (!isExactKey(key)) throw refuse('upload URL', 'not one exact key', fields);
  if (PROTECTED_SEGMENT.test(key)) throw refuse('upload URL', 'key is under zips/ or pdf-title-backup/', fields);
  if (!Number.isInteger(expirySeconds) || expirySeconds < 1 || expirySeconds > MAX_UPLOAD_EXPIRY_SECONDS) {
    throw refuse('upload URL', `expiry must be 1 to ${MAX_UPLOAD_EXPIRY_SECONDS} seconds`, fields);
  }
  if (contentMd5 !== undefined && !CONTENT_MD5.test(contentMd5)) {
    throw refuse('upload URL', 'contentMd5 is not a base64 MD5', fields);
  }
  const url = await backend.getUploadUrl(key, { expirySeconds, contentMd5 });
  // Never log the URL itself: its signature is a write credential until it expires.
  logger.info('[storage] upload URL issued', { key, expirySeconds, md5Bound: Boolean(contentMd5) });
  return url;
}

/**
 * Server-side copy between an original and its backup, only if the source still has `ifSourceEtag`.
 *
 * Two pairings only: backup (`dest === backupKeyFor(src)`, refused when that backup exists, so a
 * later run never overwrites the first, untouched copy) and restore (`src === backupKeyFor(dest)`).
 *
 * @param {string} src
 * @param {string} dest
 * @param {{ifSourceEtag: string}} opts  etag from statObject(src)
 * @returns {Promise<{etag: string|null, versionId: string|null}>} the written object's etag and
 *   version; versionId is null when the store keeps no versions
 */
async function copyObject(src, dest, { ifSourceEtag } = {}) {
  const fields = { src: String(src), dest: String(dest) };
  if (!isExactKey(src) || !isExactKey(dest)) throw refuse('copy', 'not one exact key', fields);
  const isBackup = dest === backupKeyFor(src) && !PROTECTED_SEGMENT.test(src);
  const isRestore = src === backupKeyFor(dest) && !PROTECTED_SEGMENT.test(dest);
  if (!isBackup && !isRestore) throw refuse('copy', 'dest is neither the backup of src nor its original', fields);
  if (typeof ifSourceEtag !== 'string' || !ifSourceEtag) throw refuse('copy', 'ifSourceEtag is required', fields);
  if (isBackup && await backend.statObject(dest)) {
    throw Object.assign(refuse('copy', 'backup already exists', fields), { code: 'BACKUP_EXISTS' });
  }
  const result = await backend.copyObject(src, dest, { ifSourceEtag });
  logger.info(`[storage] ${isBackup ? 'backup' : 'restore'} copied`, { ...fields, etag: result.etag });
  return result;
}

/**
 * Size, type and etag of a stored object, without reading it.
 *
 * @param {string} key
 * @returns {Promise<{size: number, contentType: string|null, etag: string|null,
 *   versionId: string|null}|null>} null when the object is absent. The etag is opaque: pass it
 *   back to copyObject on the same backend.
 */
function statObject(key) {
  return backend.statObject(key);
}

/**
 * `length` bytes of one original or its backup from `offset`, optionally pinned to one version.
 *
 * Shorter than `length` only when the object ends first. More bytes than asked (a store that
 * ignored the range) is refused, since they would not start at `offset`.
 *
 * @param {string} key
 * @param {number} offset  0 or more
 * @param {number} length  1 to MAX_RANGE_BYTES
 * @param {{versionId?: string|null}} [opts]  read this version, as statObject or copyObject gave it
 * @returns {Promise<Buffer>}
 */
async function readRange(key, offset, length, { versionId } = {}) {
  const fields = { key: String(key), offset, length, versionId };
  if (!isExactKey(key)) throw refuse('range read', 'not one exact key', fields);
  const original = key.startsWith(BACKUP_PREFIX) ? key.slice(BACKUP_PREFIX.length) : key;
  if (PROTECTED_SEGMENT.test(original)) {
    throw refuse('range read', 'key is neither an original nor its backup', fields);
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw refuse('range read', 'offset must be a non-negative integer', fields);
  }
  if (!Number.isInteger(length) || length < 1 || length > MAX_RANGE_BYTES) {
    throw refuse('range read', `length must be 1 to ${MAX_RANGE_BYTES} bytes`, fields);
  }
  if (versionId !== undefined && versionId !== null && (typeof versionId !== 'string' || versionId === '')) {
    throw refuse('range read', 'versionId must be a non-empty string', fields);
  }
  const stream = await backend.getRangeStream(key, offset, length, { versionId: versionId || undefined });
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    // Leaving the loop destroys the stream, so an unranged body is never drained.
    if (total > length) throw refuse('range read', 'store returned more bytes than asked', fields);
    chunks.push(chunk);
  }
  logger.debug('[storage] range read', { ...fields, bytes: total });
  return Buffer.concat(chunks, total);
}

/**
 * Store a local file under `key`.
 *
 * @returns {Promise<string>} the key as actually stored, which may differ from the input — the
 *   MinIO backend prepends an environment prefix. Callers that record the key must use the
 *   value they passed in, not this one, so the record stays environment-independent.
 */
function putFile(key, filePath, contentType) {
  return backend.putFile(key, filePath, contentType);
}

/**
 * Read an object as a stream, for bytes too large to buffer.
 *
 * @returns {Promise<import('stream').Readable>}
 */
function getObjectStream(key) {
  return backend.getObjectStream(key);
}

/**
 * Write a stream of UNKNOWN length under `key` — the backend multiparts it.
 *
 * @returns {Promise<string>} the key as actually stored; see putFile on why callers record the
 *   value they passed in instead.
 */
function putObjectStream(key, stream, contentType) {
  return backend.putObjectStream(key, stream, contentType);
}

/**
 * Delete an object. Absent is not an error, in both backends.
 *
 * `versionId` deletes that one version, and only of a backup: in a versioned bucket a plain delete
 * keeps the bytes behind a delete marker, but a version of an original is its history.
 *
 * @param {string} key
 * @param {{versionId?: string|null}} [opts]
 */
function removeObject(key, { versionId } = {}) {
  if (versionId) {
    const fields = { key: String(key) };
    if (!isExactKey(key) || !String(key).startsWith(BACKUP_PREFIX)) {
      throw refuse('version delete', 'key is not a backup', fields);
    }
    return backend.removeObject(key, { versionId });
  }
  return backend.removeObject(key);
}

module.exports = {
  getDownloadUrl, getUploadUrl, copyObject, statObject, putFile, getObjectStream, putObjectStream,
  removeObject, backupKeyFor, readRange, MAX_RANGE_BYTES
};
