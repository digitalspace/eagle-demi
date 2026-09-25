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
const { eagleOnlyProjectId } = require('../merge/project');

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

module.exports = { narrowTwin };
