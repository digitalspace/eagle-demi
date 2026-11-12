'use strict';

/**
 * Object storage, the single entry point every caller uses; no bucket, container or client leaks.
 * The backend comes from an explicit `STORAGE_BACKEND`, never inferred from which credentials exist.
 */

const { Readable } = require('stream');
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
 * A short-lived, read-only download URL, so a leaked link cannot write or delete.
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
 * A short-lived URL that writes one exact object, never under `zips/` or `pdf-title-backup/`.
 * MinIO signs `contentMd5`; neither backend can bind Content-Type.
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
 * Server-side copy, original to backup or back, if the source still has `ifSourceEtag`. An existing
 * backup is never overwritten.
 *
 * @param {string} src
 * @param {string} dest
 * @param {{ifSourceEtag: string}} opts  etag from statObject(src)
 * @returns {Promise<{etag: string|null, versionId: string|null}>} versionId null when unversioned
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
 * @param {string} key
 * @returns {Promise<{size: number, contentType: string|null, etag: string|null, versionId: string|null, lastModified: Date|null}|null>}
 *   null when absent; the etag is opaque, pass it back to copyObject on the same backend
 */
function statObject(key) {
  return backend.statObject(key);
}

/** Throws unless `key` is one original or its backup, and `versionId` is absent or non-empty. */
function checkReadKey(op, key, versionId, fields) {
  if (!isExactKey(key)) throw refuse(op, 'not one exact key', fields);
  const original = key.startsWith(BACKUP_PREFIX) ? key.slice(BACKUP_PREFIX.length) : key;
  if (PROTECTED_SEGMENT.test(original)) throw refuse(op, 'key is neither an original nor its backup', fields);
  if (versionId !== undefined && versionId !== null && (typeof versionId !== 'string' || versionId === '')) {
    throw refuse(op, 'versionId must be a non-empty string', fields);
  }
}

function checkRange(op, offset, length, fields) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw refuse(op, 'offset must be a non-negative integer', fields);
  if (!Number.isSafeInteger(length) || length < 1) throw refuse(op, 'length must be a positive integer', fields);
}

/**
 * `length` bytes of one original or its backup from `offset`, optionally pinned to one version.
 * More bytes than asked means the store ignored the range, so it is refused.
 *
 * @param {string} key
 * @param {number} offset  0 or more
 * @param {number} length  1 to MAX_RANGE_BYTES
 * @param {{versionId?: string|null}} [opts]  read this version, as statObject or copyObject gave it
 * @returns {Promise<Buffer>}
 */
async function readRange(key, offset, length, { versionId } = {}) {
  const fields = { key: String(key), offset, length, versionId };
  checkReadKey('range read', key, versionId, fields);
  checkRange('range read', offset, length, fields);
  if (length > MAX_RANGE_BYTES) throw refuse('range read', `length must be 1 to ${MAX_RANGE_BYTES} bytes`, fields);
  const chunks = [];
  let total = 0;
  for await (const chunk of await openRange('range read', key, offset, length, { versionId }, fields)) {
    total += chunk.length;
    chunks.push(chunk);
  }
  logger.debug('[storage] range read', { ...fields, bytes: total });
  return Buffer.concat(chunks, total);
}

/** The range's chunks, failing past `length` bytes. Leaving the loop early destroys the store stream. */
async function* capped(op, stream, length, fields) {
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > length) throw refuse(op, 'store returned more bytes than asked', fields);
    yield chunk;
  }
}

async function openRange(op, key, offset, length, { versionId, ifMatch }, fields) {
  const stream = await backend.getRangeStream(key, offset, length,
    { versionId: versionId || undefined, ifMatch: ifMatch || undefined });
  return capped(op, stream, length, fields);
}

/**
 * Store a local file under `key`.
 * @returns {Promise<string>} the stored key, which MinIO prefixes; callers record the key they passed
 */
function putFile(key, filePath, contentType) {
  return backend.putFile(key, filePath, contentType);
}

/**
 * Read an object as a stream. Any option limits the key to an original or its backup; a range has
 * no size cap, and `ifMatch` (ranged only) gets a 412 unless the etag still matches.
 *
 * @param {string} key
 * @param {{offset?: number, length?: number, versionId?: string|null, ifMatch?: string}} [opts]
 * @returns {Promise<import('stream').Readable>}
 */
async function getObjectStream(key, { offset, length, versionId, ifMatch } = {}) {
  const ranged = offset !== undefined || length !== undefined;
  if (!ranged && versionId === undefined && ifMatch === undefined) return backend.getObjectStream(key);
  const fields = { key: String(key), offset, length, versionId };
  checkReadKey('stream read', key, versionId, fields);
  if (ifMatch !== undefined && (!ranged || typeof ifMatch !== 'string' || ifMatch === '')) {
    throw refuse('stream read', 'ifMatch must be a non-empty string on a ranged read', fields);
  }
  if (!ranged) return backend.getObjectStream(key, { versionId: versionId || undefined });
  checkRange('stream read', offset, length, fields);
  logger.debug('[storage] range stream', fields);
  return Readable.from(await openRange('stream read', key, offset, length, { versionId, ifMatch }, fields),
    { objectMode: false });
}

/**
 * Write a stream of unknown length under `key`; the backend multiparts it.
 * @returns {Promise<string>} the stored key; see putFile
 */
function putObjectStream(key, stream, contentType) {
  return backend.putObjectStream(key, stream, contentType);
}

/**
 * Delete an object; absent is not an error. `versionId` deletes one version, of a backup only,
 * since a version of an original is its history.
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
