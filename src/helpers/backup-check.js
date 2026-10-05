'use strict';

/**
 * Is this exact stored object in the archive backup? Asked before anything rewrites an original.
 *
 * Reads the backup blob's properties only: an archived blob refuses Get Blob, and the API's
 * reader role must never need content. Every doubt is a refusal, so a missing setting, an
 * unreachable account and a malformed answer all come back not ok.
 */

const config = require('../config');
const { createCredential } = require('../utils/azure-credential');
const { logger } = require('../utils/logger');

let cached = null;

/** Keyless container client for the configured backup, built once per account and container. */
function containerClientFor(account, container) {
  if (!cached || cached.account !== account || cached.container !== container) {
    const { BlobServiceClient } = require('@azure/storage-blob');
    const service = new BlobServiceClient(`https://${account}.blob.core.windows.net`, createCredential());
    cached = { account, container, client: service.getContainerClient(container) };
  }
  return cached.client;
}

// A HEAD error has no body, so the SDK carries x-ms-error-code in `details` (see src/storage/azureBlob.js).
function errorCode(err) {
  return err && (err.code || (err.details && err.details.errorCode));
}

/** ETag as hex, without the quotes S3 and Azure wrap it in. */
function bareEtag(etag) {
  return String(etag).replace(/"/g, '').trim().toLowerCase();
}

// A multipart ETag is the MD5 of the part MD5s plus "-<parts>", not an MD5 of the bytes.
const MULTIPART_ETAG = /^[0-9a-f]{32}-\d+$/;
const SINGLE_ETAG = /^[0-9a-f]{32}$/;

/**
 * Does the live object's ETag prove it is the bytes that were backed up?
 *
 * Single-part: the ETag is the content MD5, compared with the blob's stored Content-MD5.
 * Multipart: compared with the source ETag the copy recorded, because the gate has no sha256 of
 * the live object to set against the recorded one, and size alone misses a same-size rewrite.
 */
function etagMatches(etag, props) {
  if (SINGLE_ETAG.test(etag)) {
    return Boolean(props.contentMD5) && Buffer.from(props.contentMD5).toString('hex') === etag;
  }
  if (MULTIPART_ETAG.test(etag)) {
    const recorded = props.metadata && props.metadata.sourceetag;
    return Boolean(recorded) && bareEtag(recorded) === etag;
  }
  return false;
}

/** Error fields safe to log: no request object, and no query string that could hold a signature. */
function safeError(err) {
  const message = String((err && err.message) || err).replace(/\?\S*/g, '?<redacted>');
  return { error: message, code: errorCode(err) || null, statusCode: (err && err.statusCode) || null };
}

/**
 * `{ ok: true }` when the backup blob for `s3Key` is archived and matches the live object's
 * `stat` (`{ size, etag }`), else `{ ok: false, reason }` with reason one of `no-backup`,
 * `size-mismatch`, `md5-mismatch`, `not-archive`, `backup-unconfigured`. A read that fails for any
 * cause other than BlobNotFound is logged and answered `no-backup`: the backup is not confirmed.
 *
 * `options` takes `account`, `container` and `containerClient` so tests can pass a fake.
 */
async function assertBackedUp(s3Key, stat, options = {}) {
  const account = 'account' in options ? options.account : config.backupAccount;
  const container = 'container' in options ? options.container : config.backupContainer;
  if (!account || !container) return { ok: false, reason: 'backup-unconfigured' };
  if (!s3Key || !stat || !Number.isFinite(stat.size) || !stat.etag) {
    throw new TypeError('[backup-check] an s3Key and a stat with size and etag are required');
  }

  let props;
  try {
    const client = options.containerClient || containerClientFor(account, container);
    props = await client.getBlobClient(s3Key).getProperties();
  } catch (err) {
    if (errorCode(err) === 'BlobNotFound') return { ok: false, reason: 'no-backup' };
    logger.error('[backup-check] could not read the backup blob, treated as not backed up', {
      s3Key, account, container, ...safeError(err)
    });
    return { ok: false, reason: 'no-backup' };
  }

  if (props.contentLength !== stat.size) return { ok: false, reason: 'size-mismatch' };
  if (!etagMatches(bareEtag(stat.etag), props)) return { ok: false, reason: 'md5-mismatch' };
  if (props.accessTier !== 'Archive') return { ok: false, reason: 'not-archive' };
  return { ok: true };
}

module.exports = { assertBackedUp };
