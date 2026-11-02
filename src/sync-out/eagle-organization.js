'use strict';

// Sync-out consumer: organizations created in DEMI, written into Eagle through eagle-api. A row with an
// `eagleId` is PUT; one Eagle lacks is POSTed under a minted id once SYNC_OUT_EAGLE_NATIVE_ENABLED is on.

const settings = require('../config').syncOut;
const lists = require('../repositories/lists');
const { SCHEMA } = require('../domain/organizations');
const { logger } = require('../utils/logger');
const { isScanCleared } = require('../repositories/documents');
const {
  requireSettings, call, failure, claimHeld, createMinted, refuseStray
} = require('./eagle');

const NAME = 'eagle';
const KIND = 'organization';
const NATIVE = 'demi';

const pathOf = eagleId => `/organization/${encodeURIComponent(eagleId)}`;
const isPublic = read => Array.isArray(read) && read.includes('public');

/** eagle-api's organization body: the fields its POST copies. `parentCompany` names the parent's Eagle id. */
async function bodyFor(row) {
  const body = {};
  for (const field of Object.keys(SCHEMA)) {
    if (row[field] !== undefined) body[field] = row[field];
  }
  if (row.parentCompany) {
    const parent = await lists.readForWrite(row.parentCompany, lists.KINDS.ORGANIZATION);
    body.parentCompany = parent && parent.eagleId ? String(parent.eagleId) : null;
  }
  return body;
}

/** PUT the row's fields; false when Eagle has no organization under the id. */
async function put(s, eagleId, body, logFields) {
  const path = pathOf(eagleId);
  const res = await call(s, 'PUT', path, body, logFields);
  if (res.status === 404) return false;
  if (!res.ok) throw failure('PUT', path, res);
  if (res.body === null) {
    // eagle-api's findOneAndUpdate answers an unknown id with 200 and no document.
    logger.warn(`[sync-out eagle] PUT ${path} answered 200 with no organization, read as missing`,
      { ...logFields, eagleId });
    return false;
  }
  return true;
}

async function setPublished(s, eagleId, published, logFields) {
  const path = `${pathOf(eagleId)}/${published ? 'publish' : 'unpublish'}`;
  const res = await call(s, 'PUT', path, null, logFields);
  if (!res.ok) throw failure('PUT', path, res);
}

/** Organizations created in DEMI; one with no Eagle id only once SYNC_OUT_EAGLE_NATIVE_ENABLED is on. */
const owned = row => Boolean(row && row.sourceSystem === NATIVE && row.isDeleted !== true && isScanCleared(row));
const wants = row => owned(row) && Boolean(row.eagleId || settings.eagle.nativeEnabled);

/** Write the row to its Eagle organization, creating it when Eagle has none. `update` is the engine's guarded write. */
async function send(row, { update }) {
  if (!owned(row)) return { status: 'skipped' };
  const s = requireSettings({ milestone: false });
  refuseStray(row);
  const logFields = { rowId: row.id, eagleId: row.eagleId || null, kind: KIND };
  const body = await bodyFor(row);
  const published = isPublic(row.read);

  if (row.eagleId && await put(s, String(row.eagleId), body, logFields)) {
    const eagleRead = row.sources && row.sources.eagle && row.sources.eagle.read;
    if (!Array.isArray(eagleRead) || isPublic(eagleRead) !== published) {
      await setPublished(s, String(row.eagleId), published, logFields);
    }
    return { status: 'sent', eagleId: String(row.eagleId) };
  }
  // Held, not skipped: a skip records the version as sent, so the row would never go once the switch is on.
  if (!settings.eagle.nativeEnabled) return { status: 'held' };

  return createMinted(s, row, body, update, logFields, {
    kind: KIND,
    path: '/organization',
    noun: 'organization',
    put: (eagleId, fields) => put(s, eagleId, body, fields),
    unknownId: () => ({ line: 'Eagle stored the organization under an unknown id; find it by name', fields: { name: body.name } }),
    // The mirror reads by id first, so a row already stored under the id would take every echo for good.
    heldByMirror: mirroredAsEagleRow,
    twinOf: mirroredAsEagleRow,
    // eagle-api's POST publishes every new organization.
    afterCreate: (eagleId, fields) => (published ? null : setPublished(s, eagleId, false, fields))
  });
}

async function mirroredAsEagleRow(eagleId, row) {
  const stored = await lists.readForWrite(eagleId, lists.KINDS.ORGANIZATION);
  return Boolean(stored && stored.id !== row.id && stored.sourceSystem === 'eagle');
}

module.exports = {
  name: NAME,
  enabled: () => settings.eagle.enabled && settings.eagle.organizationEnabled,
  enableSettings: Object.freeze(['SYNC_OUT_EAGLE_ENABLED', 'SYNC_OUT_EAGLE_ORGANIZATION_ENABLED']),
  wants,
  inFlight: entry => Boolean(claimHeld(entry, Date.now())),
  send,
  bodyFor
};
