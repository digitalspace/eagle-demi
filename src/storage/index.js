'use strict';

/**
 * Object storage — the single entry point every caller uses.
 *
 * Four operations, because that is all the application does with stored files: read one into a
 * buffer for extraction, hand out a short-lived download URL, write an upload, and describe
 * itself for logging. Nothing here exposes a bucket, a container, or a client.
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
 * Read a stored object into memory.
 *
 * Buffers the whole file, which is what docling needs. Median document is 0.74 MB but the tail
 * is heavy — extraction already batches pages for exactly this reason.
 *
 * @param {string} key  the `s3Key` recorded on the document
 * @returns {Promise<Buffer>}
 */
function getBuffer(key) {
  return backend.getBuffer(key);
}

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

/** Non-secret description of the active backend, for logs and `/api/config`. */
function describe() {
  return backend.describe();
}

module.exports = { getBuffer, getDownloadUrl, putFile, describe, backendName };
