'use strict';

/**
 * The bulk-download worker — turns a job row into zip parts in object storage.
 *
 * Queue-triggered (api/index.js), one job per invocation. Nothing here trusts the submitted
 * selection: the manifest read below composes the ACCESS SNAPSHOT stored on the job, so a document
 * unpublished between submit and run is dropped from the zip and listed in `errors.txt`. That read
 * IS the access check — never `systemAccess()`, and never a compartment.
 *
 * Failure policy has two levels. A document that cannot be read is recorded and skipped, because
 * one missing object must not cost the caller the other 2,499 files. A JOB that cannot be run
 * rethrows, so the queue retries it and finally poisons the message; the retry re-runs a `failed`
 * job on purpose, which is what makes a transient object-store outage self-healing.
 */

const path = require('path');
const { PassThrough } = require('stream');
const ZipStream = require('zip-stream');

const config = require('../config');
const storage = require('../storage');
const cosmos = require('../db/cosmos-nosql');
const bulkDownloads = require('../repositories/bulk-downloads');
const credentials = require('../repositories/credentials');
const projects = require('../repositories/projects');
const { liveCredentials } = require('../helpers/credentials');
const { redactForAccess } = require('../vis/redact');
const { logger } = require('../utils/logger');

// Ids per lookup. Both reads are cross-partition — a bulk job carries no project context — so the
// IN clause is what bounds them. Same batch size the controller sized the job with.
const ID_BATCH = 200;

// Everything the zip needs: the name, the object to stream, the size to pack by. `vis` is an input
// to the redactor, never an output — it is withheld from every caller.
const DOCUMENT_FIELDS = 'c.id, c.projectId, c.displayName, c.documentFileName, c.s3Key, ' +
  'c.fileExt, c.fileSize, c.mimeType, c.vis';

// The row keeps a readable sample; `errors.txt` in the zip keeps all of them.
const MAX_STORED_ERRORS = 100;

// Folder + name has to clear the 255-character path limit Windows Explorer still enforces when it
// extracts, with room for the drive and the extract directory the caller chose.
const MAX_NAME_LENGTH = 150;
const MAX_FOLDER_LENGTH = 100;

const SECONDS_PER_DAY = 24 * 60 * 60;

const UNKNOWN_PROJECT = 'unknown-project';

/**
 * The only reasons a caller is ever told. A driver message would leak the object store's shape and
 * differs per backend, so it goes to the log and this goes in the row and in `errors.txt`.
 */
const REASON = {
  missing: 'not available',
  noKey: 'no object key',
  unavailable: 'unavailable',
  truncated: 'truncated'
};

// Left-to-right overrides and isolates let a name render as something other than what extracts.
const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// A real extension, not "the text after the last dot". The letter is what rules out `.2`.
const EXTENSION = /^\.[A-Za-z0-9]{1,8}$/;
const isExtension = ext => EXTENSION.test(ext) && /[A-Za-z]/.test(ext);

/** Strip what a zip entry path must not carry: separators, control and bidi characters, dots. */
function clean(value) {
  return String(value == null ? '' : value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\]/g, '')
    .replace(BIDI, '')
    .replace(/^\.+/, '')
    .trim();
}

/** The recorded type wins: `Application Report v1.2` has no extension, whatever extname says. */
function extensionOf(name, fileExt) {
  const declared = `.${clean(fileExt).replace(/^\.+/, '')}`;
  if (isExtension(declared)) return declared;
  const found = path.extname(name);
  return isExtension(found) ? found : '';
}

/**
 * A file name for a document, from what THIS caller may see of it: the row goes through the field
 * redactor first, so a title withheld at the caller's level cannot arrive as a file name instead.
 * Redacted down to nothing leaves the id, which is public by definition.
 */
function fileNameFor(doc, access) {
  const shown = redactForAccess('documents', doc, access);
  const name = clean(shown.documentFileName || shown.displayName || '') || String(doc.id);
  const ext = extensionOf(name, shown.fileExt);
  const base = ext && name.toLowerCase().endsWith(ext.toLowerCase())
    ? name.slice(0, -ext.length)
    : name;
  return base.slice(0, Math.max(1, MAX_NAME_LENGTH - ext.length)) + ext;
}

/**
 * A name no other entry in this folder already holds — ` (2)`, ` (3)` before the extension.
 * Case-insensitive, because Windows and macOS refuse to extract two entries that differ only in
 * case into the same folder.
 */
function uniqueName(taken, folder, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = name;
  let n = 2;
  while (taken.has(`${folder}/${candidate}`.toLowerCase())) {
    candidate = `${base} (${n})${ext}`;
    n += 1;
  }
  taken.add(`${folder}/${candidate}`.toLowerCase());
  return candidate;
}

/**
 * A source stream that cannot kill the archive: an object failing mid-transfer ends the entry
 * where it stopped instead of erroring the archive, which would abandon every file after it. The
 * entry that results is TRUNCATED, so the caller is told and it is not counted as included.
 */
function shielded(source, onTruncate) {
  const out = new PassThrough();
  source.on('error', err => { onTruncate(err); out.end(); });
  source.pipe(out);
  return out;
}

/** Append one entry and wait for the archive to finish reading it. */
function addEntry(archive, source, name) {
  return new Promise((resolve, reject) => {
    archive.entry(source, { name }, err => (err ? reject(err) : resolve()));
  });
}

function errorsText(errors) {
  return errors.map(e => `${e.documentId}\t${e.name || ''}\t${e.reason}`).join('\n') + '\n';
}

/** The size the row recorded, or 0 — an unrecorded size is not a size, so it predicts nothing. */
function knownSize(doc) {
  const size = Number(doc && doc.fileSize);
  return Number.isFinite(size) && size > 0 ? size : 0;
}

/**
 * Build one part: start the upload, then stream documents into it until it is full.
 *
 * The upload is started BEFORE the first entry and awaited after `finish()`, which is what keeps
 * the zip out of memory — the backend multiparts whatever the archive emits.
 *
 * Where the part ENDS is decided here, against the bytes the archive has actually written, because
 * a recorded `fileSize` is missing on plenty of documents and a plan made from those sizes packs
 * the wrong files. Returns the index it stopped at, so the caller opens the next part there.
 *
 * ponytail: one object streams at a time, so a part takes as long as its files do in series. Swap
 * for a small append pool (3-4) if wall time is ever the complaint — memory is the reason it is
 * serial today, one multipart buffer per instance.
 */
async function buildPart({ jobId, n, docs, from, projectNames, access, errors, maxBytes, partMaxBytes }) {
  const key = `zips/${jobId}-part${n}.zip`;
  const archive = new ZipStream({ store: true });
  const uploaded = storage.putObjectStream(key, archive, 'application/zip');

  // One handler for the part's whole life. An archive error or a rejected upload is fatal to the
  // part — racing every await against this is what stops the loop hanging on a dead consumer,
  // and it is deliberately OUTSIDE the per-document catch below.
  let fatal = null;
  const died = new Promise((_resolve, reject) => {
    const die = err => { fatal = fatal || err; reject(err); };
    archive.on('error', die);
    uploaded.then(undefined, die);
  });
  died.catch(() => {}); // only ever consumed through the race below
  const orDie = promise => Promise.race([promise, died]);

  const taken = new Set();
  let included = 0;
  let i = from;

  for (; i < docs.length; i += 1) {
    const doc = docs[i];
    // Roll BEFORE appending, never after: a part already at the cap must not take one more file.
    // Both clauses matter — the first closes a part filled by documents nobody recorded a size for,
    // the second keeps a document whose size IS known from overshooting a part that still has room.
    const written = archive.getBytesWritten();
    if (i > from && (written >= partMaxBytes || written + knownSize(doc) > partMaxBytes)) break;

    const folder = clean(projectNames.get(String(doc.projectId))).slice(0, MAX_FOLDER_LENGTH) ||
      UNKNOWN_PROJECT;
    const name = uniqueName(taken, folder, fileNameFor(doc, access));
    let truncated = null;

    try {
      const source = await orDie(storage.getObjectStream(doc.s3Key));
      await orDie(addEntry(
        archive, shielded(source, err => { truncated = err; }), `${folder}/${name}`
      ));
    } catch (err) {
      if (fatal) throw fatal;
      logger.warn(`[bulk] object unreadable job=${jobId} document=${doc.id}`, { error: err.message });
      errors.push({ documentId: doc.id, name, reason: REASON.unavailable });
      continue;
    }

    if (truncated) {
      logger.warn(`[bulk] object truncated job=${jobId} document=${doc.id}`,
        { error: truncated.message });
      errors.push({ documentId: doc.id, name, reason: REASON.truncated });
    } else {
      included += 1;
    }

    // The whole job's budget, against real bytes — the estimate the caller was refused on could
    // not see the documents whose size was never recorded.
    if (archive.getBytesWritten() > maxBytes) throw new Error('over the size limit');
  }

  // errors.txt rides in the last part, which is the one that ran out of documents rather than room.
  if (i >= docs.length && errors.length > 0) {
    await orDie(addEntry(archive, Buffer.from(errorsText(errors), 'utf8'), 'errors.txt'));
  }

  archive.finish();
  await orDie(uploaded);

  return {
    part: { n, key, bytes: archive.getBytesWritten(), count: included },
    next: i
  };
}

/** The documents of this job that are still visible, in the order they were asked for. */
async function manifest(job, access, errors) {
  const ids = (job.documentIds || []).map(String);
  const found = new Map();

  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const rows = await bulkDownloads.listDocumentsByIds(
      access, ids.slice(i, i + ID_BATCH), DOCUMENT_FIELDS
    );
    for (const row of rows) found.set(String(row.id), row);
  }

  const docs = [];
  for (const id of ids) {
    const doc = found.get(id);
    if (!doc) {
      // Unpublished since submit, deleted, or never visible to this caller — one reason, because
      // telling them apart would report on documents this caller cannot see.
      errors.push({ documentId: id, name: '', reason: REASON.missing });
    } else if (!doc.s3Key) {
      errors.push({ documentId: id, name: fileNameFor(doc, access), reason: REASON.noKey });
    } else {
      docs.push(doc);
    }
  }
  return docs;
}

async function projectNamesFor(access, docs) {
  const ids = Array.from(new Set(docs.map(doc => String(doc.projectId))));
  const names = new Map();
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const rows = await projects.listByIds(access, ids.slice(i, i + ID_BATCH));
    for (const row of rows) names.set(String(row.id), row.name);
  }
  return names;
}

/**
 * The job's access snapshot, with its credentials re-checked against the registry.
 *
 * Roles are frozen at submit on purpose — that is the selection the caller asked for. A CREDENTIAL
 * is different: it is a row somebody can revoke, and a zip built an hour later must not carry
 * documents a revoked grant opened. Narrowing only, never widening.
 *
 * Every party the request carried is re-read, not just the requester: a grant can be held by a
 * realm group, and checking the subject alone would drop it and quietly omit files the caller may
 * see. `job.parties` is what `middleware/credentials.js` loaded from, stored at submit.
 */
async function freshAccess(job, now) {
  const access = job.access || {};
  const held = Array.isArray(access.credentials) ? access.credentials : [];
  const parties = Array.isArray(job.parties) ? job.parties : [];
  if (parties.length === 0 || held.length === 0) return access;

  const rows = (await Promise.all(parties.map(p => credentials.listForParty(p)))).flat();
  const live = new Set(liveCredentials(rows, now).map(row => String(row.id)));
  return { ...access, credentials: held.filter(row => live.has(String(row.id))) };
}

/**
 * Take the job, or find somebody else already has it.
 *
 * The queue delivers at least once, so two instances can hold the same message. The status check
 * and the write are made one operation by the row's etag: the loser gets a 412 and returns instead
 * of building the same zip over the top of the winner's.
 *
 * ponytail: reaches past the repository for the one primitive it does not expose. Move to
 * `bulkDownloads.claim()` when that file next changes.
 */
async function claim(job, now) {
  // 'running' past the visibility timeout is an instance that died mid-build: the redelivery is
  // the retry, and refusing it would leave the row (and its quota slot) stuck forever.
  const stale = job.status === 'running' && job.startedAt &&
    now - Date.parse(job.startedAt) > config.bulkStaleRunningMs;
  if (job.status !== 'queued' && job.status !== 'failed' && !stale) return null;
  const claimed = { ...job, status: 'running', startedAt: new Date(now).toISOString() };
  await cosmos.replace(bulkDownloads.CONTAINER, job.id, job.id, claimed, job._etag);
  return claimed;
}

/**
 * Give this job's quota slot back, ONCE for its whole life.
 *
 * The counter is per requester, not per job, so a second release frees a slot one of that
 * requester's other jobs is holding — which is how a retried message hands out extra capacity.
 * `slotReleasedAt` on the row is what a redelivery (and the cleanup sweep) reads to know it is
 * already done. Best effort in both directions: the counter is the controller's and may not exist.
 */
async function releaseSlot(job) {
  if (typeof bulkDownloads.releaseSlot !== 'function' || !job || !job.requesterKey) return;
  if (job.slotReleasedAt) return;
  try {
    await bulkDownloads.releaseSlot(job.requesterKey);
    // Stamped only once the counter really moved: a release that threw has not happened, and the
    // sweep still has to find that slot.
    job.slotReleasedAt = new Date().toISOString();
    await bulkDownloads.patch(job.id, { slotReleasedAt: job.slotReleasedAt });
  } catch (err) {
    logger.warn(`[bulk] could not release slot for ${job.id}`, { error: err.message });
  }
}

/** A patch that must not become the reason the job fails. */
async function patchQuietly(id, fields, what) {
  try {
    await bulkDownloads.patch(id, fields);
  } catch (err) {
    logger.error(`[bulk] could not mark ${id} ${what}`, { error: err.message });
  }
}

/**
 * A re-run writes the same part keys, so whatever the last attempt uploaded is reachable only
 * through the row we are about to overwrite. Delete it first or it is storage nobody ever frees.
 */
async function dropExistingParts(job) {
  for (const part of job.parts || []) {
    try {
      await storage.removeObject(part.key);
    } catch (err) {
      logger.warn(`[bulk] could not drop stale part ${part.key}`, { error: err.message });
    }
  }
}

/**
 * Run one job to completion. Safe to call again for the same id: a `ready` job returns untouched,
 * and a job another instance is already running is left alone.
 *
 * @param {string} jobId
 * @param {object} [delivery]
 * @param {number} [delivery.attempt]      this message's dequeue count
 * @param {number} [delivery.maxAttempts]  host.json `maxDequeueCount`
 */
async function run(jobId, { attempt = 1, maxAttempts = 1 } = {}) {
  const id = String(jobId || '').trim();
  const job = await bulkDownloads.getById(id);
  if (!job) {
    // Nothing to retry: a message with no row can only be logged and dropped.
    logger.warn(`[bulk] job missing ${id}`);
    return null;
  }
  if (job.status === 'ready') return job;

  const now = Date.now();
  const age = now - Date.parse(job.createdAt || '');
  // A message that sat in the queue longer than this describes a selection the caller has given up
  // on, and its access snapshot is that stale too. Not rethrown: a retry would only be older.
  if (config.bulkMaxJobAgeMs && Number.isFinite(age) && age > config.bulkMaxJobAgeMs) {
    logger.warn(`[bulk] job expired before run ${id}`);
    await patchQuietly(id, {
      status: 'failed', error: 'expired before run', finishedAt: new Date(now).toISOString()
    }, 'expired');
    await releaseSlot(job);
    return null;
  }

  try {
    if (!(await claim(job, now))) {
      logger.warn(`[bulk] job already claimed ${id} (${job.status})`);
      return null;
    }
  } catch (err) {
    // A lost race is the normal case, not a failure — the instance that won is building the zip.
    logger.warn(`[bulk] could not claim ${id}`, { error: err.message });
    return null;
  }

  try {
    await dropExistingParts(job);

    const access = await freshAccess(job, now);
    const errors = [];
    const docs = await manifest(job, access, errors);
    const projectNames = await projectNamesFor(access, docs);

    const done = [];
    let bytes = 0;
    let includedCount = 0;
    let from = 0;
    // The second clause: everything went away between submit and now, so ship one part anyway —
    // it carries errors.txt, which is the only thing left to tell the caller.
    while (from < docs.length || (done.length === 0 && errors.length > 0)) {
      const { part, next } = await buildPart({
        jobId: id,
        n: done.length + 1,
        docs,
        from,
        projectNames,
        access,
        errors,
        maxBytes: config.bulkMaxTotalBytes - bytes,
        partMaxBytes: config.bulkMaxBytes
      });
      done.push(part);
      bytes += part.bytes;
      includedCount += part.count;
      from = next;
      // Patched per part so a poll reports progress rather than silence.
      await bulkDownloads.patch(id, { parts: done });
    }

    // Before the row says `ready`: the build is over, so the slot is not this job's any more, and
    // releasing here keeps the status the LAST thing a poll can see change.
    await releaseSlot(job);

    // Two patches because Cosmos caps one at PATCH_MAX_OPERATIONS, and in this order because the
    // status is what a poll acts on: `ready` must never be visible before the parts it names.
    await bulkDownloads.patch(id, {
      parts: done,
      partCount: done.length,
      includedCount,
      bytes,
      errorCount: errors.length,
      errors: errors.slice(0, MAX_STORED_ERRORS),
      ttl: config.bulkJobTtlDays * SECONDS_PER_DAY
    });
    await bulkDownloads.patch(id, { status: 'ready', finishedAt: new Date().toISOString() });

    // No telemetry call: auditEvent and analyticsEvent both take a request, and there is no request
    // here — src/utils/audit.js has no request-less variant to use.
    logger.info(
      `[bulk] job ready ${id} parts=${done.length} documents=${includedCount} errors=${errors.length}`
    );

    return { id, parts: done, includedCount, bytes, errorCount: errors.length };
  } catch (err) {
    // `[bulk] job failed` is the string the poison alert matches (observability.bicep), so it is
    // logged only on the delivery that will actually poison — an earlier attempt still has a retry
    // and firing the alert on it would page somebody for a transient outage.
    const final = attempt >= maxAttempts;
    logger.error(
      final
        ? `[bulk] job failed ${id}: ${err.message}`
        : `[bulk] attempt failed ${id} (${attempt}/${maxAttempts}): ${err.message}`,
      { error: err.message, stack: err.stack }
    );
    // `parts` is deliberately not cleared: the keys built so far are what the sweeper deletes.
    await patchQuietly(id, {
      status: 'failed', error: err.message, finishedAt: new Date().toISOString()
    }, 'failed');
    // Only the delivery that runs out of retries: an intermediate failure still has an attempt
    // coming, and a slot given back now is one this requester's other jobs are still holding.
    if (final) await releaseSlot(job);
    // Rethrown so the queue retries and then poisons; the retry re-runs a failed job on purpose.
    throw err;
  }
}

module.exports = { run };
