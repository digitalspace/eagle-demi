'use strict';

/**
 * Bulk download: submit a job, poll it; a queue worker builds the zip. The job id is the
 * capability, and an authenticated job is bound to its requester. Wiki [[Bulk-Download]].
 */

const crypto = require('crypto');

const config = require('../../config');
const storage = require('../../storage');
const bulkDownloads = require('../../repositories/bulk-downloads');
const documents = require('../../repositories/documents');
const queue = require('../../jobs/bulk-download-queue');
const { packPartCount } = require('../../jobs/pack-parts');
const { resolveDownload } = require('./document');
const { resolveAccess } = require('../../helpers/access-sql');
const { partiesFor } = require('../../middleware/credentials');
const { serverError } = require('../../helpers/response');
const { logger } = require('../../utils/logger');
const { auditEvent, analyticsEvent } = require('../../utils/audit');
const { callerIp } = require('../../utils/caller-ip');

// Ids per manifest read. The read is cross-partition — a bulk request carries no project context —
// so the IN clause is what bounds it.
const MANIFEST_BATCH = 200;

// What the manifest needs and nothing else: the size to pack against, the key to prove the file
// exists, and the publication state the audit rule below reads.
const MANIFEST_SELECT = 'c.id, c.fileSize, c.isPublished, c.s3Key';
exports.MANIFEST_SELECT = MANIFEST_SELECT;

// Same short window as GET /documents/:id/download: a presigned URL carries no auth of its own.
const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

// The id shape every row in this container is reached by; the repository owns it.
const { JOB_ID } = bulkDownloads;

// Stricter than eagle-search: an unknown body key is a typo the caller wants to hear about, not a
// field to ignore.
const ALLOWED_BODY_KEYS = ['documentIds'];

// Audit detail is a log row, not the job: a 2,500-id list would be sent to ingestion on every
// request. The count beside it is what says whether the list was truncated.
const MAX_AUDITED_IDS = 500;

const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * Who is asking. `key` is the quota bucket and exists for anonymous callers too; `id` binds an
 * authenticated job to its owner and is EMPTY when there is nobody to bind it to.
 */
function requesterOf(req) {
  const user = (req && req.user) || null;
  if (!user) return { key: callerIp(req), id: '', type: 'anonymous' };
  const id = String(user.keyId || user.sub || user.preferred_username || '');
  return { key: id || callerIp(req), id, type: user.keyId ? 'api-key' : 'user' };
}

exports.createBulkDownload = async (req, res) => {
  // The slot this request took, given back exactly once — a refusal and the catch below both come
  // through here, and a double release would free a slot another of this requester's jobs holds.
  let heldKey = null;
  const releaseHeldSlot = async () => {
    if (!heldKey) return;
    const key = heldKey;
    heldKey = null;
    await bulkDownloads.releaseSlot(key);
  };

  try {
    const access = resolveAccess(req);
    const body = req.body || {};

    const unknown = Object.keys(body).filter(key => !ALLOWED_BODY_KEYS.includes(key));
    if (unknown.length > 0) {
      return res.status(400).json({ error: `Unknown body parameter(s): ${unknown.join(', ')}` });
    }

    const anonymous = !access.authenticated;
    const cap = anonymous ? config.bulkAnonMaxDocuments : config.bulkMaxDocuments;

    if (!Array.isArray(body.documentIds)) {
      return res.status(400).json({ error: 'documentIds must be an array of document ids.' });
    }
    // LENGTH before contents: a million-element body is refused on one property read rather than
    // on a million type checks and a million-entry Set.
    if (body.documentIds.length > cap) {
      return res.status(400).json({
        error: anonymous
          ? `More than ${cap} documents in one request requires an authenticated request.`
          : `More than ${cap} documents in one request is refused. Ask for fewer.`
      });
    }
    if (body.documentIds.some(id => typeof id !== 'string' || id.trim() === '')) {
      return res.status(400).json({ error: 'documentIds must contain non-empty strings only.' });
    }

    const ids = Array.from(new Set(body.documentIds.map(id => id.trim())));
    if (ids.length === 0) {
      return res.status(400).json({ error: 'documentIds must name at least one document.' });
    }

    // One file is a plain download, never a job. It reuses the /documents/:id/download helper for
    // presign, ACL check and audit; `single` only tags the answer.
    if (ids.length === 1) {
      const single = await resolveDownload(req, ids[0]);
      if (single.status !== 200) return res.status(single.status).json(single.body);

      // Counted once answered, as the job path counts an accepted job. resolveDownload already
      // recorded the document.download event and any audit row.
      analyticsEvent(req, { eventName: 'bulk.request', resultCount: 1 });
      return res.json({ ...single.body, single: true });
    }

    if (!config.bulkDownloadsQueue) {
      return res.status(503).json({ error: 'bulk download disabled' });
    }

    const requester = requesterOf(req);
    const acquired = await bulkDownloads.acquireSlot(requester.key, {
      maxInFlight: config.bulkMaxPending,
      maxPerDay: config.bulkMaxPerDay
    });
    if (!acquired) {
      return res.status(429).json({
        error: `At most ${config.bulkMaxPending} bulk downloads at once and ` +
          `${config.bulkMaxPerDay} a day. Wait for one to finish, or try again tomorrow.`
      });
    }

    // Every exit from here on has taken a slot. A refused request that kept one would lock its
    // requester out until the quota row expired.
    heldKey = requester.key;
    const refuse = async (status, payload) => {
      await releaseHeldSlot();
      return res.status(status).json(payload);
    };

    // `isPublished` rides along for the audit rule below — a doc the public cannot see makes this
    // an access to restricted material rather than a usage statistic.
    const visible = [];
    for (let i = 0; i < ids.length; i += MANIFEST_BATCH) {
      const rows = await documents.listByIdsUnscoped(
        access, ids.slice(i, i + MANIFEST_BATCH), MANIFEST_SELECT
      );
      visible.push(...rows);
    }

    // Back into the asked order: cross-partition rows arrive in any order and parts pack in
    // sequence. A row with no stored file cannot be zipped and is not counted.
    const found = new Map(visible.map(row => [String(row.id), row]));
    const docs = ids.map(id => found.get(id)).filter(doc => doc && doc.s3Key);
    if (docs.length === 0) {
      return refuse(404, { error: 'No documents available to download.' });
    }

    const estimatedBytes = docs.reduce((total, doc) => total + (Number(doc.fileSize) || 0), 0);
    if (estimatedBytes > config.bulkMaxTotalBytes) {
      return refuse(400, {
        error: `The selection is ${estimatedBytes} bytes, over the ${config.bulkMaxTotalBytes}-byte limit. Ask for fewer documents.`
      });
    }

    const restricted = docs.filter(doc => !doc.isPublished).map(doc => String(doc.id));
    const id = crypto.randomUUID();
    const job = {
      id,
      status: 'queued',
      documentIds: ids,
      // A plain-data snapshot of the caller's roles at submit, not a credential: the worker re-runs
      // the visibility read with it and refuses a job older than `bulkMaxJobAgeMs`.
      access: JSON.parse(JSON.stringify(access)),
      requesterKey: requester.key,
      requesterId: requester.id,
      requesterType: requester.type,
      // Every identity a credential can be granted to for this caller — subject, key id and realm
      // groups. The worker re-checks the snapshot's grants against all of them, as the request did.
      parties: partiesFor(req.user),
      documentCount: docs.length,
      estimatedBytes,
      estimatedPartCount: packPartCount(docs, config.bulkMaxBytes),
      parts: [],
      // Read at hand-out time: the download of a restricted document is auditable when it happens,
      // and by then the rows that said so have been re-read by the worker, not this request.
      restricted: restricted.length > 0,
      createdAt: new Date().toISOString(),
      errors: [],
      errorCount: 0,
      ttl: config.bulkJobTtlDays * SECONDS_PER_DAY
    };

    // Row FIRST, then the message: a worker that dequeues an id with no row can only log and give
    // up, whereas a message that never arrives leaves a queued row somebody can requeue.
    const saved = await bulkDownloads.create(job);
    try {
      await queue.enqueue(id);
    } catch (err) {
      logger.error(`[bulk] could not enqueue ${id}: ${err.message}`, {
        error: err.message, stack: err.stack
      });
      // Else the row sits `queued` for its TTL. `slotReleasedAt` tells a later cancel that the
      // refusal below already gave the slot back.
      const at = new Date().toISOString();
      await bulkDownloads.patch(id, {
        status: 'failed', error: 'enqueue failed', finishedAt: at, slotReleasedAt: at
      }).catch(() => {});
      return refuse(503, { error: 'bulk download could not be queued' });
    }

    analyticsEvent(req, { eventName: 'bulk.request', resultCount: docs.length });
    if (restricted.length > 0) {
      auditEvent(req, {
        action: 'bulk.request',
        targetType: 'bulkDownload',
        targetId: id,
        detail: {
          documentCount: docs.length,
          requested: ids.length,
          estimatedBytes,
          restrictedCount: restricted.length,
          restrictedIds: restricted.slice(0, MAX_AUDITED_IDS)
        }
      });
    }

    // The one line carrying the full id: the access log masks it (bearer capability), so this is
    // what a queue wait is measured from, against the worker's `Executing` line for the same job.
    logger.info(`[bulk] job queued job=${id} documents=${job.documentCount}`);

    return res.status(202).json({
      id,
      status: (saved && saved.status) || job.status,
      documentCount: job.documentCount,
      estimatedPartCount: job.estimatedPartCount,
      statusUrl: `/api/bulk-downloads/${id}`
    });
  } catch (err) {
    // Whatever failed, the slot must not outlive the request: holding it locks this requester out
    // of bulk download until the quota row expires, which is two days.
    await releaseHeldSlot().catch(
      slotErr => logger.warn(`[bulk] could not release slot: ${slotErr.message}`)
    );
    return serverError(res, err, 'bulk download controller failed');
  }
};

const NOT_FOUND = { error: 'Bulk download not found' };

/**
 * The job this caller may act on, or null, so a bad id, a missing job and someone else's job all
 * answer 404. An anonymous job has no owner: holding the id is the whole claim.
 */
async function ownJob(req) {
  const id = String(req.params.id || '');
  if (!JOB_ID.test(id)) return null;

  const job = await bulkDownloads.getById(id);
  if (!job) return null;

  return job.requesterId && job.requesterId !== requesterOf(req).id ? null : job;
}

exports.getBulkDownload = async (req, res) => {
  try {
    const job = await ownJob(req);
    if (!job) {
      return res.status(404).json(NOT_FOUND);
    }

    const parts = Array.isArray(job.parts) ? job.parts : [];
    const stale = job.status === 'running' && job.startedAt &&
      Date.now() - Date.parse(job.startedAt) > config.bulkStaleRunningMs;
    const status = stale ? 'failed' : job.status;

    const body = {
      id: job.id,
      status,
      documentCount: job.documentCount || 0,
      partCount: job.partCount || 0,
      partsReady: parts.length,
      includedCount: job.includedCount || 0,
      errorCount: job.errorCount || 0,
      errors: (Array.isArray(job.errors) ? job.errors : []).slice(0, 100),
      bytes: job.bytes || 0
    };

    if (status === 'ready') {
      // The worker's name for the job's content; a job may carry none.
      const label = String(job.label || '').trim();
      const base = label ? `EPIC documents - ${label}` : 'EPIC documents';
      const partCount = job.partCount || parts.length;

      body.parts = await Promise.all(parts.map(async (part, index) => {
        const n = part.n || index + 1;
        // The filename is baked into the presign as a content-disposition: Safari ignores
        // `<a download>` on a cross-origin URL and would otherwise name the file after the key.
        const fileName = partCount > 1
          ? `${base} (part ${n} of ${partCount}).zip`
          : `${base}.zip`;
        return {
          n,
          url: await storage.getDownloadUrl(part.key, {
            expirySeconds: DOWNLOAD_URL_TTL_SECONDS,
            fileName
          }),
          bytes: part.bytes || 0,
          count: part.count || 0,
          expiresIn: DOWNLOAD_URL_TTL_SECONDS,
          fileName
        };
      }));

      // The hand-out is the download. As with /documents/:id/download, a job holding a restricted
      // document is audited and every job is a usage statistic.
      analyticsEvent(req, { eventName: 'bulk.download', resultCount: job.includedCount || 0 });
      if (job.restricted) {
        auditEvent(req, {
          action: 'bulk.download',
          targetType: 'bulkDownload',
          targetId: job.id,
          detail: { documentCount: job.documentCount || 0, partCount: parts.length }
        });
      }
    }

    return res.json(body);
  } catch (err) {
    return serverError(res, err, 'bulk download controller failed');
  }
};

/**
 * Cancel a job; idempotent. Both writes are conditional since the worker may be running it, and
 * `failed` stays cancellable because the queue redelivers it. Wiki [[Bulk-Download]] §Cancelling.
 */
exports.cancelBulkDownload = async (req, res) => {
  try {
    const job = await ownJob(req);
    if (!job) {
      return res.status(404).json(NOT_FOUND);
    }

    const cancelled = await bulkDownloads.patchIfStatus(
      job.id,
      { status: 'cancelled', finishedAt: new Date().toISOString() },
      ['queued', 'running', 'failed']
    );

    if (cancelled) {
      // Never off the row read above: the worker may have released between that read and this.
      if (job.requesterKey &&
        await bulkDownloads.claimSlotRelease(job.id, new Date().toISOString())) {
        await bulkDownloads.releaseSlot(job.requesterKey);
      }
      analyticsEvent(req, { eventName: 'bulk.cancel', resultCount: job.documentCount || 0 });
    }

    return res.status(204).send('');
  } catch (err) {
    return serverError(res, err, 'bulk download controller failed');
  }
};
