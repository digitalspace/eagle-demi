'use strict';

/**
 * Object storage — the single entry point every caller uses.
 *
 * Hand out a short-lived download URL, write an upload, stream an object in or out, delete one.
 * Nothing here exposes a bucket, a container, or a client.
 *
 * The backend is chosen by an EXPLICIT `STORAGE_BACKEND` value and an unknown value throws at
 * load. Inferring it from whichever credentials happen to be set is how this repo previously
 * activated the wrong data layer on deploy: `COSMOS_ENDPOINT` was already populated, so a
 * `Boolean(...)` switch silently flipped and every switched route 500'd. A backend switch
 * decides where documents are read from and written to — it must never be a side effect.
 */

const config = require('../config');

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
 * @returns {Promise<string>}
 */
function getDownloadUrl(key, opts) {
  return backend.getDownloadUrl(key, opts);
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

/** Delete an object. Absent is not an error, in both backends. */
function removeObject(key) {
  return backend.removeObject(key);
}

module.exports = {
  getDownloadUrl, putFile, getObjectStream, putObjectStream, removeObject
};
