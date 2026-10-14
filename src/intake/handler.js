'use strict';

/**
 * `intakeScanResult`: one Defender for Storage scan result for an upload in `incoming/<documentId>`.
 * Clean files go to the object store and the row takes its requested `read` list, capped at the project's
 * current one; every other result moves the file to quarantine and rejects the row.
 */

const path = require('path');
const config = require('../config');
const { logger } = require('../utils/logger');
const { decide, SWEEP_REASONS } = require('./decision');
const { moveToQuarantine } = require('./blobs');
const { capRead, levelOfRead, systemAccess } = require('../helpers/access-sql');

const SCAN_EVENT = 'Microsoft.Security.MalwareScanningResult';

function defaultDeps() {
  return {
    store: require('./store'), blobs: require('./blobs'), nrs: require('../storage'),
    projects: require('../repositories/projects')
  };
}

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

/** The document id a scanned blob URI names, or null unless it is `<intake account>/<incoming>/<id>`. */
function documentIdFrom(blobUri) {
  let url;
  try { url = new URL(blobUri); } catch { return null; }
  const { storageAccount, incomingContainer } = config.intake;
  if (url.hostname.toLowerCase() !== `${storageAccount}.blob.core.windows.net`.toLowerCase()) return null;
  const [container, name, ...rest] = url.pathname.slice(1).split('/');
  if (container !== incomingContainer || !name || rest.length > 0) return null;
  try { return decodeURIComponent(name); } catch { return null; }
}

/** The row's own key, else `<projectId>/<32 hex>.<ext>`, the shape the upload controller writes. */
function objectKeyFor(row) {
  if (row.s3Key) return row.s3Key;
  const name = String(row.id).replace(/-/g, '') + (row.fileExt ? `.${row.fileExt}` : '');
  return path.posix.join(String(row.projectId), name);
}

const bareEtag = (etag) => String(etag).replace(/"/g, '');

async function release(row, data, scannedAt, { store, blobs, nrs, projects }) {
  const client = blobs.staging();
  const stat = await client.statObject(row.id);
  if (!stat) {
    logger.warn('[intake] clean result but the upload is gone; the sweep will reject it', { documentId: row.id });
    return { outcome: 'missing', sizeBytes: null };
  }
  // The client may overwrite while its upload link lives; the new bytes get their own scan and event.
  if (data.eTag && stat.etag && bareEtag(data.eTag) !== bareEtag(stat.etag)) {
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
    scanStatus: 'clean', scanResult: data.scanResultType, scannedAt, scanSizeBytes: stat.size,
    s3Key: key, ...read
  });
  if (!settled) {
    logger.warn('[intake] row settled by another writer while releasing', { documentId: row.id, key });
    return { outcome: 'raced', sizeBytes: stat.size };
  }
  await client.removeObject(row.id);
  return { outcome: 'clean', sizeBytes: stat.size };
}

async function reject(row, data, reason, scannedAt, { store, blobs }) {
  const stat = await moveToQuarantine(blobs.quarantine(), row.id);
  const malwareNames = (data.scanResultDetails && data.scanResultDetails.malwareNamesFound) || [];
  const sizeBytes = stat ? stat.size : null;
  const settled = await store.settle(row, {
    scanStatus: 'rejected', scanResult: data.scanResultType || null, scanRejectReason: reason,
    malwareNames, scannedAt, scanSizeBytes: sizeBytes, read: [], isPublished: false
  });
  logger.warn('intake quarantined', {
    documentId: row.id, result: data.scanResultType, reason, malwareNames, moved: Boolean(stat)
  });
  return { outcome: settled ? 'rejected' : 'raced', sizeBytes };
}

/**
 * Throws only on a failure worth a retry (storage or Cosmos); Event Grid redelivers. Anything
 * a retry cannot fix, such as an unknown document, is logged and returns.
 */
async function onScanResult(event, deps) {
  if (!config.intake.storageAccount) {
    logger.info('[intake] INTAKE_STORAGE_ACCOUNT is unset, scan result skipped');
    return;
  }
  if (!event || event.eventType !== SCAN_EVENT) {
    logger.debug(`[intake] ignoring event type '${event && event.eventType}'`);
    return;
  }
  const started = Date.now();
  const data = event.data || {};
  const result = data.scanResultType;
  const documentId = documentIdFrom(data.blobUri);
  if (!documentId) {
    logger.warn('[intake] scan result for a blob outside the intake container', { blobUri: data.blobUri });
    return;
  }

  const resolved = deps || defaultDeps();
  const row = await resolved.store.findById(documentId);
  if (!row || !row.scanStatus) {
    logger.warn('[intake] scan result for an unknown intake document', { documentId, result });
    return;
  }
  if (row.scanStatus !== 'pending') {
    const late = row.scanStatus === 'rejected' && SWEEP_REASONS.includes(row.scanRejectReason);
    logger.info(late ? 'intake late result ignored' : 'intake result already applied', {
      documentId, result, scanStatus: row.scanStatus, reason: row.scanRejectReason || null
    });
    return;
  }

  const decision = decide(result);
  const scannedAt = data.scanFinishedTimeUtc || new Date().toISOString();
  const { outcome, sizeBytes } = decision.status === 'clean'
    ? await release(row, data, scannedAt, resolved)
    : await reject(row, data, decision.reason, scannedAt, resolved);
  logger.info('intake scanned', { documentId, result, outcome, sizeBytes, durationMs: Date.now() - started });
}

module.exports = { onScanResult, documentIdFrom, objectKeyFor, SCAN_EVENT };
