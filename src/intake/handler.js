'use strict';

/**
 * One Defender for Storage scan result, read by the sweep from an upload in `incoming/<documentId>`.
 * Clean files go to the object store and the row takes its requested `read` list, capped at the project's
 * current one; every other result moves the file to quarantine and rejects the row.
 */

const path = require('path');
const { logger } = require('../utils/logger');
const { decide } = require('./decision');
const { moveToQuarantine } = require('./blobs');
const { capRead, levelOfRead, systemAccess } = require('../helpers/access-sql');

/**
 * The row's requested read list, capped again at its project's read list as it stands now: the
 * project may have narrowed while the upload was pending, and the cascade does not run on release.
 */
async function releasedRead(row, projects) {
  const project = await projects.getById(systemAccess(), row.projectId);
  if (!project) {
    logger.warn('[intake] project not found, released with an empty read list', {
      documentId: row.id, projectId: row.projectId
    });
    // The system read skips a sealed project too; a request already sealed stays sealed.
    return levelOfRead(row.requestedRead) === 0 ? row.requestedRead : [];
  }
  return capRead(row.requestedRead, project.read);
}

/** The row's own key, else `<projectId>/<32 hex>.<ext>`, the shape the upload controller writes. */
function objectKeyFor(row) {
  if (row.s3Key) return row.s3Key;
  const name = String(row.id).replace(/-/g, '') + (row.fileExt ? `.${row.fileExt}` : '');
  return path.posix.join(String(row.projectId), name);
}

const bareEtag = (etag) => String(etag).replace(/"/g, '');

async function release(row, scan, { store, blobs, nrs, projects }) {
  const client = blobs.staging();
  const stat = await client.statObject(row.id);
  if (!stat) {
    logger.warn('[intake] clean result but the upload is gone; the sweep will reject it', { documentId: row.id });
    return { outcome: 'missing', sizeBytes: null };
  }
  // The client may overwrite while its upload link lives; the new bytes get their own scan and tag.
  if (scan.eTag && stat.etag && bareEtag(scan.eTag) !== bareEtag(stat.etag)) {
    logger.warn('[intake] clean result is for an overwritten upload, ignored', { documentId: row.id });
    return { outcome: 'stale', sizeBytes: stat.size };
  }

  const key = objectKeyFor(row);
  await nrs.putObjectStream(key, await client.getObjectStream(row.id), stat.contentType || undefined);
  let read = {};
  if (Array.isArray(row.requestedRead)) {
    const capped = await releasedRead(row, projects);
    read = { read: capped, isPublished: capped.includes('public') };
  }
  const settled = await store.settle(row, {
    scanStatus: 'clean', scanResult: scan.result, scannedAt: scan.scannedAt, scanSizeBytes: stat.size,
    s3Key: key, ...read
  });
  if (!settled) {
    logger.warn('[intake] row settled by another writer while releasing', { documentId: row.id, key });
    return { outcome: 'raced', sizeBytes: stat.size };
  }
  await client.removeObject(row.id);
  return { outcome: 'clean', sizeBytes: stat.size };
}

async function reject(row, scan, reason, { store, blobs }) {
  const stat = await moveToQuarantine(blobs.quarantine(), row.id);
  const malwareNames = scan.malwareNames || [];
  const sizeBytes = stat ? stat.size : null;
  const settled = await store.settle(row, {
    scanStatus: 'rejected', scanResult: scan.result || null, scanRejectReason: reason,
    malwareNames, scannedAt: scan.scannedAt, scanSizeBytes: sizeBytes, read: [], isPublished: false
  });
  logger.warn('intake quarantined', {
    documentId: row.id, result: scan.result, reason, malwareNames, moved: Boolean(stat)
  });
  return { outcome: settled ? 'rejected' : 'raced', sizeBytes };
}

/**
 * Apply one scan result to a pending row: `{ result, scannedAt, eTag, malwareNames }`, where `eTag`
 * is the blob the result was read from. Throws on a storage or Cosmos failure; the row stays pending.
 * `deps`: `{ store, blobs, nrs, projects }`.
 */
async function applyScanResult(row, scan, deps) {
  const started = Date.now();
  const decision = decide(scan.result);
  const { outcome, sizeBytes } = decision.status === 'clean'
    ? await release(row, scan, deps)
    : await reject(row, scan, decision.reason, deps);
  logger.info('intake scanned', {
    documentId: row.id, result: scan.result, outcome, sizeBytes, durationMs: Date.now() - started
  });
  return outcome;
}

module.exports = { applyScanResult, objectKeyFor };
