'use strict';

// The manifest read composes the job's stored access snapshot and IS the access check: never
// `systemAccess()`. A failed document is recorded and skipped; a failed job rethrows for a retry.

const path = require('path');
const { PassThrough } = require('stream');
// zip-stream 7 is ESM-only; require() of it returns the module namespace, not the class.
const ZipStream = require('zip-stream').default;

const config = require('../config');
const storage = require('../storage');
const cosmos = require('../db/cosmos-nosql');
const bulkDownloads = require('../repositories/bulk-downloads');
const credentials = require('../repositories/credentials');
const projects = require('../repositories/projects');
const { liveCredentials } = require('../helpers/credentials');
const { clean, fileNameFor, fitName } = require('../helpers/file-name');
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

// Documents between cancellation checks: one point read buys a stop within a few files.
const CANCEL_CHECK_EVERY = 20;

// The folder's share of the Windows path limit; the name's is in src/helpers/file-name.js.
const MAX_FOLDER_LENGTH = 100;

const SECONDS_PER_DAY = 24 * 60 * 60;

const UNKNOWN_PROJECT = 'unknown-project';
const ERRORS_FILE = 'errors.txt';

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

/** A name no other entry in the folder holds, ` (2)` before the extension; case-insensitive for Windows and macOS. */
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
 * An object failing mid-transfer ends its entry where it stopped, marked TRUNCATED, instead of
 * erroring the archive and abandoning every file after it.
 */
function shielded(source, onTruncate) {
  const out = new PassThrough();
  source.on('error', err => { onTruncate(err); out.end(); });
  source.pipe(out);
  return out;
}

/**
 * Object reads running ahead of the archive in document order; only the append is serial.
 * Numbers and how to remeasure them: docs/bulk-download-performance.md.
 */
function readAhead(docs, { ahead, concurrency, bufferBytes }) {
  const transfers = Math.max(1, concurrency);
  // One read is the entry being appended, so the window parks one fewer, each with an equal share.
  const perStream = transfers > 1 ? Math.max(1, Math.floor(bufferBytes / transfers)) : 0;
  // Replaces `ahead`: a wider window would hand the next slot past the document the archive needs.
  const limit = perStream > 0 ? Math.max(1, transfers - 1) : Math.max(1, ahead);
  const pending = new Map();

  // Resolves either way and carries its own error: an unhandled 'error' on a parked stream would
  // take the worker down. `shielded` adds a second listener later; both firing is harmless.
  const open = (i, buffered) => {
    const entry = { stream: null, source: null, error: null, dropped: false };
    entry.opened = (async () => {
      try {
        const source = await storage.getObjectStream(docs[i].s3Key);
        entry.source = source;
        // Piping starts the transfer now instead of at this document's turn. `highWaterMark` is the
        // bound: the buffer stops reading the socket there and resumes as the archive drains it.
        const stream = buffered
          ? source.pipe(new PassThrough({ highWaterMark: perStream }))
          : source;
        if (stream !== source) {
          // Same reason as the source's listener below: a buffer sitting in the window has no
          // reader, so the error the line under this raises on it would take the worker down.
          stream.on('error', err => { entry.error = entry.error || err; });
        }
        source.on('error', err => {
          entry.error = entry.error || err;
          // A buffer whose source died never ends on its own; destroyed WITH the error, an entry
          // being appended is reported truncated rather than quietly ending short.
          if (stream !== source) stream.destroy(err);
        });
        if (entry.dropped) {
          source.destroy();
          if (stream !== source) stream.destroy();
        } else {
          entry.stream = stream;
        }
      } catch (err) {
        entry.error = err;
      }
      return entry;
    })();
    return entry;
  };

  // Close one entry for good. Synchronous on purpose — a dead upload must not wait out an open the
  // object store can sit on for minutes — so a stream still arriving is closed by `open` instead.
  const drop = entry => {
    if (!entry) return;
    entry.dropped = true;
    if (entry.stream) entry.stream.destroy();
    if (entry.source && entry.source !== entry.stream) entry.source.destroy();
  };

  // The one taken but not yet handed to the archive. Held here because `destroy` has to reach it:
  // a part that dies during this document's open would otherwise leave that socket to nobody.
  let current = null;

  return {
    /** Keep the window full from `next` on, past the end of this part — see `destroy`. */
    fill(next) {
      for (let i = next; i < docs.length && pending.size < limit; i += 1) {
        if (!pending.has(i)) pending.set(i, open(i, perStream > 0));
      }
    },
    /** Called twice for the same document to re-open it — the first entry is closed here. */
    take(i) {
      // Unbuffered: an open made at its own turn is read by the archive straight away, so a buffer
      // in front of it would only copy bytes.
      if (!pending.has(i)) pending.set(i, open(i, false));
      const entry = pending.get(i);
      pending.delete(i);
      drop(current);
      current = entry;
      return entry.opened;
    },
    /** The archive owns this stream from here, so the window stops closing it. */
    release() {
      current = null;
    },
    /** Everything opened that this part never reached: a part that rolled, a cancel, a fatal error. */
    destroy() {
      for (const entry of pending.values()) drop(entry);
      pending.clear();
      drop(current);
      current = null;
    }
  };
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

/** Has the caller cancelled since this job started? A point read on the job's own partition. */
async function isCancelled(jobId) {
  const row = await bulkDownloads.getById(jobId);
  return Boolean(row) && row.status === 'cancelled';
}

/**
 * One part, streamed: the upload starts before the first entry, so the zip never sits in memory.
 * It ends on bytes actually written, since many rows lack `fileSize`; returns where it stopped.
 */
async function buildPart({
  jobId, n, docs, from, projectNames, access, errors, includedProjects, maxBytes, partMaxBytes
}) {
  const key = `zips/${jobId}-part${n}.zip`;
  const archive = new ZipStream({ store: true });
  const uploaded = storage.putObjectStream(key, archive, 'application/zip');

  // An archive error or rejected upload is fatal to the part: every await races this, so the loop
  // cannot hang on a dead consumer. Deliberately outside the per-document catch.
  let fatal = null;
  const died = new Promise((_resolve, reject) => {
    const die = err => { fatal = fatal || err; reject(err); };
    archive.on('error', die);
    uploaded.then(undefined, die);
  });
  died.catch(() => {}); // only ever consumed through the race below
  const orDie = promise => Promise.race([promise, died]);

  const taken = new Set();
  const ahead = readAhead(docs, {
    ahead: config.bulkFetchAhead,
    concurrency: config.bulkFetchConcurrency,
    bufferBytes: config.bulkFetchBufferBytes
  });
  let included = 0;
  let cancelled = false;
  let i = from;

  try {
    for (; i < docs.length; i += 1) {
      // Falls through to `finish()`: the upload is consuming this archive, and abandoning it
      // unfinished would leave a multipart stream nobody ends.
      if (i > from && (i - from) % CANCEL_CHECK_EVERY === 0 && await isCancelled(jobId)) {
        cancelled = true;
        break;
      }

      const doc = docs[i];
      // Roll before appending. First clause: a part filled by unsized documents; second: a known
      // size that would overshoot a part with room left.
      const written = archive.getBytesWritten();
      if (i > from && (written >= partMaxBytes || written + knownSize(doc) > partMaxBytes)) break;

      ahead.fill(i);
      const opened = ahead.take(i);

      const fitted = fitName(clean(projectNames.get(String(doc.projectId))), MAX_FOLDER_LENGTH) || UNKNOWN_PROJECT;
      const folder = fitted.toLowerCase() === ERRORS_FILE ? `${fitted} (project)` : fitted;
      const name = uniqueName(taken, folder, fileNameFor(doc, access));
      let truncated = null;

      try {
        let entry = await orDie(opened);
        // Only once this one has settled: refilling before it would hold one more socket open
        // than the window allows.
        ahead.fill(i + 1);
        // A parked stream can be reset while earlier documents pack: one fresh open at its turn,
        // then it is the document's failure.
        if (entry.error && entry.stream) entry = await orDie(ahead.take(i));
        if (entry.error) throw entry.error;
        ahead.release();
        await orDie(addEntry(
          archive, shielded(entry.stream, e => { truncated = e; }), `${folder}/${name}`
        ));
      } catch (err) {
        if (fatal) throw fatal;
        logger.warn(`[bulk] object unreadable job=${jobId} document=${doc.id}`,
          { error: err.message, stack: err.stack });
        errors.push({ documentId: doc.id, name, reason: REASON.unavailable });
        continue;
      }

      if (truncated) {
        logger.warn(`[bulk] object truncated job=${jobId} document=${doc.id}`,
          { error: truncated.message, stack: truncated.stack });
        errors.push({ documentId: doc.id, name, reason: REASON.truncated });
      } else {
        included += 1;
        includedProjects.add(String(doc.projectId));
      }

      // The whole job's budget, against real bytes — the estimate the caller was refused on could
      // not see the documents whose size was never recorded.
      if (archive.getBytesWritten() > maxBytes) throw new Error('over the size limit');
    }
  } finally {
    ahead.destroy();
  }

  // errors.txt rides in the last part, which is the one that ran out of documents rather than room.
  if (i >= docs.length && errors.length > 0) {
    await orDie(addEntry(archive, Buffer.from(errorsText(errors), 'utf8'), ERRORS_FILE));
  }

  archive.finish();
  await orDie(uploaded);

  return {
    part: { n, key, bytes: archive.getBytesWritten(), count: included },
    next: i,
    cancelled
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
 * The zip name: the one project the included files came from, or how many. Empty when the caller
 * may not see that name; the status route then uses a generic one rather than an id.
 */
function labelFor(ids, projectNames) {
  if (ids.size > 1) return `${ids.size} projects`;
  const [id] = ids;
  return fitName(clean(projectNames.get(id)), MAX_FOLDER_LENGTH);
}

/**
 * The access snapshot with revoked credentials dropped; roles stay frozen at submit. Every stored
 * party is re-read, since a realm group can hold a grant. Narrows only, never widens.
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

/** Take the job: delivery is at-least-once, so the etag makes check and write one; the loser gets 412. */
// ponytail: reaches past the repository for the one primitive it lacks; move to bulkDownloads.claim().
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
 * Give this job's quota slot back, ONCE for its whole life — the counter is per requester, so a
 * second release frees a slot one of that requester's other jobs is holding.
 */
async function releaseSlot(job) {
  if (typeof bulkDownloads.releaseSlot !== 'function' || !job || !job.requesterKey) return;
  if (job.slotReleasedAt) return;
  try {
    const at = new Date().toISOString();
    // The stamp is the claim, and a cancel writes the same one: whoever lands it decrements.
    if (!(await bulkDownloads.claimSlotRelease(job.id, at))) return;
    job.slotReleasedAt = at;
    await bulkDownloads.releaseSlot(job.requesterKey);
  } catch (err) {
    logger.warn(`[bulk] could not release slot for ${job.id}`, { error: err.message, stack: err.stack });
  }
}

/**
 * Flip the job to a terminal status, never becoming the reason it fails. False: a cancel
 * finished it first, so the row and its slot are the canceller's.
 */
async function markTerminal(id, fields, statuses, what) {
  try {
    return await bulkDownloads.patchIfStatus(id, fields, statuses);
  } catch (err) {
    logger.error(`[bulk] could not mark ${id} ${what}`, { error: err.message, stack: err.stack });
    return false;
  }
}

/**
 * A re-run writes the same part keys, so whatever the last attempt uploaded is reachable only
 * through the row we are about to overwrite. Delete it first or it is storage nobody ever frees.
 */
async function dropParts(parts) {
  const left = [];
  for (const part of parts || []) {
    try {
      await storage.removeObject(part.key);
    } catch (err) {
      left.push(part);
      logger.warn(`[bulk] could not drop part ${part.key}`, { error: err.message, stack: err.stack });
    }
  }
  return left;
}

/**
 * Give up on a cancelled job: delete the parts built so far, leaving on the row whatever would not
 * delete — that is all the cleanup sweep has to find it by. Wiki [[Bulk-Download]] §Cancelling.
 */
async function abandon(id, parts) {
  await bulkDownloads.patch(id, { parts });
  await bulkDownloads.patch(id, { parts: await dropParts(parts) });
  logger.info(`[bulk] job cancelled ${id}`);
  return null;
}

/**
 * Run one job; safe to repeat. `attempt` is the dequeue count, `maxAttempts` host.json
 * `maxDequeueCount`.
 */
async function run(jobId, { attempt = 1, maxAttempts = 1 } = {}) {
  const id = String(jobId || '').trim();
  // Zip ids are UUIDs; `quota:` and `searchdef:` rows share the container, and patching one to
  // `ready` would end a chunks rebuild. Checked before the read, so a wrong id never writes.
  if (id.includes(':')) {
    logger.warn(`[bulk] refusing ${id}: a prefixed id belongs to another kind of row`);
    return null;
  }
  const job = await bulkDownloads.getById(id);
  if (!job) {
    // Nothing to retry: a message with no row can only be logged and dropped.
    logger.warn(`[bulk] job missing ${id}`);
    return null;
  }
  // Belt and braces with the id check above: a row that names a `kind` is another job type's, and
  // zip rows have never carried one.
  if (job.kind) {
    logger.warn(`[bulk] refusing ${id}: it is a ${job.kind} row, not a bulk download`);
    return null;
  }
  if (job.status === 'ready') return job;
  // Cancelled before this message was ever dequeued: whoever cancelled released the slot.
  if (job.status === 'cancelled') {
    logger.info(`[bulk] job cancelled ${id}`);
    return null;
  }

  const now = Date.now();
  const age = now - Date.parse(job.createdAt || '');
  // A message that sat in the queue longer than this describes a selection the caller has given up
  // on, and its access snapshot is that stale too. Not rethrown: a retry would only be older.
  if (config.bulkMaxJobAgeMs && Number.isFinite(age) && age > config.bulkMaxJobAgeMs) {
    logger.warn(`[bulk] job expired before run ${id}`);
    const expired = await markTerminal(id, {
      status: 'failed', error: 'expired before run', finishedAt: new Date(now).toISOString()
    }, ['queued', 'running', 'failed'], 'expired');
    if (expired) await releaseSlot(job);
    return null;
  }

  try {
    if (!(await claim(job, now))) {
      logger.warn(`[bulk] job already claimed ${id} (${job.status})`);
      return null;
    }
  } catch (err) {
    // A lost race is the normal case, not a failure — the instance that won is building the zip.
    logger.warn(`[bulk] could not claim ${id}`, { error: err.message, stack: err.stack });
    return null;
  }

  try {
    await dropParts(job.parts);

    const access = await freshAccess(job, now);
    const errors = [];
    const docs = await manifest(job, access, errors);
    const projectNames = await projectNamesFor(access, docs);

    const done = [];
    let bytes = 0;
    let includedCount = 0;
    const includedProjects = new Set();
    let from = 0;
    // The second clause: everything went away between submit and now, so ship one part anyway —
    // it carries errors.txt, which is the only thing left to tell the caller.
    while (from < docs.length || (done.length === 0 && errors.length > 0)) {
      const { part, next, cancelled } = await buildPart({
        jobId: id,
        n: done.length + 1,
        docs,
        from,
        projectNames,
        access,
        errors,
        includedProjects,
        maxBytes: config.bulkMaxTotalBytes - bytes,
        partMaxBytes: config.bulkMaxBytes
      });
      done.push(part);
      if (cancelled) return abandon(id, done);
      bytes += part.bytes;
      includedCount += part.count;
      from = next;
      // Patched per part so a poll reports progress rather than silence.
      await bulkDownloads.patch(id, { parts: done });
      // Between parts too: a cancel here would otherwise wait out a whole part.
      if (await isCancelled(id)) return abandon(id, done);
    }

    // Two patches because Cosmos caps one at PATCH_MAX_OPERATIONS, and in this order because the
    // status is what a poll acts on: `ready` must never be visible before the parts it names.
    await bulkDownloads.patch(id, {
      parts: done,
      partCount: done.length,
      label: labelFor(includedProjects, projectNames),
      includedCount,
      bytes,
      errorCount: errors.length,
      errors: errors.slice(0, MAX_STORED_ERRORS),
      ttl: config.bulkJobTtlDays * SECONDS_PER_DAY
    });
    // Conditional: a cancel that won this race owns the row, and its parts are ours to delete.
    const marked = await bulkDownloads.patchIfStatus(
      id, { status: 'ready', finishedAt: new Date().toISOString() }, ['running']
    );
    if (!marked) return abandon(id, done);

    // Only now the row really says `ready`, so the slot is not this job's any more.
    await releaseSlot(job);

    // No telemetry call: auditEvent and analyticsEvent both take a request, and there is no request
    // here — src/utils/audit.js has no request-less variant to use.
    logger.info(
      `[bulk] job ready ${id} parts=${done.length} documents=${includedCount} ` +
      `errors=${errors.length} fetch=${config.bulkFetchConcurrency} ` +
      `buffer=${config.bulkFetchConcurrency > 1 ? config.bulkFetchBufferBytes : 0}`
    );

    return { id, parts: done, includedCount, bytes, errorCount: errors.length };
  } catch (err) {
    // The poison alert matches `[bulk] job failed` (observability.bicep): logged only on the last
    // delivery, so a transient outage with a retry left pages nobody.
    const final = attempt >= maxAttempts;
    logger.error(
      final
        ? `[bulk] job failed ${id}: ${err.message}`
        : `[bulk] attempt failed ${id} (${attempt}/${maxAttempts}): ${err.message}`,
      { error: err.message, stack: err.stack }
    );
    // `parts` is deliberately not cleared: the keys built so far are what the sweeper deletes.
    const marked = await markTerminal(id, {
      status: 'failed', error: err.message, finishedAt: new Date().toISOString()
    }, ['running'], 'failed');
    // Last delivery only: an earlier one still has an attempt holding the slot. `marked` false
    // means a cancel finished the job and released the slot itself.
    if (final && marked) await releaseSlot(job);
    // Rethrown so the queue retries and then poisons; the retry re-runs a failed job on purpose.
    throw err;
  }
}

module.exports = { run, DOCUMENT_FIELDS };
