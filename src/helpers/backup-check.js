'use strict';

/**
 * Asked before anything rewrites an original. Reads blob properties only: an archived blob refuses
 * Get Blob, and the reader role never needs content. Every doubt (unset, unreachable, bad) refuses.
 */

const config = require('../config');
const { logger } = require('../utils/logger');

let cached = null;

/** Keyless container client for the configured backup, built once per account and container. */
function containerClientFor(account, container) {
  if (!cached || cached.account !== account || cached.container !== container) {
    // Required here so @azure/storage-blob loads only when a backup is checked.
    const store = require('../storage/azureBlob').createBlobClientFor(account, { container });
    cached = { account, container, client: store.getContainerClient() };
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
 * Multipart ETags are compared with the source ETag the copy recorded: the gate has no live
 * sha256, and size alone misses a same-size rewrite.
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

/** A read failing for any cause other than BlobNotFound is logged, then answered `no-backup`. */
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
