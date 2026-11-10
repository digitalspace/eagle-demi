'use strict';

// Project row helpers the controller's routes share; none of them answers a request.

const projects = require('../../repositories/projects');
const { clearDeleted, deletedBy, hasValue, eagleOnlyProjectId } = require('../../merge/project');
const { TRACK_PUSHED_AT } = require('../../ownership/project');
const { shortUrlFor, projectTarget } = require('../../helpers/short-links');
const { writeGuarded } = require('../../helpers/etag-write');
const { logger } = require('../../utils/logger');

/** `row` is the stored project the redacted one came from; the target is derived, not a field. */
function shortCodeBody(project, row) {
  return {
    shortCode: project.shortCode || null,
    shortUrl: project.shortCode ? shortUrlFor(project.shortCode) : null,
    legacyShortCodes: project.legacyShortCodes || [],
    url: projectTarget(row),
    shortLinkCustom: Boolean(row.shortLinkUrl)
  };
}

/** What a push's rebuild drops but the stored row keeps, since the upsert replaces the whole item. */
function carryRowMarkers(merged, existing) {
  if (!existing) return;
  // An upsert with no vis wipes classification.
  if (existing.vis) merged.vis = existing.vis;
  // Dropped, a retry of a push whose cascade failed would clear the marker saying that cascade is still owed.
  if (existing.cascadePendingAt) merged.cascadePendingAt = existing.cascadePendingAt;
  // Track's ordering stamp: dropped, a stale Track push would land.
  if (existing[TRACK_PUSHED_AT] !== undefined) merged[TRACK_PUSHED_AT] = existing[TRACK_PUSHED_AT];
}

/**
 * Undo the DEMI delete `narrowTwin` copied onto the `eagle-<id>` twin, `read` kept, when `row`'s is
 * DEMI's too; any other twin delete is its own. False when every try lost.
 */
async function restoreTwin(row) {
  const twinId = hasValue(row.eagleId) ? eagleOnlyProjectId(String(row.eagleId)) : null;
  if (!twinId || String(row.id) === twinId || deletedBy(row) !== 'demi') return true;
  const read = () => projects.readForWrite(twinId);
  const written = await writeGuarded({
    existing: await read(),
    reread: read,
    attempt: async (twin) => {
      if (deletedBy(twin) !== 'demi') return { status: 'none' };
      const restored = clearDeleted({ ...twin, updatedAt: new Date().toISOString() });
      return { status: 'saved', twin: await projects.upsert(restored, { etag: twin._etag }) };
    }
  });
  if (written.status === 'saved') logger.info('[Project Controller] restored the Eagle-only copy', { id: row.id, twinId });
  return written.status !== 'conflict';
}

module.exports = { shortCodeBody, restoreTwin, carryRowMarkers };
