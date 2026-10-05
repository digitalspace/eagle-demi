'use strict';

/**
 * PDF tab titles written into the stored original, by a worker that holds no storage credential.
 *
 * The worker asks for a lease on one document, reads a frozen backup through a GET link, writes
 * `original + one increment` through a PUT link for exactly `s3Key`, and reports back. This module
 * is the only caller of `storage.getUploadUrl` and `storage.copyObject`. Every step that fails
 * leaves the stored object whole: either the untouched original or a verified new object, and a
 * verify that fails copies the backup back. The record is the DEMI-owned field `pdfTitle`.
 *
 * Lease state lives in `pdfTitle.lease`, and every record write is guarded by the row's `_etag`,
 * so two workers on one document lose with 412 rather than both writing.
 */

const crypto = require('crypto');
const documents = require('../../repositories/documents');
const cosmos = require('../../db/cosmos-nosql');
const storage = require('../../storage');
const backupCheck = require('../../helpers/backup-check');
const { isPdf, isEligible, isCurrent, needsRestore } = require('../../helpers/pdf-title');
const { pdfTitleFor } = require('../../helpers/file-name');
const { levelOfRead, isDemiSeal } = require('../../helpers/access-sql');
const { serverError } = require('../../helpers/response');
const { logger } = require('../../utils/logger');

const LEASE_MS = 10 * 60 * 1000;
const BACKUP_GET_SECONDS = 300;
const PUT_SECONDS = 120;
/** Owner decision 6: larger files are skipped. */
const MAX_BYTES = 256 * 1024 * 1024;
/** An Info dictionary, one XMP packet and an xref: far below this. More means the writer misbehaved. */
const MAX_GROWTH = 1024 * 1024;
const PAGE_DEFAULT = 100;
const PAGE_MAX = 500;
/** Expired leases settled per work-list call, so one call stays short. */
const SWEEP_MAX = 20;

const SHA256 = /^[0-9a-f]{64}$/;
const MD5_B64 = /^[A-Za-z0-9+/]{22}==$/;

const LIST_FIELDS = [
  'id', 'projectId', 's3Key', 'displayName', 'documentFileName', 'vis', 'read', 'sealedAt',
  'mimeType', 'fileExt', 'fileSize', 'pdfTitle'
];

function nowIso() {
  return new Date().toISOString();
}

function bareEtag(etag) {
  return String(etag || '').replace(/"/g, '').trim().toLowerCase();
}

function md5Hex(b64) {
  return Buffer.from(b64, 'base64').toString('hex');
}

function recordOf(row) {
  return row && row.pdfTitle && typeof row.pdfTitle === 'object' ? row.pdfTitle : null;
}

/** The original length and hash recorded for this exact file, or null when it was never written. */
function originalFor(row) {
  const record = recordOf(row);
  if (!record || record.sourceKey !== row.s3Key || !Number.isInteger(record.originalLength) ||
      !record.originalSha256) {
    return null;
  }
  return { length: record.originalLength, sha256: record.originalSha256, etag: record.originalEtag || null };
}

/** The fields of the record that belong to this file, without lease state. A new key starts empty. */
function baseRecord(row) {
  const record = recordOf(row);
  if (!record || record.sourceKey !== row.s3Key) return { sourceKey: row.s3Key };
  // eslint-disable-next-line no-unused-vars
  const { lease, inFlight, ...rest } = record;
  return rest;
}

function isLive(lease, now = Date.now()) {
  return Boolean(lease) && Date.parse(lease.expiresAt) > now;
}

/** Why a row may not be titled, or null when it may. Size and shared key need the store and a query. */
function ineligibleReason(row) {
  if (isDemiSeal(row)) return 'sealed';
  if (!isPdf(row)) return 'not-pdf';
  if (!row.s3Key) return 'no-file';
  if (levelOfRead(row.read) !== 4) return 'not-public';
  if (pdfTitleFor(row) === null) return 'no-public-name';
  return isEligible(row) ? null : 'not-eligible';
}

/** `title` when the row wants a title written, `restore` when its title must come out, else null. */
function modeFor(row) {
  if (isDemiSeal(row)) return null;
  if (needsRestore(row)) return 'restore';
  if (isEligible(row) && !isCurrent(row)) return 'title';
  return null;
}

function partitionOf(row) {
  return row.projectId === null || row.projectId === undefined ? null : String(row.projectId);
}

/** Etag-guarded write of the whole record; returns the row as stored. 412 when the row moved. */
async function save(row, record) {
  const stored = await cosmos.patch(documents.CONTAINER, String(row.id), partitionOf(row),
    [{ op: 'set', path: '/pdfTitle', value: record }], undefined, row._etag);
  return stored || { ...row, pdfTitle: record };
}

function isPreconditionFailed(err) {
  return Boolean(err) && (err.code === 412 || err.statusCode === 412);
}

/** Keys from `keys` that more than one row stores. */
async function sharedKeys(keys) {
  const unique = [...new Set(keys.filter(Boolean))];
  if (unique.length === 0) return new Set();
  const { items } = await cosmos.query(documents.CONTAINER, {
    query: 'SELECT c.id, c.s3Key FROM c WHERE ARRAY_CONTAINS(@keys, c.s3Key)',
    parameters: [{ name: '@keys', value: unique }]
  });
  const counts = new Map();
  for (const item of items) counts.set(item.s3Key, (counts.get(item.s3Key) || 0) + 1);
  return new Set([...counts].filter(([, n]) => n > 1).map(([key]) => key));
}

/** Whole-object sha256 and the sha256 of its first `prefixLength` bytes, in one read. */
async function hashObject(key, prefixLength) {
  const whole = crypto.createHash('sha256');
  const prefix = crypto.createHash('sha256');
  let length = 0;
  const stream = await storage.getObjectStream(key);
  for await (const chunk of stream) {
    whole.update(chunk);
    if (Number.isInteger(prefixLength) && length < prefixLength) {
      prefix.update(chunk.subarray(0, Math.min(chunk.length, prefixLength - length)));
    }
    length += chunk.length;
  }
  return {
    length,
    sha256: whole.digest('hex'),
    prefixSha256: Number.isInteger(prefixLength) && length >= prefixLength ? prefix.digest('hex') : null
  };
}

/** Delete a short-lived backup by version, so no copy of it outlives the delete. Logged, never thrown. */
async function dropBackup(backupKey, versionId, fields) {
  try {
    let version = versionId;
    if (!version) {
      const stat = await storage.statObject(backupKey);
      if (!stat) return;
      version = stat.versionId;
    }
    await storage.removeObject(backupKey, version ? { versionId: version } : undefined);
    logger.info('[pdf-title] backup deleted', { ...fields, backupKey, versionId: version || null });
  } catch (err) {
    logger.error('[pdf-title] backup delete failed; left for the next lease or sweep', {
      ...fields, backupKey, error: err.message
    });
  }
}

/** Clear the lease and in-flight state, setting `extra` on the record. Returns the stored row. */
async function release(row, extra = {}) {
  return save(row, { ...baseRecord(row), ...extra, at: nowIso() });
}

/**
 * What a worker's skip records. A file never written is marked skipped for this title, so it is
 * not offered again. A titled file keeps `titled`, or a later withheld name would never be
 * restored. A restore that cannot run needs a person.
 */
function skipFields(row, lease, report) {
  if (!report) return {};
  if (lease.mode === 'restore') return { status: 'needs-review', reason: report.reason };
  if (originalFor(row) && recordOf(row).status === 'titled') return { reason: `retitle skipped: ${report.reason}` };
  return { status: 'skipped', reason: report.reason, title: lease.title };
}

function readOne(req) {
  return documents.readForWrite(req.params.id, req.query && req.query.project);
}

function refuse(res, status, reason, extra = {}) {
  return res.status(status).json({ error: reason, reason, ...extra });
}

// ---------------------------------------------------------------------------------------------
// Settle: the one place that decides what a lease ends as, for a worker report and for the sweep.
// ---------------------------------------------------------------------------------------------

/**
 * Copy the backup back over `s3Key`, check it equals the original, and park the row for review.
 * The backup and the in-flight record stay, so nothing a person needs to judge is lost.
 */
async function restoreFromBackup(row, reason, fields) {
  const record = recordOf(row);
  const { backupKey } = record.inFlight;
  let restored = false;
  try {
    const backup = await storage.statObject(backupKey);
    if (!backup) throw new Error('backup is missing');
    await storage.copyObject(backupKey, row.s3Key, { ifSourceEtag: backup.etag });
    const [put, ref] = await Promise.all([hashObject(row.s3Key), hashObject(backupKey)]);
    restored = put.length === record.lease.sourceSize && put.sha256 === ref.sha256;
  } catch (err) {
    logger.error('[pdf-title] restore from backup failed', { ...fields, error: err.message });
  }
  logger.error('[pdf-title] verify failed; needs review', { ...fields, reason, restored });
  return save(row, {
    ...baseRecord(row),
    inFlight: record.inFlight,
    status: 'needs-review',
    reason: restored ? reason : `${reason}; restore-unverified`,
    at: nowIso()
  });
}

/**
 * End a lease from the store's state. `report` is the worker's skip, if it sent one.
 *
 * - No in-flight write: nothing was ever signed for `s3Key`, so drop the backup and clear.
 * - The store holds the new object: verify it fully and record `titled` or `restored`.
 * - The store still holds the source: the PUT never landed; drop the backup and clear.
 * - Anything else: copy the backup back and set `needs-review`.
 */
async function settle(row, report = null) {
  const record = recordOf(row);
  const lease = record.lease;
  const fields = { id: row.id, s3Key: row.s3Key, leaseId: lease.leaseId };
  const skipped = skipFields(row, lease, report);

  if (!record.inFlight) {
    if (lease.backupKey) await dropBackup(lease.backupKey, lease.backupVersionId, fields);
    logger.info('[pdf-title] lease ended with no write', { ...fields, reason: report ? report.reason : 'expired' });
    return { row: await release(row, skipped), outcome: report ? 'skipped' : 'released' };
  }

  const { newLength, newSha256, newMd5, backupKey, backupVersionId } = record.inFlight;
  const stat = await storage.statObject(row.s3Key);

  if (stat && stat.size === newLength && bareEtag(stat.etag) === md5Hex(newMd5)) {
    const original = originalFor(row);
    const check = await hashObject(row.s3Key, original.length);
    if (check.sha256 !== newSha256 || check.prefixSha256 !== original.sha256) {
      return { row: await restoreFromBackup(row, 'hash-mismatch', fields), outcome: 'needs-review' };
    }
    const isRestore = lease.mode === 'restore';
    const done = await release(row, {
      status: isRestore ? 'restored' : 'titled',
      reason: null,
      title: isRestore ? null : lease.title,
      titledLength: isRestore ? null : newLength,
      titledSha256: isRestore ? null : newSha256
    });
    await dropBackup(backupKey, backupVersionId, fields);
    logger.info(`[pdf-title] ${isRestore ? 'restored' : 'titled'}`, { ...fields, length: newLength });
    return { row: done, outcome: isRestore ? 'restored' : 'titled' };
  }

  if (stat && stat.size === lease.sourceSize && bareEtag(stat.etag) === bareEtag(lease.sourceEtag)) {
    await dropBackup(backupKey, backupVersionId, fields);
    logger.info('[pdf-title] write never landed; source unchanged', { ...fields, reason: report ? report.reason : 'expired' });
    return { row: await release(row, skipped), outcome: report ? 'skipped' : 'released' };
  }

  return { row: await restoreFromBackup(row, stat ? 'unexpected-object' : 'object-missing', fields), outcome: 'needs-review' };
}

/** Settle leases past their expiry. Each is its own try: one bad row never stops the list. */
async function sweepExpired() {
  const { items } = await cosmos.query(documents.CONTAINER, {
    query: 'SELECT * FROM c WHERE IS_DEFINED(c.pdfTitle.lease.expiresAt) AND c.pdfTitle.lease.expiresAt < @now',
    parameters: [{ name: '@now', value: nowIso() }]
  }, { maxItemCount: SWEEP_MAX });
  let swept = 0;
  for (const row of items) {
    try {
      await settle(row);
      swept += 1;
    } catch (err) {
      logger.error('[pdf-title] sweep of an expired lease failed', { id: row.id, error: err.message });
    }
  }
  return swept;
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

/**
 * GET /documents/pdf-title/pending — settle expired leases, then one page of work.
 *
 * Rows come back as `{id, projectId, mode, title}`. A cross-partition page may be short or empty
 * while more rows exist: follow `continuation` until it is null.
 */
async function listPending(req, res) {
  try {
    const swept = await sweepExpired();
    const limit = Math.min(Math.max(parseInt(req.query && req.query.limit, 10) || PAGE_DEFAULT, 1), PAGE_MAX);
    const page = await cosmos.query(documents.CONTAINER, {
      query: `SELECT ${LIST_FIELDS.map(f => `c.${f}`).join(', ')} FROM c ` +
        "WHERE IS_DEFINED(c.s3Key) AND (ARRAY_CONTAINS(c.read, 'public') OR c.pdfTitle.status = 'titled')",
      parameters: []
    }, { maxItemCount: limit, continuationToken: (req.query && req.query.continuation) || undefined });

    const candidates = page.items
      .map(row => ({ row, mode: modeFor(row) }))
      .filter(({ row, mode }) => {
        const record = recordOf(row);
        if (!mode) return false;
        if (record && (record.lease || record.inFlight || record.status === 'needs-review')) return false;
        return mode === 'restore' || !(Number(row.fileSize) > MAX_BYTES);
      });
    const shared = await sharedKeys(candidates.map(({ row }) => row.s3Key));
    const items = candidates
      .filter(({ row }) => !shared.has(row.s3Key))
      .map(({ row, mode }) => ({
        id: row.id, projectId: row.projectId, mode, title: mode === 'title' ? pdfTitleFor(row) : null
      }));

    logger.info('[pdf-title] work list', { scanned: page.items.length, pending: items.length, swept });
    return res.json({ items, continuation: page.continuationToken || null, swept });
  } catch (err) {
    return serverError(res, err, '[pdf-title] work list failed');
  }
}

/**
 * POST /documents/:id/pdf-title/lease — checks, archive gate, lease, frozen backup, GET link.
 *
 * 409 with a reason when the row may not be leased, 412 when another worker won the race.
 */
async function lease(req, res) {
  let row;
  try {
    row = await readOne(req);
    if (!row) return refuse(res, 404, 'not-found');
    const record = recordOf(row);
    if (record && record.lease) return refuse(res, 409, isLive(record.lease) ? 'lease-held' : 'sweep-pending');
    if (record && record.status === 'needs-review') return refuse(res, 409, 'needs-review');
    if (record && record.inFlight) return refuse(res, 409, 'sweep-pending');

    const mode = modeFor(row);
    if (!mode) {
      const reason = ineligibleReason(row) || 'current';
      return refuse(res, 409, reason);
    }
    if (row.projectId === null || row.projectId === undefined) return refuse(res, 409, 'no-project');
    const original = originalFor(row);
    if (mode === 'restore' && !original) return refuse(res, 409, 'no-original');
    const title = mode === 'title' ? pdfTitleFor(row) : null;

    const stat = await storage.statObject(row.s3Key);
    if (!stat || !stat.etag) return refuse(res, 409, 'no-object');
    const skip = async (reason) => {
      // Recorded only while this file was never written, so a titled file keeps its state.
      if (!original) await save(row, { ...baseRecord(row), title, status: 'skipped', reason, at: nowIso() });
      logger.info('[pdf-title] skipped', { id: row.id, s3Key: row.s3Key, reason });
      return refuse(res, 409, reason);
    };
    if (stat.size === 0) return skip('empty');
    if (stat.size > MAX_BYTES) return skip('over-cap');
    if ((await sharedKeys([row.s3Key])).has(row.s3Key)) return skip('shared-key');

    // The archive holds the original: the live object on first titling, the recorded one after.
    const gate = original
      ? (original.etag ? await backupCheck.assertBackedUp(row.s3Key, { size: original.length, etag: original.etag })
        : { ok: false, reason: 'no-backup' })
      : await backupCheck.assertBackedUp(row.s3Key, { size: stat.size, etag: stat.etag });
    if (!gate.ok) {
      logger.warn('[pdf-title] lease refused by the backup gate', { id: row.id, s3Key: row.s3Key, reason: gate.reason });
      if (gate.reason === 'md5-mismatch') {
        await save(row, { ...baseRecord(row), status: 'needs-review', reason: gate.reason, at: nowIso() });
      }
      return refuse(res, 409, gate.reason);
    }

    // The wanted title rides on the lease: the record's own title names what the file holds.
    const leaseRecord = {
      leaseId: crypto.randomUUID(),
      mode,
      title,
      expiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
      sourceEtag: stat.etag,
      sourceSize: stat.size,
      contentType: stat.contentType || 'application/pdf'
    };
    try {
      row = await save(row, { ...baseRecord(row), lease: leaseRecord });
    } catch (err) {
      if (isPreconditionFailed(err)) return refuse(res, 412, 'lease-race');
      throw err;
    }
    return await backupAndAnswer(res, row, leaseRecord, original, title);
  } catch (err) {
    return serverError(res, err, '[pdf-title] lease failed');
  }
}

/** Step 3: frozen backup at the stat's etag, then the GET link. Any failure releases the lease. */
async function backupAndAnswer(res, row, leaseRecord, original, title) {
  const fields = { id: row.id, s3Key: row.s3Key, leaseId: leaseRecord.leaseId };
  const backupKey = storage.backupKeyFor(row.s3Key);
  const copy = () => storage.copyObject(row.s3Key, backupKey, { ifSourceEtag: leaseRecord.sourceEtag });
  let copied;
  try {
    try {
      copied = await copy();
    } catch (err) {
      if (err.code !== 'BACKUP_EXISTS') throw err;
      // Lease cleared, nothing in flight, not under review: a backup left by a run that died.
      logger.warn('[pdf-title] orphan backup found; replacing it', fields);
      await dropBackup(backupKey, null, fields);
      copied = await copy();
    }
  } catch (err) {
    const status = isPreconditionFailed(err) || err.code === 'PreconditionFailed' ? 'source-changed' : null;
    logger.error('[pdf-title] backup copy failed; lease released', { ...fields, error: err.message, reason: status });
    await release(row);
    return status ? refuse(res, 409, status) : refuse(res, 503, 'backup-failed');
  }

  const record = recordOf(row);
  const withBackup = { ...leaseRecord, backupKey, backupVersionId: copied.versionId || null };
  try {
    row = await save(row, { ...record, lease: withBackup });
    const backupUrl = await storage.getDownloadUrl(backupKey, { expirySeconds: BACKUP_GET_SECONDS });
    logger.info('[pdf-title] lease issued', { ...fields, mode: leaseRecord.mode, size: leaseRecord.sourceSize });
    return res.status(201).json({
      leaseId: leaseRecord.leaseId,
      mode: leaseRecord.mode,
      expiresAt: leaseRecord.expiresAt,
      title,
      backupUrl,
      backupUrlExpiresIn: BACKUP_GET_SECONDS,
      sourceSize: leaseRecord.sourceSize,
      contentType: leaseRecord.contentType,
      originalLength: original ? original.length : null,
      originalSha256: original ? original.sha256 : null
    });
  } catch (err) {
    logger.error('[pdf-title] lease could not be completed; released', { ...fields, error: err.message });
    await dropBackup(backupKey, copied.versionId, fields);
    try { await release(row); } catch (releaseErr) {
      logger.error('[pdf-title] lease release failed; the sweep will clear it', { ...fields, error: releaseErr.message });
    }
    return refuse(res, 503, 'lease-failed');
  }
}

/** The live lease named by `leaseId`, or a reason it is not one. */
function liveLease(row, leaseId) {
  const record = recordOf(row);
  if (!record || !record.lease || record.lease.leaseId !== leaseId) return { reason: 'no-lease' };
  if (!isLive(record.lease)) return { reason: 'lease-expired' };
  return { record, lease: record.lease };
}

function invalidCommit(body, lease, original) {
  const { newLength, newSha256, newMd5 } = body;
  if (!Number.isInteger(newLength) || newLength < 1) return 'newLength must be a positive integer';
  if (!SHA256.test(String(newSha256))) return 'newSha256 must be 64 lowercase hex characters';
  if (!MD5_B64.test(String(newMd5))) return 'newMd5 must be a base64 MD5';
  if (lease.mode === 'restore') {
    if (newLength !== original.length || newSha256 !== original.sha256) return 'a restore must write the recorded original';
    return null;
  }
  const base = original ? original.length : body.originalLength;
  if (!original) {
    if (!Number.isInteger(body.originalLength)) return 'originalLength is required on first titling';
    if (!SHA256.test(String(body.originalSha256))) return 'originalSha256 is required on first titling';
  }
  if (newLength <= base || newLength - base > MAX_GROWTH) return 'newLength must add one small increment to the original';
  return null;
}

/**
 * POST /documents/:id/pdf-title/commit — re-check the source, record the original once, mark the
 * write in flight, and sign a PUT for exactly `s3Key`.
 */
async function commit(req, res) {
  const body = req.body || {};
  try {
    let row = await readOne(req);
    if (!row) return refuse(res, 404, 'not-found');
    const { reason, record, lease: held } = liveLease(row, body.leaseId);
    if (reason) return refuse(res, 409, reason);
    if (record.inFlight) return refuse(res, 409, 'already-committed');
    let original = originalFor(row);
    const invalid = invalidCommit(body, held, original);
    if (invalid) return refuse(res, 400, invalid);
    const fields = { id: row.id, s3Key: row.s3Key, leaseId: held.leaseId };

    const stat = await storage.statObject(row.s3Key);
    if (!stat || stat.size !== held.sourceSize || bareEtag(stat.etag) !== bareEtag(held.sourceEtag)) {
      logger.warn('[pdf-title] source changed before commit; lease released', fields);
      await dropBackup(held.backupKey, held.backupVersionId, fields);
      await release(row);
      return refuse(res, 409, 'source-changed');
    }

    if (!original) {
      // The record is never the worker's word alone: the API hashes the backup itself.
      const hashed = await hashObject(held.backupKey);
      if (body.originalLength !== stat.size || hashed.length !== stat.size || hashed.sha256 !== body.originalSha256) {
        logger.warn('[pdf-title] original does not match the backup; lease released', fields);
        await dropBackup(held.backupKey, held.backupVersionId, fields);
        await release(row, { title: held.title, status: 'skipped', reason: 'original-mismatch' });
        return refuse(res, 409, 'original-mismatch');
      }
      row = await save(row, {
        ...record, originalLength: stat.size, originalSha256: hashed.sha256, originalEtag: bareEtag(stat.etag)
      });
      original = originalFor(row);
      logger.info('pdf-title.original', { id: row.id, s3Key: row.s3Key, length: original.length, sha256: original.sha256 });
    }

    const inFlight = {
      newLength: body.newLength, newSha256: body.newSha256, newMd5: body.newMd5,
      backupKey: held.backupKey, backupVersionId: held.backupVersionId || null
    };
    row = await save(row, { ...recordOf(row), inFlight });

    // If the PUT link cannot be made, nothing was signed: the sweep finds the source unchanged.
    const uploadUrl = await storage.getUploadUrl(row.s3Key, { expirySeconds: PUT_SECONDS, contentMd5: body.newMd5 });
    logger.info('[pdf-title] write signed', { ...fields, newLength: body.newLength });
    return res.json({
      uploadUrl,
      expiresIn: PUT_SECONDS,
      // Every one of these must be sent. If-Match makes the store refuse the PUT with 412 when the
      // object changed after the re-stat above; Content-MD5 is signed into the link.
      headers: {
        'Content-Type': held.contentType,
        'Content-MD5': body.newMd5,
        'If-Match': `"${bareEtag(held.sourceEtag)}"`
      }
    });
  } catch (err) {
    if (isPreconditionFailed(err)) return refuse(res, 412, 'lease-race');
    return serverError(res, err, '[pdf-title] commit failed');
  }
}

/**
 * PUT /documents/:id/pdf-title — the worker's report. `{leaseId}` after a PUT, or
 * `{leaseId, skipped: true, reason}` when it wrote nothing. The store decides the outcome either
 * way: a report of a skip after a commit is still checked against the object.
 */
async function report(req, res) {
  const body = req.body || {};
  try {
    const row = await readOne(req);
    if (!row) return refuse(res, 404, 'not-found');
    const { reason } = liveLease(row, body.leaseId);
    // An expired lease is still the worker's own: settling it now is what the sweep would do.
    if (reason === 'no-lease') return refuse(res, 409, reason);
    if (body.skipped && (typeof body.reason !== 'string' || !body.reason.trim())) {
      return refuse(res, 400, 'a skip needs a reason');
    }
    const skip = body.skipped ? { reason: body.reason.trim().slice(0, 200) } : null;
    const { row: stored, outcome } = await settle(row, skip);
    const record = recordOf(stored) || {};
    return res.json({ outcome, status: record.status || null, reason: record.reason || null });
  } catch (err) {
    if (isPreconditionFailed(err)) return refuse(res, 412, 'lease-race');
    return serverError(res, err, '[pdf-title] report failed');
  }
}

module.exports = { listPending, lease, commit, report, MAX_BYTES };
