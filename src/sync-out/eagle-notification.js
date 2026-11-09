'use strict';

// Sync-out consumer: project notifications created in DEMI, written into Eagle through eagle-api. A row with an
// `eagleId` is PUT; one Eagle lacks is POSTed under a minted id once SYNC_OUT_EAGLE_NATIVE_ENABLED is on.

const settings = require('../config').syncOut;
const notifications = require('../repositories/notifications');
const { FIELDS } = require('../domain/notification-fields');
const {
  requireSettings, call, failure, claimHeld, createMinted, refuseStray, isPublic, mirrorRowUnder
} = require('./eagle');

const NAME = 'eagle';
const KIND = 'notification';
const NATIVE = 'demi';
const ROUTE = '/projectNotification';

// eagle-api sets the level from `?publish=` on both POST and PUT; it has no publish route for notifications.
const withLevel = (path, row) => `${path}?publish=${isPublic(row.read)}`;
const pathOf = eagleId => `${ROUTE}/${encodeURIComponent(eagleId)}`;

function bodyFor(row) {
  const body = {};
  for (const field of FIELDS) {
    if (row[field] !== undefined) body[field] = row[field];
  }
  return body;
}

/** PUT the row's fields and level; false when Eagle has no notification under the id. */
async function put(s, eagleId, row, body, logFields) {
  const path = withLevel(pathOf(eagleId), row);
  const res = await call(s, 'PUT', path, body, logFields);
  if (res.status === 404) return false;
  if (!res.ok) throw failure('PUT', path, res);
  return true;
}

const owned = row => Boolean(row && row.sourceSystem === NATIVE);
const wants = row => owned(row) && Boolean(row.eagleId || settings.eagle.nativeEnabled);

/** Write the row to its Eagle notification, creating it when Eagle has none. `update` is the engine's guarded write. */
async function send(row, { update }) {
  if (!owned(row)) return { status: 'skipped' };
  const s = requireSettings({ milestone: false });
  refuseStray(row);
  const logFields = { rowId: row.id, eagleId: row.eagleId || null, kind: KIND };
  const body = bodyFor(row);

  if (row.eagleId && await put(s, String(row.eagleId), row, body, logFields)) {
    return { status: 'sent', eagleId: String(row.eagleId) };
  }
  // Held, not skipped: a skip records the version as sent, so the row would never go once the switch is on.
  if (!settings.eagle.nativeEnabled) return { status: 'held' };

  return createMinted(s, row, body, update, logFields, {
    kind: KIND,
    path: withLevel(ROUTE, row),
    noun: 'notification',
    put: (eagleId, fields) => put(s, eagleId, row, body, fields),
    mintedOnly: true,
    unknownId: () => ({ line: 'Eagle stored the notification under an unknown id; find it by name', fields: { name: body.name } }),
    // The mirror reads by id first, so a row already stored under the id would take every echo for good.
    heldByMirror: mirroredAsEagleRow,
    twinOf: mirroredAsEagleRow
  });
}

const mirroredAsEagleRow = mirrorRowUnder(eagleId => notifications.readForWrite(eagleId));

module.exports = {
  name: NAME,
  enabled: () => settings.eagle.enabled && settings.eagle.notificationEnabled,
  enableSettings: Object.freeze(['SYNC_OUT_EAGLE_ENABLED', 'SYNC_OUT_EAGLE_NOTIFICATION_ENABLED']),
  wants,
  inFlight: entry => Boolean(claimHeld(entry, Date.now())),
  send,
  bodyFor
};
