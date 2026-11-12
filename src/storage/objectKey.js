'use strict';

/**
 * Map a stored key to this bucket. eagle-api records keys relative to the prod bucket, and a
 * non-prod bucket may hold prod's copy under a prefix (dev bucket `asnpnn` under `ozwdez/`).
 */

const config = require('../config');

/**
 * @param {string} storedKey  the key as recorded on the document (e.g. `etl/foo/bar.pdf`)
 * @returns {string}          the key to use against the configured bucket
 */
function resolveObjectKey(storedKey) {
  if (!storedKey) return storedKey;

  const prefix = (config.minioKeyPrefix || '').replace(/^\/+|\/+$/g, '');
  if (!prefix) return storedKey;

  // Idempotent: a key already carrying the prefix must not gain a second one, otherwise a
  // re-seed or a already-normalised key silently becomes unfetchable.
  if (storedKey === prefix || storedKey.startsWith(`${prefix}/`)) return storedKey;

  return `${prefix}/${storedKey.replace(/^\/+/, '')}`;
}

module.exports = { resolveObjectKey };
