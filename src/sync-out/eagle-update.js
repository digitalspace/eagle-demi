'use strict';

// Sync-out consumer: Updates (`RecentActivity`) created in DEMI, written into Eagle through eagle-api. A row with an
// `eagleId` is PUT; one Eagle lacks is POSTed under a minted id once SYNC_OUT_EAGLE_NATIVE_ENABLED is on.

const settings = require('../config').syncOut;
const updates = require('../repositories/updates');
const commentPeriods = require('../repositories/comment-periods');
const documents = require('../repositories/documents');
const notifications = require('../repositories/notifications');
const { readParent } = require('../helpers/update-parent');
const { systemAccess } = require('../helpers/access-sql');
const { UPDATE_SCHEMA } = require('../domain/updates');
const { logger } = require('../utils/logger');
const {
  requireSettings, call, failure, claimHeld, createMinted, refuseStray
} = require('./eagle');

const NAME = 'eagle';
const KIND = 'update';
const NATIVE = 'demi';
const ROUTE = '/recentActivity';

/** Fields that name another record by DEMI id; the body names it by Eagle id. */
const REFS = Object.freeze(['projectId', 'pcp', 'projectNotification', 'attachments']);
// Not `_etag`: that is DEMI's. Not `dateUpdated`: eagle-api's PUT refuses a body whose date is not the stored one.
const FIELDS = Object.freeze([
  ...Object.keys(UPDATE_SCHEMA).filter(field => !REFS.includes(field) && field !== '_etag'), 'regions'
]);

const pathOf = eagleId => `${ROUTE}/${encodeURIComponent(eagleId)}`;

/** The Eagle id of the record `id` names; throws when DEMI holds none, so nothing goes with a DEMI id in it. */
async function eagleIdOf(what, id, read, logFields) {
  const stored = await read(String(id));
  if (stored && stored.eagleId) return String(stored.eagleId);
  logger.error(`[sync-out eagle] ${what} ${id} of update ${logFields.rowId} has no eagleId, nothing sent`,
    { ...logFields, refId: String(id) });
  throw new Error(`${what} ${id} of update ${logFields.rowId} has no eagleId`);
}

const parentRead = async (id) => {
  const parent = await readParent(id);
  return parent && parent.doc;
};
const periodRead = id => commentPeriods.getById(systemAccess(), id);
const documentRead = id => documents.getById(systemAccess(), id);

/** An image with its document named by Eagle id. */
async function imageFor(image, logFields) {
  if (!image || !image.document) return image;
  return { ...image, document: await eagleIdOf('document', image.document, documentRead, logFields) };
}

/** eagle-api's Update body: the fields its PUT writes, each reference as an Eagle id. */
async function bodyFor(row, logFields) {
  const body = {};
  for (const field of FIELDS) {
    if (row[field] !== undefined) body[field] = row[field];
  }
  const ref = (what, id, read) => (id ? eagleIdOf(what, id, read, logFields) : null);
  body.project = await ref('parent', row.projectId, parentRead);
  body.pcp = await ref('comment period', row.pcp, periodRead);
  body.projectNotification = await ref('notification', row.projectNotification, id => notifications.readForWrite(id));
  body.attachments = await Promise.all((row.attachments || []).map(id => ref('document', id, documentRead)));
  if (row.featuredImage !== undefined) body.featuredImage = await imageFor(row.featuredImage, logFields);
  if (row.images !== undefined) body.images = await Promise.all((row.images || []).map(i => imageFor(i, logFields)));
  return body;
}

/** PUT the row's fields; false when Eagle has no Update under the id. */
async function put(s, eagleId, body, logFields) {
  const path = pathOf(eagleId);
  const res = await call(s, 'PUT', path, body, logFields);
  if (res.status === 404) return false;
  if (!res.ok) throw failure('PUT', path, res);
  return true;
}

const owned = row => Boolean(row && row.sourceSystem === NATIVE);
const wants = row => owned(row) && Boolean(row.eagleId || settings.eagle.nativeEnabled);

/** Write the row to its Eagle Update, creating it when Eagle has none. `update` is the engine's guarded write. */
async function send(row, { update }) {
  if (!owned(row)) return { status: 'skipped' };
  const s = requireSettings({ milestone: false });
  refuseStray(row);
  const logFields = { rowId: row.id, eagleId: row.eagleId || null, kind: KIND };
  // Held, not skipped: a skip records the version as sent, so the row would never go once the switch is on.
  if (!row.eagleId && !settings.eagle.nativeEnabled) return { status: 'held' };
  const body = await bodyFor(row, logFields);

  if (row.eagleId && await put(s, String(row.eagleId), body, logFields)) {
    return { status: 'sent', eagleId: String(row.eagleId) };
  }
  if (!settings.eagle.nativeEnabled) return { status: 'held' };

  return createMinted(s, row, body, update, logFields, {
    kind: KIND,
    path: ROUTE,
    noun: 'Update',
    put: (eagleId, fields) => put(s, eagleId, body, fields),
    unknownId: () => ({ line: 'Eagle stored the Update under an unknown id; find it by headline', fields: { headline: body.headline } }),
    // eagle-api's POST stores every new Update unpinned.
    ...(row.pinned === true ? { afterCreate: (eagleId, fields) => put(s, eagleId, body, fields) } : {}),
    // The mirror reads by id first, so a row already stored under the id would take every echo for good.
    heldByMirror: mirroredAsEagleRow,
    twinOf: mirroredAsEagleRow
  });
}

async function mirroredAsEagleRow(eagleId, row) {
  const stored = await updates.readForWrite(eagleId);
  // Mirror rows carry no `sourceSystem`.
  return Boolean(stored && stored.id !== row.id && stored.sourceSystem !== NATIVE);
}

module.exports = {
  name: NAME,
  enabled: () => settings.eagle.enabled && settings.eagle.updateEnabled,
  enableSettings: Object.freeze(['SYNC_OUT_EAGLE_ENABLED', 'SYNC_OUT_EAGLE_UPDATE_ENABLED']),
  wants,
  inFlight: entry => Boolean(claimHeld(entry, Date.now())),
  send,
  bodyFor
};
