'use strict';

/**
 * A clean upload goes to the object store with its requested `read`, capped at the project's;
 * any other scan result quarantines the file and rejects the row.
 */

const crypto = require('crypto');
const path = require('path');
const { Readable } = require('stream');
const { logger } = require('../utils/logger');
const audit = require('../utils/audit');
const documents = require('../repositories/documents');
const syncOut = require('../sync-out');
const { DOCUMENT } = require('../sync-out/kinds');
const extraction = require('../extraction/enqueue');
const { decide, extensionOf, isUpdateImage, IMAGE_HEAD_BYTES } = require('./decision');
const { moveToQuarantine } = require('./blobs');
const { indexDocumentsNow } = require('../search/document-query');
const { capRead, levelOfRead, readForLevel, systemAccess } = require('../helpers/access-sql');

/**
 * Read fields to settle, capped at the project as it is now (it may have narrowed while pending)
 * and below level 4: only `publishOnRelease` on a public project publishes.
 */
async function releaseAccess(row, projects) {
  const wantsPublish = row.publishOnRelease === true;
  if (!Array.isArray(row.requestedRead) && !wantsPublish) return { fields: {}, publish: false };
  const project = await projects.getById(systemAccess(), row.projectId);
  if (!project) {
    logger.warn('[intake] project not found, released with an empty read list', {
      documentId: row.id, projectId: row.projectId
    });
  }
  const fields = {};
  if (Array.isArray(row.requestedRead)) {
    // The system read skips a sealed project too; a request already sealed stays sealed.
    const sealed = levelOfRead(row.requestedRead) === 0 ? row.requestedRead : [];
    const capped = project ? capRead(row.requestedRead, project.read) : sealed;
    Object.assign(fields, { read: levelOfRead(capped) === 4 ? readForLevel(3) : capped, isPublished: false });
  }
  const publicProject = Boolean(project) && levelOfRead(project.read) === 4;
  if (wantsPublish && !publicProject) fields.publishRefused = 'project-not-public';
  return { fields, publish: wantsPublish && publicProject };
}

/** The row's own key, else `<projectId>/<32 hex>.<ext>`, the shape the upload controller writes. */
function objectKeyFor(row) {
  if (row.s3Key) return row.s3Key;
  const name = String(row.id).replace(/-/g, '') + (row.fileExt ? `.${row.fileExt}` : '');
  return path.posix.join(String(row.projectId), name);
}

const bareEtag = (etag) => String(etag).replace(/"/g, '');

/** Whether an Update upload's bytes are the image its names say; reads only the first bytes. */
async function isUpdateImageBlob(client, row, stat) {
  if (!(stat.size > 0)) return false;
  const length = Math.min(IMAGE_HEAD_BYTES, stat.size);
  const stream = await client.getRangeStream(row.id, 0, length, { ifMatch: stat.etag || undefined });
  const extensions = [row.fileExt, extensionOf(row.documentFileName)].filter(Boolean);
  return isUpdateImage({
    head: Buffer.concat(await stream.toArray()), size: stat.size, contentType: stat.contentType, extensions
  });
}

/** Copy the upload to the object store, hashing and counting the bytes as they pass. */
async function copyToStore(client, id, nrs, key, contentType) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const source = await client.getObjectStream(id);
  async function* tapped() {
    for await (const chunk of source) {
      hash.update(chunk);
      bytes += chunk.length;
      yield chunk;
    }
  }
  await nrs.putObjectStream(key, Readable.from(tapped(), { objectMode: false }), contentType || undefined);
  return { fileSize: bytes, uploadSha256: hash.digest('hex') };
}

/** Publish a released row its uploader asked to publish, as `setLevel` does, with a system audit row. */
async function publish(row, settledRead) {
  try {
    await documents.setPublished(row.id, row.projectId, 4,
      { levelHeldAt: documents.levelHoldAfter({ ...row, read: settledRead }, 4, null) });
  } catch (err) {
    logger.error('[intake] publish on release failed; the row stays at its capped level', {
      documentId: row.id, error: err.message, stack: err.stack
    });
    return;
  }
  audit.auditEvent(null, {
    action: 'record.widen',
    targetType: 'document',
    targetId: row.id,
    projectId: row.projectId,
    detail: {
      from: levelOfRead(settledRead), to: 4, confirmed: false,
      reason: 'publish on upload', requestedBy: row.publishRequestedBy ?? null
    }
  });
}

/** A step after the release has landed: a failure is logged and never undoes it. */
async function quietly(step, row, run) {
  try {
    await run();
  } catch (err) {
    logger.error(`[intake] ${step} after release failed`, { documentId: row.id, error: err.message, stack: err.stack });
  }
}

/**
 * Index the saved row, then queue its Eagle copy and its extraction. Separate queues, so Eagle
 * never waits for docling.
 */
async function afterRelease(saved) {
  if (!saved || saved.scanStatus !== 'clean') {
    logger.warn('[intake] released row not readable as clean; index and queues skipped', {
      documentId: saved ? saved.id : null
    });
    return;
  }
  await indexDocumentsNow([saved]);
  await quietly('sync-out enqueue', saved, () => syncOut.enqueueQuietly(saved, { kind: DOCUMENT }));
  await quietly('extraction enqueue', saved, () => extraction.enqueueExtraction(saved, 'intake'));
}

/** `listed` is the pending listing's few columns; what the uploader asked for is on the full row. */
async function release(listed, scan, deps) {
  const { store, blobs, nrs, projects } = deps;
  const row = await store.findById(listed.id);
  if (!row) {
    logger.warn('[intake] row gone before release', { documentId: listed.id });
    return { outcome: 'raced', sizeBytes: null };
  }
  const client = blobs.staging();
  const stat = await client.statObject(listed.id);
  if (!stat) {
    logger.warn('[intake] clean result but the upload is gone; the sweep will reject it', { documentId: listed.id });
    return { outcome: 'missing', sizeBytes: null };
  }
  // The client may overwrite while its upload link lives; the new bytes get their own scan and tag.
  if (scan.eTag && stat.etag && bareEtag(scan.eTag) !== bareEtag(stat.etag)) {
    logger.warn('[intake] clean result is for an overwritten upload, ignored', { documentId: listed.id });
    return { outcome: 'stale', sizeBytes: stat.size };
  }
  if (row.documentSource === documents.UPDATE_SOURCE && !(await isUpdateImageBlob(client, row, stat))) {
    return reject(listed, scan, 'not-an-image', deps);
  }

  const key = objectKeyFor(row);
  const copied = await copyToStore(client, listed.id, nrs, key, stat.contentType);
  const access = await releaseAccess(row, projects);
  const settled = await store.settle(listed, {
    scanStatus: 'clean', scanResult: scan.result, scannedAt: scan.scannedAt, scanSizeBytes: stat.size,
    s3Key: key, ...copied, ...(stat.contentType ? { mimeType: stat.contentType } : {}), ...access.fields
  });
  if (!settled) {
    logger.warn('[intake] row settled by another writer while releasing', { documentId: listed.id, key });
    return { outcome: 'raced', sizeBytes: stat.size };
  }
  if (access.publish) await publish(row, access.fields.read || row.read || []);
  await client.removeObject(listed.id);
  await afterRelease(await store.findById(listed.id));
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
 * `scan.eTag` is the blob the result was read from. Throws on a storage or Cosmos failure; the row
 * stays pending.
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

/** Reject an upload Defender will never scan. No scan time, so its bytes do not count toward the cap. */
async function rejectUnscannable(row, reason, deps) {
  const { outcome } = await reject(row, { result: null, scannedAt: null, malwareNames: [] }, reason, deps);
  return outcome;
}

module.exports = { applyScanResult, rejectUnscannable };
