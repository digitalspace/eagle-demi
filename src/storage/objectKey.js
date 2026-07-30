'use strict';

/**
 * Resolve a stored document key to the key that actually exists in this environment's bucket.
 *
 * Why this exists: a document's key is recorded by eagle-api relative to the PRODUCTION
 * bucket — `etl/<project-slug>/<hash>.pdf`. Non-production buckets were populated by copying
 * prod into a sub-prefix named after the prod bucket, so the same object lives one level
 * deeper. Measured in dev: bucket `asnpnn` contains 92,472 objects under `ozwdez/`, and
 * `etl/` does not exist at the bucket root at all. That mismatch is why every download 404'd.
 *
 * Kept as one tiny function rather than scattered string concatenation so there is a single
 * place to delete when documents move to Azure Blob with a clean, uniform key layout.
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
