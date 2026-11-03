'use strict';

/**
 * The `eagle-<id>` row the Track relink (`src/scripts/sync-track-projects.js`) keeps beside a Track project.
 * An Eagle push lands on the Track row only, so without this the twin keeps serving an ACL Eagle has since narrowed.
 */

const projects = require('../repositories/projects');
const { levelOfRead } = require('./access-sql');
const { writeGuarded } = require('./etag-write');
const { logger } = require('../utils/logger');
const { auditEvent } = require('../utils/audit');
const { eagleOnlyProjectId, deletedBy, markDeleted, clearDeleted } = require('../merge/project');
const { refusedWriteKeys } = require('../vis/redact');

/**
 * Narrow the twin to the Track row's read, keep its delete flag in step, then cascade it; never
 * widens it. Also repays a cascade the twin owes, since no push lands on the twin.
 *
 * @param {object} saved  the Track row this push wrote
 * @param {(row: object, eagleId: string) => Promise<string|null>} cascade  the project cascade
 * @returns {Promise<string|null>} an error message the caller must 500 with, or null
 */
async function narrowTwin(saved, eagleId, cascade) {
  const twinId = eagleOnlyProjectId(String(eagleId));
  if (String(saved.id) === twinId) return null;

  const read = () => projects.readForWrite(twinId);
  const written = await writeGuarded({
    existing: await read(),
    reread: read,
    attempt: async (twin) => {
      if (!twin) return { status: 'none' };
      const narrow = levelOfRead(twin.read) > levelOfRead(saved.read);
      // The twin follows the Track row's delete and an Eagle one's undo; a delete of its own stays.
      const by = deletedBy(saved);
      const twinBy = deletedBy(twin);
      const follow = by ? twinBy !== by && twinBy !== 'demi' : twinBy === 'eagle';
      if (!narrow && !follow) return twin.cascadePendingAt ? { status: 'owed', twin } : { status: 'none' };
      const narrowed = narrow ? { ...twin, read: saved.read, isPublished: saved.isPublished } : { ...twin };
      if (follow) {
        if (by) markDeleted(narrowed, by);
        else clearDeleted(narrowed);
      }
      return { status: 'narrowed', twin: await projects.upsert(narrowed, { etag: twin._etag }) };
    }
  });

  if (written.status === 'none') return null;
  if (written.status === 'conflict') {
    return 'The project changed, but its Eagle-only copy could not be narrowed.';
  }
  const { twin } = written;
  if (written.status === 'narrowed') {
    logger.warn('[project-twin] narrowed the Eagle-only copy beside a Track project',
      { projectId: saved.id, twinId, eagleId });
  }
  const failure = await cascade(twin, eagleId);
  if (!failure && twin.cascadePendingAt) {
    try {
      await projects.patchCascadePending(twin.id, null, twin._etag);
    } catch (err) {
      logger.error('[project-twin] could not clear the owed cascade on the Eagle-only copy',
        { twinId, error: err.message, stack: err.stack });
    }
  }
  return failure;
}

/**
 * `[eagleId, row]` once per lowercased Eagle id, sorted by it. Rows with no Eagle ObjectId are
 * skipped; for a Track row and its `eagle-<id>` twin, `prefer(kept, row)` returns the one to keep.
 */
function onePerEagleId(rows, prefer) {
  const byId = new Map();
  for (const row of rows) {
    if (!row || !projects.EAGLE_OBJECT_ID.test(row.eagleId || '')) continue;
    const eagleId = String(row.eagleId).toLowerCase();
    const kept = byId.get(eagleId);
    byId.set(eagleId, kept ? prefer(kept, row) : row);
  }
  return [...byId].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Whether two stored list values (`tags`, `pins`, `pinsRead`) are the same list; absent reads as empty. */
const sameTags = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);

/** The other row of a Track/`eagle-<id>` pair, or null when the row has none. */
async function readPartner(row) {
  if (!row.eagleId) return null;
  const twinId = eagleOnlyProjectId(String(row.eagleId));
  const partner = String(row.id) === twinId
    ? await projects.readForWriteByEagleId(row.eagleId)
    : await projects.readForWrite(twinId);
  return partner && String(partner.id) !== String(row.id) ? partner : null;
}

/**
 * The keys of `body` the partner's field dials refuse this caller, as a direct PUT there would.
 * Its `read[]` is left unchecked, the same as `mirrorFields`.
 */
async function partnerRefuses(row, access, body) {
  const partner = await readPartner(row);
  return partner ? refusedWriteKeys('projects', body, access, partner) : [];
}

/** DEMI-owned fields PUT copies onto the pair, and the audit action of each copy. */
const MIRRORED = Object.freeze({
  tags: { fields: ['tags'], action: 'project.mirrorTags' },
  pins: { fields: ['pins', 'pinsRead'], action: 'project.mirrorPins' }
});

/**
 * Copy `row`'s stored `fields` (one MIRRORED entry) onto its pair past the caller's `read[]`, safe as only those
 * and `updatedAt` change there; audited under `req`, PUT checks `partnerRefuses` first. Returns a 500 message or null.
 */
async function mirrorFields(row, req, { fields, action }) {
  const read = () => readPartner(row);
  const logFailure = (cause) => logger.error(`[project-twin] could not mirror ${fields[0]} onto the other row of the pair`,
    { projectId: row.id, eagleId: row.eagleId, fields, ...cause });
  try {
    const written = await writeGuarded({
      existing: await read(),
      reread: read,
      attempt: async (partner) => {
        if (!partner) return { status: 'none' };
        // Stored, not this request's snapshot: a PUT on the partner may have landed since ours.
        const primary = await projects.readForWrite(row.id);
        if (!primary || fields.every(field => sameTags(partner[field], primary[field]))) return { status: 'none' };
        const copy = { ...partner, updatedAt: new Date().toISOString() };
        for (const field of fields) copy[field] = [...(primary[field] || [])];
        await projects.upsert(copy, { etag: partner._etag });
        return { status: 'saved', partnerId: partner.id };
      }
    });
    if (written.status === 'saved') {
      auditEvent(req, {
        action,
        targetType: 'project',
        targetId: written.partnerId,
        projectId: written.partnerId,
        detail: { fields, copiedFrom: row.id }
      });
    }
    if (written.status !== 'conflict') return null;
    logFailure();
  } catch (err) {
    // Caught here so the caller still audits the primary write it already made.
    logFailure({ error: err.message, stack: err.stack });
  }
  return `The project ${fields[0]} changed, but the other copy of this project could not take them.`;
}

module.exports = { narrowTwin, mirrorFields, partnerRefuses, MIRRORED, sameTags, onePerEagleId };
