'use strict';

/**
 * PDF tab titles written into the stored original, by a worker that holds no storage credential.
 *
 * The worker asks for a lease on one document, reads a frozen backup through a GET link, writes
 * `original + one increment` through a PUT link for exactly the leased key, and reports back. This
 * module is the only caller of `storage.getUploadUrl` and `storage.copyObject`. Every step that
 * fails leaves the stored object whole: the untouched original or a verified new object, and a
 * verify that fails copies the backup back. The record is the DEMI-owned field `pdfTitle`.
 *
 * Lease state lives in `pdfTitle.lease`, and every record write is guarded by the row's `_etag`,
 * so two workers on one document lose with 412 rather than both writing. Every step acts on the
 * key the lease recorded, never on whatever `s3Key` the row holds by then.
 */

const crypto = require('crypto');
const config = require('../../config');
const documents = require('../../repositories/documents');
const cosmos = require('../../db/cosmos-nosql');
const storage = require('../../storage');
const backupCheck = require('../../helpers/backup-check');
const { isPdf, isEligible, isCurrent, needsRestore } = require('../../helpers/pdf-title');
const { checkTail, refuse: refuseRead } = require('../../helpers/pdf-tail');
const { readOriginal } = require('../../helpers/pdf-original');
const { pdfTitleFor } = require('../../helpers/file-name');
const { levelOfRead, isDemiSeal } = require('../../helpers/access-sql');
const { serverError } = require('../../helpers/response');
const { logger } = require('../../utils/logger');

const LEASE_MS = 10 * 60 * 1000;
// A Mongo ObjectId as `String(_id)` writes it: 24 lowercase hex characters.
const EAGLE_ID = /^[0-9a-f]{24}$/;
const BACKUP_GET_SECONDS = 300;
const PUT_SECONDS = 120;
/** Commit needs this much lease left beyond the PUT link, so the link dies before the lease does. */
const PUT_MARGIN_MS = 60 * 1000;
/** Clock skew allowed between this API and the store before a PUT link counts as dead. */
const PUT_SKEW_MS = 30 * 1000;
/** Owner decision 6: larger files are skipped. */
const MAX_BYTES = 256 * 1024 * 1024;
/**
 * The titler's increment: the Info dictionary (title at most ~4 bytes a character as UTF-16 hex,
 * plus the original's other Info strings), the original's XMP packet rewritten with the title,
 * and one xref section. 256 KiB leaves room for a large XMP packet; a file whose XMP is bigger is
 * refused at commit.
 */
const MAX_GROWTH = 256 * 1024;
const PAGE_DEFAULT = 100;
const PAGE_MAX = 500;
const SWEEP_DEFAULT = 5;
const SWEEP_MAX = 20;

const SHA256 = /^[0-9a-f]{64}$/;
const MD5_B64 = /^[A-Za-z0-9+/]{22}==$/;

const LIST_FIELDS = [
  'id', 'projectId', 's3Key', 'displayName', 'documentFileName', 'vis', 'read', 'sealedAt',
  'mimeType', 'fileExt', 'fileSize', 'eaglePushedAt', 'pdfTitle'
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

/** What the store must hold now for a file with a recorded original: the titled file, or the original. */
function expectedNow(row) {
  const record = recordOf(row);
  const original = originalFor(row);
  if (!original) return null;
  return record.status === 'titled'
    ? { length: record.titledLength, sha256: record.titledSha256 }
    : { length: original.length, sha256: original.sha256 };
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

/** Sealed by DEMI or by Eagle (level 0): its bytes are never handed to the worker unasked. */
function isSealed(row) {
  return isDemiSeal(row) || levelOfRead(row.read) === 0;
}

/**
 * Seed and Eagle push write `id` as the Mongo ObjectId, while every caller-reachable create uses
 * `crypto.randomUUID()` and no update can change `id`, so a 24-hex id means Eagle set the key.
 */
function isFromEagle(row) {
  return EAGLE_ID.test(String(row.id));
}

/** Why a row may not be titled, or null when it may. Size and shared key need the store and a query. */
function ineligibleReason(row) {
  if (isSealed(row)) return 'sealed';
  if (!isPdf(row)) return 'not-pdf';
  if (!row.s3Key) return 'no-file';
  if (levelOfRead(row.read) !== 4) return 'not-public';
  if (pdfTitleFor(row) === null) return 'no-public-name';
  return isEligible(row) ? null : 'not-eligible';
}

/** `title` when the row wants a title written, `restore` when its title must come out, else null. */
function modeFor(row) {
  if (isSealed(row)) return null;
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

/**
 * One read of an object: whole sha256, the sha256 of its first `prefixLength` bytes, its first
 * bytes, and the bytes after the prefix (up to `tailMax`).
 */
async function hashObject(key, { prefixLength, tailMax = 0 } = {}) {
  const whole = crypto.createHash('sha256');
  const prefix = crypto.createHash('sha256');
  const tail = [];
  let tailLength = 0;
  let head = Buffer.alloc(0);
  let length = 0;
  const stream = await storage.getObjectStream(key);
  for await (const chunk of stream) {
    whole.update(chunk);
    if (head.length < 8) head = Buffer.concat([head, chunk.subarray(0, 8 - head.length)]);
    if (Number.isInteger(prefixLength)) {
      const inPrefix = Math.max(0, Math.min(chunk.length, prefixLength - length));
      if (inPrefix) prefix.update(chunk.subarray(0, inPrefix));
      if (inPrefix < chunk.length && tailLength <= tailMax) {
        tail.push(chunk.subarray(inPrefix));
        tailLength += chunk.length - inPrefix;
      }
    }
    length += chunk.length;
  }
  return {
    length,
    sha256: whole.digest('hex'),
    prefixSha256: Number.isInteger(prefixLength) && length >= prefixLength ? prefix.digest('hex') : null,
    head,
    tail: tailLength <= tailMax ? Buffer.concat(tail) : null
  };
}

/**
 * The first `length` bytes of one backup version, read in ranges, for `readOriginal`. No read
 * reaches past `length` or leaves the version, whatever the reader asks for.
 */
function backupRange(backupKey, versionId, length) {
  return async (offset, want) => {
    if (!Number.isInteger(offset) || !Number.isInteger(want) || offset < 0 || want < 1 || offset + want > length) {
      refuseRead('original-offset');
    }
    const parts = [];
    for (let at = offset; at < offset + want;) {
      const ask = Math.min(storage.MAX_RANGE_BYTES, offset + want - at);
      const part = await storage.readRange(backupKey, at, ask, { versionId });
      parts.push(part);
      // A short part means the version ended early; the reader refuses the short result.
      if (part.length < ask) break;
      at += ask;
    }
    return Buffer.concat(parts);
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
    logger.error('[pdf-title] backup delete failed; left for the next lease', {
      ...fields, backupKey, error: err.message
    });
  }
}

/** Clear the lease and in-flight state, setting `extra` on the record. Returns the stored row. */
async function release(row, extra = {}) {
  return save(row, { ...baseRecord(row), ...extra, at: nowIso() });
}

/**
 * What a skip records. A file that holds no title is marked skipped for this title, so it is not
 * offered again. A titled file stays `titled`, or a later withheld name would never be restored,
 * and records the title it was skipped for. A restore that cannot run needs a person.
 */
function skipFields(row, lease, report) {
  if (!report) return {};
  if (lease.mode === 'restore') return { status: 'needs-review', reason: report.reason };
  if (recordOf(row).status === 'titled') return { reason: `retitle skipped: ${report.reason}`, skippedTitle: lease.title };
  return { status: 'skipped', reason: report.reason, title: lease.title };
}

function readOne(req) {
  return documents.readForWrite(req.params.id, req.query && req.query.project);
}

function refuse(res, status, reason, extra = {}) {
  return res.status(status).json({ error: reason, reason, ...extra });
}

/** Version and ETag semantics this flow relies on exist on the NRS (S3) store only. */
function unsupportedBackend(res) {
  if (config.storageBackend === 'minio') return null;
  return refuse(res, 503, 'backend-unsupported');
}

function principalOf(req) {
  const user = req.user || {};
  return typeof user.keyId === 'string' ? user.keyId : null;
}

/** The row with `s3Key` set to the key the lease was taken on, for every record computation. */
function onLeasedKey(row) {
  const lease = recordOf(row).lease;
  return lease && lease.key && lease.key !== row.s3Key ? { ...row, s3Key: lease.key } : row;
}

// ---------------------------------------------------------------------------------------------
// Settle: the one place that decides what a lease ends as, for a worker report and for the sweep.
// ---------------------------------------------------------------------------------------------

/** Copy the backup back over the leased key: did the key end up holding the backup's bytes, and what was overwritten? */
async function copyBack(row, fields) {
  const { lease, inFlight } = recordOf(row);
  let overwritten = null;
  try {
    const current = await storage.statObject(row.s3Key);
    overwritten = current ? { etag: current.etag, versionId: current.versionId || null, size: current.size } : null;
    const backup = await storage.statObject(inFlight.backupKey);
    if (!backup) throw new Error('backup is missing');
    await storage.copyObject(inFlight.backupKey, row.s3Key, { ifSourceEtag: backup.etag });
    const [put, ref] = await Promise.all([hashObject(row.s3Key), hashObject(inFlight.backupKey)]);
    return { restored: put.length === lease.sourceSize && put.sha256 === ref.sha256, overwritten };
  } catch (err) {
    logger.error('[pdf-title] restore from backup failed', { ...fields, error: err.message });
    return { restored: false, overwritten };
  }
}

/** Park the row for a person, keeping the backup, the in-flight record and what was overwritten. */
async function park(row, reason, restored, overwritten, fields) {
  const { inFlight } = recordOf(row);
  logger.error('[pdf-title] write refused; needs review', { ...fields, reason, restored });
  const stored = await save(row, {
    ...baseRecord(row),
    inFlight,
    overwritten,
    status: 'needs-review',
    reason: restored ? reason : `${reason}; restore-unverified`,
    at: nowIso()
  });
  return { row: stored, outcome: 'needs-review' };
}

/**
 * What the store holds for the in-flight write: `good` (the new object, fully checked), `source`
 * (the pre-lease bytes), or `bad` with a reason. `shape` marks an increment that is not the
 * titler's, which a verified undo turns into a skip rather than a review.
 */
async function inspect(row) {
  const { lease, inFlight } = recordOf(row);
  const stat = await storage.statObject(row.s3Key);
  if (stat && stat.size === inFlight.newLength && bareEtag(stat.etag) === md5Hex(inFlight.newMd5)) {
    if ((stat.contentType || null) !== (lease.contentType || null)) return { kind: 'bad', reason: 'content-type-changed' };
    const original = originalFor(row);
    const check = await hashObject(row.s3Key, { prefixLength: original.length, tailMax: MAX_GROWTH });
    if (check.sha256 !== inFlight.newSha256 || check.prefixSha256 !== original.sha256) {
      return { kind: 'bad', reason: 'hash-mismatch' };
    }
    if (lease.mode === 'title') {
      const refused = check.tail ? checkTail(check.tail, original.length, inFlight.facts, lease.title) : 'tail-too-large';
      if (refused) return { kind: 'bad', reason: refused, shape: true };
    }
    return { kind: 'good' };
  }
  if (stat) {
    const same = (other) => Boolean(other) && stat.size === other.size && bareEtag(stat.etag) === bareEtag(other.etag);
    // The backup's own ETag counts too: a copy back may not reproduce a multipart source ETag.
    if (same({ size: lease.sourceSize, etag: lease.sourceEtag }) || same(await storage.statObject(inFlight.backupKey))) {
      return { kind: 'source' };
    }
  }
  return { kind: 'bad', reason: stat ? 'unexpected-object' : 'object-missing' };
}

/** Record a verified write, end the lease and delete the backup. */
async function finish(row, fields) {
  const { lease, inFlight } = recordOf(row);
  const isRestore = lease.mode === 'restore';
  const done = await release(row, {
    status: isRestore ? 'restored' : 'titled',
    reason: null,
    title: isRestore ? null : lease.title,
    skippedTitle: null,
    titledLength: isRestore ? null : inFlight.newLength,
    titledSha256: isRestore ? null : inFlight.newSha256
  });
  await dropBackup(inFlight.backupKey, inFlight.backupVersionId, fields);
  logger.info(`[pdf-title] ${isRestore ? 'restored' : 'titled'}`, { ...fields, length: inFlight.newLength });
  return { row: done, outcome: isRestore ? 'restored' : 'titled' };
}

/**
 * End a lease from the store's state; the one path for a worker report and for the sweep.
 * `report` is the worker's skip, if it sent one.
 *
 * - No in-flight write: nothing was ever signed, so drop the backup and clear.
 * - PUT link maybe still live: undo a bad object at once, then wait (`outcome: 'waiting'`).
 * - After the link is dead: a good object is recorded `titled` or `restored`; the source (or the
 *   undone bad write) releases the lease; anything else is undone and parked for review.
 */
async function settle(stored, report = null) {
  const row = onLeasedKey(stored);
  const record = recordOf(row);
  const lease = record.lease;
  const fields = { id: row.id, s3Key: row.s3Key, leaseId: lease.leaseId };

  if (!record.inFlight) {
    if (lease.backupKey) await dropBackup(lease.backupKey, lease.backupVersionId, fields);
    logger.info('[pdf-title] lease ended with no write', { ...fields, reason: report ? report.reason : 'released' });
    return { row: await release(row, skipFields(row, lease, report)), outcome: report ? 'skipped' : 'released' };
  }

  let verdict;
  try {
    verdict = await inspect(row);
  } catch (err) {
    // A check that cannot finish never leaves an unchecked object live: undo it like a bad shape,
    // but record no skip (`retry`), since nothing is known against the file.
    logger.error('[pdf-title] check of the stored object failed', { ...fields, error: err.message });
    verdict = { kind: 'bad', reason: 'check-failed', shape: true, retry: true };
  }

  // INVARIANT: while the PUT link can still land (now < putExpiresAt + skew), never release the
  // lease, never delete the backup and never record a final status, whatever the store holds now:
  // the same link can PUT again and undo any of them. A failed check is undone at once and noted
  // on inFlight; the decision is made from a fresh look once the link is dead.
  if (Date.now() < Date.parse(record.inFlight.putExpiresAt) + PUT_SKEW_MS) {
    if (verdict.kind !== 'bad') return { row: stored, outcome: 'waiting' };
    const { restored, overwritten } = await copyBack(row, fields);
    const refusal = { reason: verdict.reason, shape: Boolean(verdict.shape), retry: Boolean(verdict.retry), restored, overwritten, at: nowIso() };
    logger.warn('[pdf-title] write refused inside the PUT window; undone, decision waits', { ...fields, reason: verdict.reason });
    return { row: await save(row, { ...record, inFlight: { ...record.inFlight, refusal } }), outcome: 'waiting' };
  }

  const refusal = record.inFlight.refusal;
  if (verdict.kind === 'good') return finish(row, fields);
  if (verdict.kind === 'source') {
    if (refusal && !refusal.shape) return park(row, refusal.reason, true, refusal.overwritten, fields);
    await dropBackup(record.inFlight.backupKey, record.inFlight.backupVersionId, fields);
    const why = refusal && !refusal.retry ? { reason: refusal.reason } : report;
    logger.info('[pdf-title] lease ended; store holds the source', { ...fields, reason: why ? why.reason : 'released' });
    return { row: await release(row, skipFields(row, lease, why)), outcome: why ? 'skipped' : 'released' };
  }
  const { restored, overwritten } = await copyBack(row, fields);
  if (restored && verdict.shape) {
    await dropBackup(record.inFlight.backupKey, record.inFlight.backupVersionId, fields);
    logger.warn('[pdf-title] write refused and undone', { ...fields, reason: verdict.reason });
    if (verdict.retry) return { row: await release(row), outcome: 'released' };
    return { row: await release(row, skipFields(row, lease, { reason: verdict.reason })), outcome: 'skipped' };
  }
  return park(row, verdict.reason, restored, overwritten, fields);
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

function pageLimit(value, fallback, max) {
  return Math.min(Math.max(parseInt(value, 10) || fallback, 1), max);
}

/** A caller's continuation the SDK cannot parse is the caller's error, not a 500. */
async function queryPage(req, res, spec, limit) {
  const continuation = (req.query && req.query.continuation) || undefined;
  try {
    return await cosmos.query(documents.CONTAINER, spec, { maxItemCount: limit, continuationToken: continuation });
  } catch (err) {
    if (continuation && (err.code === 400 || err.statusCode === 400 || /continuation/i.test(err.message))) {
      refuse(res, 400, 'bad-continuation');
      return null;
    }
    throw err;
  }
}

/**
 * GET /documents/pdf-title/pending — one page of work. Reads only.
 *
 * Rows come back as `{id, projectId, mode, title}`. A cross-partition page may be short or empty
 * while more rows exist: follow `continuation` until it is null.
 */
async function listPending(req, res) {
  if (unsupportedBackend(res)) return undefined;
  try {
    const limit = pageLimit(req.query && req.query.limit, PAGE_DEFAULT, PAGE_MAX);
    const page = await queryPage(req, res, {
      query: `SELECT ${LIST_FIELDS.map(f => `c.${f}`).join(', ')} FROM c ` +
        "WHERE IS_DEFINED(c.s3Key) AND (ARRAY_CONTAINS(c.read, 'public') OR c.pdfTitle.status = 'titled')",
      parameters: []
    }, limit);
    if (!page) return undefined;

    const candidates = page.items
      .map(row => ({ row, mode: modeFor(row) }))
      .filter(({ row, mode }) => {
        const record = recordOf(row);
        if (!mode || !isFromEagle(row)) return false;
        if (record && (record.lease || record.inFlight || record.status === 'needs-review')) return false;
        return mode === 'restore' || !(Number(row.fileSize) > MAX_BYTES);
      });
    const shared = await sharedKeys(candidates.map(({ row }) => row.s3Key));
    const items = candidates
      .filter(({ row }) => !shared.has(row.s3Key))
      .map(({ row, mode }) => ({
        id: row.id, projectId: row.projectId, mode, title: mode === 'title' ? pdfTitleFor(row) : null
      }));

    logger.info('[pdf-title] work list', { scanned: page.items.length, pending: items.length });
    return res.json({ items, continuation: page.continuationToken || null });
  } catch (err) {
    return serverError(res, err, '[pdf-title] work list failed');
  }
}

/**
 * POST /documents/pdf-title/sweep — settle one page of expired leases. A row still under a live
 * PUT link is left (`waiting`); a row that fails is named in `failed`. Follow `continuation`, with
 * the `before` cutoff the first page returned, so every page reads the same query and rows that
 * keep failing never hold the others back.
 */
async function sweep(req, res) {
  if (unsupportedBackend(res)) return undefined;
  try {
    const limit = pageLimit(req.query && req.query.limit, SWEEP_DEFAULT, SWEEP_MAX);
    const given = req.query && req.query.before;
    if (given !== undefined && (Number.isNaN(Date.parse(given)) || new Date(given).toISOString() !== given)) {
      return refuse(res, 400, 'before must be the ISO time a sweep page returned');
    }
    if (given === undefined && req.query && req.query.continuation) return refuse(res, 400, 'a continuation needs its before');
    const before = given === undefined ? nowIso() : given;
    const page = await queryPage(req, res, {
      query: 'SELECT * FROM c WHERE IS_DEFINED(c.pdfTitle.lease.expiresAt) AND c.pdfTitle.lease.expiresAt < @now',
      parameters: [{ name: '@now', value: before }]
    }, limit);
    if (!page) return undefined;
    const counts = { released: 0, skipped: 0, titled: 0, restored: 0, 'needs-review': 0, waiting: 0 };
    const failed = [];
    for (const row of page.items) {
      try {
        const { outcome } = await settle(row);
        counts[outcome] = (counts[outcome] || 0) + 1;
      } catch (err) {
        failed.push(row.id);
        logger.error('[pdf-title] sweep of an expired lease failed', { id: row.id, error: err.message });
      }
    }
    logger.info('[pdf-title] sweep', { scanned: page.items.length, ...counts, failed: failed.length });
    return res.json({ scanned: page.items.length, outcomes: counts, failed, before, continuation: page.continuationToken || null });
  } catch (err) {
    return serverError(res, err, '[pdf-title] sweep failed');
  }
}

/** The mode a lease runs in, or a refusal reason. `requested` is the operator's `mode=restore`. */
function leaseMode(row, requested) {
  const original = originalFor(row);
  if (requested === 'restore') {
    if (isSealed(row)) return { reason: 'sealed' };
    if (!original) return { reason: 'no-original' };
    if (recordOf(row).status !== 'titled') return { reason: 'not-titled' };
    return { mode: 'restore' };
  }
  const mode = modeFor(row);
  if (!mode) return { reason: ineligibleReason(row) || 'current' };
  if (mode === 'restore' && !original) return { reason: 'no-original' };
  return { mode };
}

/**
 * POST /documents/:id/pdf-title/lease[?mode=restore] — checks, archive gate, lease, frozen backup,
 * GET link. 409 with a reason when the row may not be leased, 412 when another worker won the race.
 */
async function lease(req, res) {
  if (unsupportedBackend(res)) return undefined;
  try {
    const requested = (req.query && req.query.mode) || (req.body && req.body.mode) || undefined;
    if (requested !== undefined && requested !== 'restore') return refuse(res, 400, 'mode must be restore');
    let row = await readOne(req);
    if (!row) return refuse(res, 404, 'not-found');
    const record = recordOf(row);
    if (record && record.lease) return refuse(res, 409, isLive(record.lease) ? 'lease-held' : 'sweep-pending');
    if (record && record.status === 'needs-review') return refuse(res, 409, 'needs-review');
    if (record && record.inFlight) return refuse(res, 409, 'sweep-pending');
    if (!isFromEagle(row)) return refuse(res, 409, 'not-from-eagle');

    const { mode, reason } = leaseMode(row, requested);
    if (!mode) return refuse(res, 409, reason);
    if (row.projectId === null || row.projectId === undefined) return refuse(res, 409, 'no-project');
    const original = originalFor(row);
    const title = mode === 'title' ? pdfTitleFor(row) : null;

    const stat = await storage.statObject(row.s3Key);
    if (!stat || !stat.etag) return refuse(res, 409, 'no-object');
    const expected = expectedNow(row);
    if (expected && stat.size !== expected.length) {
      await save(row, { ...baseRecord(row), status: 'needs-review', reason: 'record-mismatch', at: nowIso() });
      logger.warn('[pdf-title] stored size differs from the record', { id: row.id, size: stat.size, expected: expected.length });
      return refuse(res, 409, 'record-mismatch');
    }
    const skip = async (why) => {
      // Recorded only while this file was never written, so a titled file keeps its state.
      if (!original) await save(row, { ...baseRecord(row), title, status: 'skipped', reason: why, at: nowIso() });
      logger.info('[pdf-title] skipped', { id: row.id, reason: why });
      return refuse(res, 409, why);
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
      logger.warn('[pdf-title] lease refused by the backup gate', { id: row.id, reason: gate.reason });
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
      key: row.s3Key,
      principal: principalOf(req),
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
      // A backup left by a run that died. Deleting it loses nothing only if it holds the live bytes.
      const orphan = await storage.statObject(backupKey);
      if (orphan && (orphan.size !== leaseRecord.sourceSize || bareEtag(orphan.etag) !== bareEtag(leaseRecord.sourceEtag))) {
        logger.error('[pdf-title] orphan backup differs from the live object; needs review', fields);
        await release(row, { status: 'needs-review', reason: 'orphan-backup-differs' });
        return refuse(res, 409, 'orphan-backup-differs');
      }
      logger.warn('[pdf-title] orphan backup equals the live object; replacing it', fields);
      await dropBackup(backupKey, orphan ? orphan.versionId : null, fields);
      copied = await copy();
    }
  } catch (err) {
    const changed = isPreconditionFailed(err) || err.code === 'PreconditionFailed';
    logger.error('[pdf-title] backup copy failed; lease released', { ...fields, error: err.message, changed });
    await release(row);
    return changed ? refuse(res, 409, 'source-changed') : refuse(res, 503, 'backup-failed');
  }

  const record = recordOf(row);
  const withBackup = { ...leaseRecord, backupKey, backupVersionId: copied.versionId || null };
  if (leaseRecord.mode === 'title' && !copied.versionId) {
    // The original is read by version at commit; refusing here costs no hash of the file.
    logger.warn('[pdf-title] backup has no version; lease released', fields);
    await dropBackup(backupKey, null, fields);
    await release(row);
    return refuse(res, 409, 'backup-unversioned');
  }
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
      originalSha256: original ? original.sha256 : null,
      maxGrowth: MAX_GROWTH
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

/** The live lease named by `leaseId` and held by this caller, or a reason it is not one. */
function heldLease(req, row, leaseId) {
  const record = recordOf(row);
  if (!record || !record.lease || record.lease.leaseId !== leaseId) return { reason: 'no-lease' };
  if (!record.lease.principal || record.lease.principal !== principalOf(req)) return { reason: 'no-lease' };
  if (!isLive(record.lease)) return { reason: 'lease-expired', record, lease: record.lease };
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
  if (newLength <= base || newLength - base > MAX_GROWTH) return `newLength must add 1 to ${MAX_GROWTH} bytes to the original`;
  return null;
}

/**
 * POST /documents/:id/pdf-title/commit — re-check the source, hash the backup, record the original
 * once, mark the write in flight, and sign a PUT for exactly the leased key.
 */
async function commit(req, res) {
  if (unsupportedBackend(res)) return undefined;
  const body = req.body || {};
  try {
    const stored = await readOne(req);
    if (!stored) return refuse(res, 404, 'not-found');
    const { reason, record, lease: held } = heldLease(req, stored, body.leaseId);
    if (reason) return refuse(res, 409, reason);
    if (record.inFlight) return refuse(res, 409, 'already-committed');
    let row = onLeasedKey(stored);
    const fields = { id: row.id, s3Key: row.s3Key, leaseId: held.leaseId };
    const giveUp = async (why, extra = {}) => {
      await dropBackup(held.backupKey, held.backupVersionId, fields);
      await release(row, extra);
      logger.warn('[pdf-title] commit refused; lease released', { ...fields, reason: why });
      return refuse(res, 409, why);
    };
    if (stored.s3Key !== held.key) return giveUp('key-changed');
    if (Date.parse(held.expiresAt) - Date.now() < PUT_SECONDS * 1000 + PUT_MARGIN_MS) {
      return refuse(res, 409, 'lease-too-short');
    }
    let original = originalFor(row);
    const invalid = invalidCommit(body, held, original);
    if (invalid) return refuse(res, 400, invalid);

    const stat = await storage.statObject(row.s3Key);
    if (!stat || stat.size !== held.sourceSize || bareEtag(stat.etag) !== bareEtag(held.sourceEtag)) {
      return giveUp('source-changed');
    }

    if (held.mode === 'title' && !held.backupVersionId) return giveUp('backup-unversioned');
    // The API's own read of the backup decides; the worker's numbers are only compared with it.
    const hashed = await hashObject(held.backupKey);
    // The stream reads the current version; it is the leased one only if nothing replaced it.
    const backupNow = await storage.statObject(held.backupKey);
    if (!backupNow || (backupNow.versionId || null) !== (held.backupVersionId || null)) return giveUp('backup-changed');
    const skipped = (why) => skipFields(row, held, { reason: why });
    if (hashed.head.toString('latin1', 0, 5) !== '%PDF-') return giveUp('not-pdf-bytes', skipped('not-pdf-bytes'));
    if (hashed.length !== stat.size) return giveUp('source-changed');

    if (!original) {
      if (body.originalLength !== stat.size || hashed.sha256 !== body.originalSha256) {
        return giveUp('original-mismatch', skipped('original-mismatch'));
      }
    } else if (hashed.sha256 !== expectedNow(row).sha256) {
      return giveUp('record-mismatch', { status: 'needs-review', reason: 'record-mismatch' });
    }

    // The increment check needs the original's structure, read from the backup version the lease copied.
    let facts = null;
    if (held.mode === 'title') {
      const length = original ? original.length : stat.size;
      facts = await readOriginal(backupRange(held.backupKey, held.backupVersionId, length), length);
      if (facts.error) return giveUp(facts.error, skipped(facts.error));
    }

    if (!original) {
      row = await save(row, {
        ...record, originalLength: stat.size, originalSha256: hashed.sha256, originalEtag: bareEtag(stat.etag)
      });
      original = originalFor(row);
      logger.info('pdf-title.original', { id: row.id, s3Key: row.s3Key, length: original.length, sha256: original.sha256 });
    }

    // Signed first, so putExpiresAt (taken after signing) is never earlier than the link's own
    // expiry. A link whose inFlight save then fails is never handed out. PUT_SKEW_MS covers the
    // store's clock running behind this one; that skew was not measured on ECS.
    const uploadUrl = await storage.getUploadUrl(row.s3Key, { expirySeconds: PUT_SECONDS, contentMd5: body.newMd5 });
    const putExpiresAt = new Date(Date.now() + PUT_SECONDS * 1000).toISOString();
    const inFlight = {
      newLength: body.newLength, newSha256: body.newSha256, newMd5: body.newMd5,
      backupKey: held.backupKey, backupVersionId: held.backupVersionId || null, putExpiresAt, facts
    };
    row = await save(row, { ...recordOf(row), inFlight });
    logger.info('[pdf-title] write signed', { ...fields, newLength: body.newLength });
    return res.json({
      uploadUrl,
      expiresIn: PUT_SECONDS,
      putExpiresAt,
      // Send all three. If-Match is not signed: the store honours it unsigned, and the report
      // checks the result whatever the worker sent. Content-MD5 is signed into the link.
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

/** A worker's skip reason as stored: short, printable, one line. */
function cleanReason(reason) {
  return String(reason).replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * PUT /documents/:id/pdf-title — the worker's report. `{leaseId}` releases the lease, after a PUT
 * or after a failure that wrote nothing; `{leaseId, skipped: true, reason}` records a skip. The
 * store decides the outcome either way. 409 `put-window-open` while the PUT link may still land.
 */
async function report(req, res) {
  if (unsupportedBackend(res)) return undefined;
  const body = req.body || {};
  try {
    const row = await readOne(req);
    if (!row) return refuse(res, 404, 'not-found');
    // An expired lease is still the worker's own: settling it now is what the sweep would do.
    const { reason } = heldLease(req, row, body.leaseId);
    if (reason === 'no-lease') return refuse(res, 409, reason);
    const why = body.skipped ? cleanReason(body.reason || '') : null;
    if (body.skipped && !why) return refuse(res, 400, 'a skip needs a reason');
    const { row: stored, outcome } = await settle(row, why ? { reason: why } : null);
    if (outcome === 'waiting') return refuse(res, 409, 'put-window-open', { putExpiresAt: recordOf(row).inFlight.putExpiresAt });
    const record = recordOf(stored) || {};
    return res.json({ outcome, status: record.status || null, reason: record.reason || null });
  } catch (err) {
    if (isPreconditionFailed(err)) return refuse(res, 412, 'lease-race');
    return serverError(res, err, '[pdf-title] report failed');
  }
}

module.exports = { listPending, sweep, lease, commit, report, MAX_BYTES, MAX_GROWTH };
