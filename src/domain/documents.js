'use strict';

const documents = require('../repositories/documents');
const chunks = require('../repositories/chunks');
const restampChunks = require('../jobs/restamp-chunks');
const { systemAccess, readForLevel, capRead } = require('../helpers/access-sql');
const { writeGuarded } = require('../helpers/etag-write');
const { isStalePush, stampPush } = require('./eagle-push');
const { logger } = require('../utils/logger');
const config = require('../config');

// One line per worker, not per push — see propagateParentFields.
let warnedNoRestampTarget = false;

/**
 * A new document's ACL: level 1 (docs/rbac-architecture.md §1), capped at the parent's level.
 * EVERY document write path must go through this.
 */
function resolveDocumentAcl(parentProject) {
  const read = capRead(readForLevel(1), parentProject.read);

  // `published` is READ OFF the capped read[] — read[] is authoritative, isPublished mirrors it.
  return { published: read.includes('public'), read };
}

/**
 * The flagged row for a write that moves a chunk parent field, or null when nothing moved. The flag
 * rides the same upsert, so a re-stamp lost to the poison queue still leaves the row on reconcile.
 */
function stampParentFieldsPending(existing, row) {
  if (!existing || !chunks.parentFieldsChanged(existing, row)) return null;
  // The repository mints the token so it is always later than the row's: two raises sharing one
  // millisecond would let the first re-stamp's clear drop the second flag.
  return { ...row, ...documents.pendingRaiseOps(existing.parentFieldsPendingAt) };
}

/**
 * Write a row built from `existing` only while it is still the stored revision. An unguarded upsert
 * from a snapshot resurrects a cleared pending flag and reverts another writer's parent field.
 *
 * @param {object|null} existing the row the first build read, `null` when there is none
 * @param {() => Promise<object|null>} reread fetches the stored row again after a lost race
 * @param {(current: object|null) => object|null} build the row to write; `null` refuses the row
 * @param {{pushedAt?: number|null}} [options] the eagle mirror's ordering stamp; staff edits have none
 * @returns {Promise<{status: string, saved?: object, owed?: boolean, existing?: object|null}>} status is `saved`, `conflict`, `missing` or `stale`
 */
async function upsertGuarded(existing, reread, build, { pushedAt = null } = {}) {
  let written = null;

  return writeGuarded({
    existing,
    reread,
    attempt: async (current) => {
      // Build first: a row `build` refuses (a sealed one) is refused whatever the stamp says.
      const row = build(current);
      if (!row) return { status: 'missing' };
      // Inside the attempt, so a retry after a 412 judges this push against the one that won.
      if (isStalePush(pushedAt, current)) return { status: 'stale', existing: current };
      written = row;
      // Recomputed per try: the token must be minted off the STORED row, or the other writer's
      // clear takes this flag down with it.
      const owed = stampParentFieldsPending(current, row);
      const item = stampPush(owed || row, pushedAt, current);
      // Guarded on the revision this attempt read, or CREATED when it read none — an unguarded
      // upsert would replace a document another writer created in between.
      const saved = await documents.upsert(item,
        current ? { etag: current._etag } : { create: true });
      return { status: 'saved', saved, owed: Boolean(owed), existing: current };
    },
    onLost: (_current, attempt) =>
      logger.warn('[Document Controller] document write lost its etag race, rebuilding', {
        documentId: written.id, projectId: written.projectId, attempt
      })
  });
}

/**
 * Queue the re-stamp of a moved parent field onto the document's chunks; best-effort, since a stale
 * copy only makes a filter miss. With no queue and no inline opt-in it is skipped, not run inline.
 */
async function propagateParentFields(saved) {
  if (!restampChunks.enabled()) {
    // `func start` with no storage account, and the test suite, ask for the walk explicitly.
    if (config.chunkRestampInline) return patchParentFieldsInline(saved);
    // Once per worker: this fires on every write that moves a field. The row's own flag is per
    // document and is what makes the skip countable.
    if (!warnedNoRestampTarget) {
      warnedNoRestampTarget = true;
      logger.warn(
        '[Document Controller] no CHUNK_RESTAMP_QUEUE and no CHUNK_RESTAMP_INLINE, chunk ' +
        'parent fields left stale — repair with scripts/backfill-chunk-parent-fields.js --pending',
        { documentId: saved.id }
      );
    }
    return;
  }

  try {
    await restampChunks.enqueue({ documentId: saved.id, projectId: saved.projectId });
  } catch (err) {
    // Only a log: the row went in flagged, so the reconcile and `--pending` already see this one.
    logger.error('[Document Controller] chunk parent-field restamp could not be queued', {
      documentId: saved.id, error: err.message, stack: err.stack
    });
  }
}

/** The re-stamp on the request, for a local run that opts in. Swallows errors. */
async function patchParentFieldsInline(saved) {
  try {
    // Guarded on the same token the queue handler uses, so the two walks cannot undo each other.
    const result = await chunks.setParentFieldsForDocument(systemAccess(), saved.id, saved,
      typeof saved.parentFieldsPendingAt === 'string'
        ? { stampedAt: saved.parentFieldsPendingAt }
        : {});
    if (result.failed > 0) {
      // The flag stays raised, same as a partly failed queue run.
      logger.error('[Document Controller] chunk parent-field patch partially failed', {
        documentId: saved.id, ...result
      });
      return;
    }
    // Landed, so clear it here for the same reason the handler does.
    await restampChunks.clearPending(saved);
  } catch (err) {
    logger.error('[Document Controller] chunk parent-field patch failed', {
      documentId: saved.id, error: err.message, stack: err.stack
    });
  }
}

/**
 * After an ingest, raise the pending flag and re-stamp when the parent fields moved mid-ingest: a
 * re-stamp that ran halfway reached only the chunks written so far, then cleared its flag.
 *
 * @param {object} snapshot the document row the ingest stamped its FIRST batch from
 * @param {{moved?: boolean}} [opts] the stream's latch: a value moved mid-ingest, even if it moved back
 */
async function reStampParentFieldDrift(snapshot, { moved = false } = {}) {
  try {
    const current = await documents.getById(systemAccess(), snapshot.id, snapshot.projectId);
    if (!current || (!moved && !chunks.parentFieldsChanged(snapshot, current))) return null;

    // Throws after three lost raises; the catch logs it, as a 500 would make the host re-ingest a
    // document already in. The winning raise keeps the drift on the reconcile line.
    const raised = await documents.setParentFieldsPending(current.id, current.projectId, true);
    if (raised.status !== 'raised') return null;

    logger.info('[Document Controller] parent fields moved during ingest, re-stamp owed', {
      documentId: current.id, projectId: current.projectId, pendingAt: raised.pendingAt
    });
    const flagged = {
      ...current,
      parentFieldsPending: true,
      parentFieldsPendingAt: raised.pendingAt
    };
    await propagateParentFields(flagged);
    return flagged;
  } catch (err) {
    logger.error('[Document Controller] parent-field drift check after ingest failed', {
      documentId: snapshot.id, error: err.message, stack: err.stack
    });
    return null;
  }
}

/**
 * The parent fields whose value is not a List id string or null. Chunks String-coerce these, so a
 * number on the row would never match its chunk copy.
 */
function badParentFieldTypes(changes) {
  return chunks.CHUNK_PARENT_FIELDS.filter(field => Object.hasOwn(changes, field) &&
    changes[field] !== null && typeof changes[field] !== 'string');
}

module.exports = {
  resolveDocumentAcl,
  stampParentFieldsPending,
  upsertGuarded,
  propagateParentFields,
  patchParentFieldsInline,
  reStampParentFieldDrift,
  badParentFieldTypes
};
