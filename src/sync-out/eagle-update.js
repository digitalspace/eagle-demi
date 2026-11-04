'use strict';

// Sync-out consumer: Updates (`RecentActivity`) created in DEMI, written into Eagle through eagle-api. A row with an
// `eagleId` is PUT; one Eagle lacks is POSTed under a minted id once SYNC_OUT_EAGLE_NATIVE_ENABLED is on.

const settings = require('../config').syncOut;
const updates = require('../repositories/updates');
const commentPeriods = require('../repositories/comment-periods');
const documents = require('../repositories/documents');
const notifications = require('../repositories/notifications');
const { systemAccess } = require('../helpers/access-sql');
const { logger } = require('../utils/logger');
const {
  requireSettings, call, failure, claimHeld, createMinted, refuseStray, refsFor, mirrorRowUnder
} = require('./eagle');

const NAME = 'eagle';
const KIND = 'update';
const NATIVE = 'demi';
const ARCHIVED = 'archived';
const ROUTE = '/recentActivity';

/** The fields eagle-api's PUT writes as DEMI stores them. Not `dateUpdated`: the PUT refuses one it did not store. */
const FIELDS = Object.freeze([
  'headline', 'content', 'type', 'pinned', 'active', 'complianceAndEnforcement', 'notificationName', 'contentUrl',
  'documentUrl', 'category', 'subject', 'shortHeadline', 'summary', 'regions', 'location', 'engagementUrl', 'status',
  'publishDate'
]);

const pathOf = eagleId => `${ROUTE}/${encodeURIComponent(eagleId)}`;

/**
 * eagle-api's Update body, each reference as an Eagle id, and the references that are not in Eagle yet. Throws
 * when one never will be.
 */
async function bodyFor(row, logFields) {
  const { ref, waiting } = refsFor(KIND, row, logFields);
  const body = {};
  for (const field of FIELDS) {
    if (row[field] !== undefined) body[field] = row[field];
  }
  // A project parent is stored under its Eagle id already; a notification parent is stored under its own.
  const parentNotification = row.projectId ? await notifications.readForWrite(String(row.projectId)) : null;
  body.project = parentNotification ? ref('notification', row.projectId, parentNotification) : row.projectId ?? null;
  body.pcp = row.pcp ? ref('comment period', row.pcp, await commentPeriods.getById(systemAccess(), row.pcp)) : null;
  body.projectNotification = row.projectNotification
    ? ref('notification', row.projectNotification, await notifications.readForWrite(String(row.projectNotification)))
    : null;

  const images = Array.isArray(row.images) ? row.images : [];
  const attachments = Array.isArray(row.attachments) ? row.attachments : [];
  const ids = [row.featuredImage && row.featuredImage.document, ...images.map(i => i && i.document), ...attachments];
  const stored = new Map((await documents.listSyncRefs(ids.filter(Boolean))).map(doc => [String(doc.id), doc]));
  const docRef = id => ref('document', id, stored.get(String(id)));
  const imageOf = image => (image && image.document ? { ...image, document: docRef(image.document) } : image);
  if (row.featuredImage !== undefined) body.featuredImage = imageOf(row.featuredImage);
  if (row.images !== undefined) body.images = images.map(imageOf);
  if (row.attachments !== undefined) body.attachments = attachments.map(docRef);
  return { body, waiting: waiting() };
}

/** PUT the row's fields; false when Eagle has no Update under the id. */
async function put(s, eagleId, body, logFields) {
  const path = pathOf(eagleId);
  const res = await call(s, 'PUT', path, body, logFields);
  if (res.status === 404) return false;
  if (!res.ok) throw failure('PUT', path, res);
  return true;
}

// An Update archived before Eagle held it has nothing to archive there.
const owned = row => Boolean(row && row.sourceSystem === NATIVE) && !(row.status === ARCHIVED && !row.eagleId);
const wants = row => owned(row) && Boolean(row.eagleId || settings.eagle.nativeEnabled);

/** Write the row to its Eagle Update, creating it when Eagle has none. `update` is the engine's guarded write. */
async function send(row, { update }) {
  if (!owned(row)) return { status: 'skipped' };
  const s = requireSettings({ milestone: false });
  refuseStray(row);
  const logFields = { rowId: row.id, eagleId: row.eagleId || null, kind: KIND };
  // Held, not skipped: a skip records the version as sent, so the row would never go once the switch is on.
  if (!row.eagleId && !settings.eagle.nativeEnabled) return { status: 'held' };
  const { body, waiting } = await bodyFor(row, logFields);
  if (waiting.length) {
    // The engine queues the row again when that record's own send lands (index.js, queueHeldOn).
    logger.warn(`[sync-out eagle] update ${row.id} held: ${waiting.join('; ')}`, { ...logFields, waiting });
    return { status: 'held' };
  }

  if (row.eagleId && await put(s, String(row.eagleId), body, logFields)) {
    return { status: 'sent', eagleId: String(row.eagleId) };
  }
  if (!settings.eagle.nativeEnabled) return { status: 'held' };

  return createMinted(s, row, body, update, logFields, {
    kind: KIND,
    path: ROUTE,
    noun: 'Update',
    put: (eagleId, fields) => put(s, eagleId, body, fields),
    mintedOnly: true,
    unknownId: () => ({ line: 'Eagle stored the Update under an unknown id; find it by headline', fields: { headline: body.headline } }),
    // eagle-api's POST stores every new Update unpinned.
    ...(row.pinned === true ? { afterCreate: (eagleId, fields) => put(s, eagleId, body, fields) } : {}),
    // The mirror reads by id first, so a row already stored under the id would take every echo for good.
    heldByMirror: mirroredAsEagleRow,
    twinOf: mirroredAsEagleRow
  });
}

const mirroredAsEagleRow = mirrorRowUnder(eagleId => updates.readForWrite(eagleId));

module.exports = {
  name: NAME,
  enabled: () => settings.eagle.enabled && settings.eagle.updateEnabled,
  enableSettings: Object.freeze(['SYNC_OUT_EAGLE_ENABLED', 'SYNC_OUT_EAGLE_UPDATE_ENABLED']),
  wants,
  inFlight: entry => Boolean(claimHeld(entry, Date.now())),
  send
};
