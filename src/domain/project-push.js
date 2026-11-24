'use strict';

const { levelOfRead } = require('../helpers/access-sql');
const {
  mergeTrackProject, mergeEagleOnlyProject, carryDemiOnlyFields, resolveProjectAcl, markDeleted,
  deleteStands, hasValue, isNativeProject, isMintedNative, isDemiOwnedProject
} = require('../merge/project');
const { OWNERS } = require('../ownership/project');
const { carryRowMarkers } = require('./project-rows');
const { carryShortLink } = require('../helpers/short-links');
const { logger } = require('../utils/logger');

/** Eagle's level for its stored copy of a project, read as live. */
const eagleLevel = (eagle) => levelOfRead(resolveProjectAcl(eagle, false));

/** Whether a push leaves the row deleted: its own flag, else the stored delete if it stands; on a DEMI-owned row, the stored flag. */
function pushDeleted(doc, existing) {
  if (isDemiOwnedProject(existing)) return existing.isDeleted === true;
  if (typeof doc.isDeleted === 'boolean') return doc.isDeleted;
  return deleteStands(existing);
}

/**
 * On a native row DEMI owns these outright: no source block exists to re-derive them, so an Eagle
 * fill would stick. `proponentName` follows Eagle's `proponentId`, `isActive` its `activeStatus`.
 */
const EAGLE_FED = new Set(['proponentName', 'isActive']);
const NATIVE_KEPT_FIELDS = ['id', 'trackProjectId', 'sourceSystem', 'centroid', 'createdAt',
  ...OWNERS.track.filter(field => !EAGLE_FED.has(field))];

/**
 * Put a native row's own fields back over the Eagle merge, so the push lands on that row, not an
 * `eagle-<id>` one.
 */
function keepNativeIdentity(merged, existing) {
  for (const field of NATIVE_KEPT_FIELDS) {
    if (existing[field] === undefined) delete merged[field];
    else merged[field] = existing[field];
  }
  merged.sources = { ...existing.sources, eagle: merged.sources.eagle };
  // Sync-out drives the level of a project it created from DEMI; Eagle's stays in `sources.eagle.read`.
  if (isMintedNative(existing)) {
    merged.read = existing.read;
    merged.isPublished = existing.isPublished;
  }
}

/**
 * The row a push writes, built from whatever revision is stored at the moment of the write.
 * `switchTo` names the `legislation_<year>` block an owned row makes current.
 */
function mergeEaglePush(doc, existing, { switchTo, ...inputs } = {}) {
  const deleted = pushDeleted(doc, existing);
  // A push carries no Track phases or works, so the stored ones go back in (not DEMI-only: the sync
  // rebuilds them).
  const merged = existing && existing.sources && existing.sources.track
    ? mergeTrackProject(existing.sources.track, doc, { phases: existing.phases, works: existing.works, deleted, ...inputs })
    : mergeEagleOnlyProject(doc, { deleted });

  // The merge rebuilds only `track`/`eagle`, and the upsert replaces the item, so other source
  // blocks such as `sources.wildfire` are carried here.
  merged.sources = { ...(existing && existing.sources), ...merged.sources };
  if (isNativeProject(existing)) keepNativeIdentity(merged, existing);
  carryRowMarkers(merged, existing);
  // Same replace-the-whole-item trap as sources: dropping the code would leave a printed link
  // pointing at nothing once the nightly sync minted a second one.
  carryShortLink(merged, existing);
  carryDemiOnlyFields(merged, existing, undefined, { switchTo, ...inputs });
  // A Track row with no `epic_guid` holds the Eagle id sync-out gave it; the echo must keep it.
  if (existing && !hasValue(merged.eagleId) && hasValue(existing.eagleId)) merged.eagleId = existing.eagleId;
  // Restore lifts an unheld DEMI delete to Eagle's level; once Eagle deletes or raises its copy, that level is unsafe.
  if (deleteStands(existing) && !merged.levelHeldAt && (doc.isDeleted === true ||
      eagleLevel(merged.sources.eagle) > eagleLevel(existing.sources && existing.sources.eagle))) {
    merged.levelHeldAt = new Date().toISOString();
    logger.info('[Project Controller] Eagle push held a deleted project', { id: merged.id, eagleId: merged.eagleId });
  }
  // Eagle deleting a project DEMI already deleted must not hand the delete to Eagle to undo.
  if (merged.isDeleted === true) markDeleted(merged, deleteStands(existing) ? 'demi' : 'eagle');
  return merged;
}

module.exports = { eagleLevel, mergeEaglePush };
