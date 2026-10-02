'use strict';

/**
 * The `eagle-<id>` row the Track relink keeps beside a Track project (sync-track-projects.js). An
 * Eagle push lands on the Track row only, so without this the twin keeps serving an ACL Eagle has
 * since narrowed.
 */

const projects = require('../repositories/projects');
const { levelOfRead } = require('./access-sql');
const { writeGuarded } = require('./etag-write');
const { logger } = require('../utils/logger');
const { auditEvent } = require('../utils/audit');
const { eagleOnlyProjectId } = require('../merge/project');
const { refusedWriteKeys } = require('../vis/redact');

/**
 * Bring the twin down to the Track row's read when that is lower, then cascade it onto the twin's
 * own documents and engagement. Never widens it. A cascade the twin still owes runs here too, since
 * no push ever lands on the twin to repay it.
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
      if (levelOfRead(twin.read) <= levelOfRead(saved.read)) {
        return twin.cascadePendingAt ? { status: 'owed', twin } : { status: 'none' };
      }
      const narrowed = { ...twin, read: saved.read, isPublished: saved.isPublished };
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

/** Whether two stored `tags` values are the same list; absent reads as empty. */
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
 * Whether the partner's field dial on `tags` refuses this caller, as a direct PUT there would.
 * Its `read[]` is left unchecked, the same as `mirrorTags`.
 */
async function partnerRefusesTags(row, access) {
  const partner = await readPartner(row);
  return Boolean(partner) && refusedWriteKeys('projects', { tags: [] }, access, partner).length > 0;
}

/**
 * Copy the row's stored `tags` onto the other row of its pair, so both rows (and the documents
 * each one holds) match the same names, and a removal on one is a removal on both.
 *
 * The partner is read and written without the caller's access: the two rows can carry different
 * `read[]`, and a checked read would skip the partner and leave the pair apart. Only `tags` (and
 * `updatedAt`) change on it, and the write is audited under the caller. The partner's field dial
 * is not skipped: the PUT checks `partnerRefusesTags` before its own write.
 *
 * @param {object} row  the row as it was before this write, so the pair is the one it belonged to
 * @param {object} req  the request whose caller the partner write is audited under
 * @returns {Promise<string|null>} an error message the caller must 500 with, or null
 */
async function mirrorTags(row, req) {
  const read = () => readPartner(row);
  const logFailure = (cause) => logger.error('[project-twin] could not mirror tags onto the other row of the pair',
    { projectId: row.id, eagleId: row.eagleId, ...cause });
  try {
    const written = await writeGuarded({
      existing: await read(),
      reread: read,
      attempt: async (partner) => {
        if (!partner) return { status: 'none' };
        // Stored, not this request's snapshot: a PUT on the partner may have landed since ours.
        const primary = await projects.readForWrite(row.id);
        if (!primary || sameTags(partner.tags, primary.tags)) return { status: 'none' };
        const copy = { ...partner, tags: [...(primary.tags || [])], updatedAt: new Date().toISOString() };
        await projects.upsert(copy, { etag: partner._etag });
        return { status: 'saved', partnerId: partner.id };
      }
    });
    if (written.status === 'saved') {
      auditEvent(req, {
        action: 'project.mirrorTags',
        targetType: 'project',
        targetId: written.partnerId,
        projectId: written.partnerId,
        detail: { fields: ['tags'], copiedFrom: row.id }
      });
    }
    if (written.status !== 'conflict') return null;
    logFailure();
  } catch (err) {
    // Caught here so the caller still audits the primary write it already made.
    logFailure({ error: err.message, stack: err.stack });
  }
  return 'The project tags changed, but the other copy of this project could not take them.';
}

module.exports = { narrowTwin, mirrorTags, partnerRefusesTags, sameTags };
