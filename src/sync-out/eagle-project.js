'use strict';

// Sync-out consumer: projects created in DEMI (`isNativeProject`), written into Eagle through eagle-api. A row
// with an `eagleId` is PUT; one Eagle lacks is POSTed under a minted id once SYNC_OUT_EAGLE_NATIVE_ENABLED is on.

const settings = require('../config').syncOut;
const lists = require('../repositories/lists');
const documents = require('../repositories/documents');
// Read per call, not destructured: the controller's require tree reaches sync-out again.
const projectMirror = require('../controllers/nosql/project');
const { logger } = require('../utils/logger');
const {
  requireSettings, call, failure, claimHeld, createMinted, refuseStray
} = require('./eagle');

const NAME = 'eagle';
const KIND = 'project';

/** DEMI field to the eagle-api field its PUT writes, where the names differ. */
const RENAMED = Object.freeze({ projectType: 'type', abbreviation: 'shortName', address: 'location' });
/** Fields eagle-api's PUT writes under the same name. */
const SAME_NAME = Object.freeze([
  'name', 'description', 'eaStatus', 'eaStatusDate', 'eacDecision', 'decisionDate', 'currentPhaseName',
  'legislationYear', 'CEAAInvolvement', 'CEAALink', 'build', 'sector', 'commodity', 'region', 'substantially',
  'substantiallyDate', 'projectLeadId', 'responsibleEPDId', 'intake', 'dispute', 'disputeDate'
]);

/** The proponent's Eagle id; throws when it has none, since eagle-api refuses a project without one. */
async function proponentEagleId(row, logFields) {
  const org = row.proponentId ? await lists.readForWrite(row.proponentId, lists.KINDS.ORGANIZATION) : null;
  if (org && org.eagleId) return String(org.eagleId);
  logger.error(`[sync-out eagle] proponent ${row.proponentId ?? 'none'} of project ${row.id} has no eagleId, nothing sent`,
    { ...logFields, proponentId: row.proponentId ?? null });
  throw new Error(`proponent ${row.proponentId ?? 'none'} of project ${row.id} has no eagleId`);
}

/** Featured document ids as Eagle ids; a document Eagle does not hold yet is left out. */
async function featuredEagleIds(row) {
  const ids = Array.isArray(row.featuredDocuments) ? row.featuredDocuments : [];
  const docs = await Promise.all(ids.map(id => documents.readForWrite(String(id), row.id)));
  return [...new Set(docs.filter(doc => doc && doc.eagleId).map(doc => String(doc.eagleId)))];
}

async function bodyFor(row, logFields) {
  const body = {};
  for (const field of SAME_NAME) {
    if (row[field] !== undefined) body[field] = row[field];
  }
  for (const [field, eagleField] of Object.entries(RENAMED)) {
    if (row[field] !== undefined) body[eagleField] = row[field];
  }
  if (row.centroid && Array.isArray(row.centroid.coordinates)) body.centroid = row.centroid.coordinates;
  body.proponent = await proponentEagleId(row, logFields);
  body.featuredDocuments = await featuredEagleIds(row);
  return body;
}

/** PUT the row's fields; false when Eagle has no project under the id. */
async function put(s, eagleId, body, logFields) {
  const path = `/project/${encodeURIComponent(eagleId)}`;
  const res = await call(s, 'PUT', path, body, logFields);
  if (res.status === 404) return false;
  if (!res.ok) throw failure('PUT', path, res);
  return true;
}

const owned = row => projectMirror.isNativeProject(row) && row.isDeleted !== true;
const wants = row => owned(row) && Boolean(row.eagleId || settings.eagle.nativeEnabled);

/** Write the row to its Eagle project, creating it when Eagle has none. `update` is the engine's guarded write. */
async function send(row, { update }) {
  if (!owned(row)) return { status: 'skipped' };
  const s = requireSettings({ milestone: false });
  refuseStray(row);
  const logFields = { rowId: row.id, eagleId: row.eagleId || null, kind: KIND };
  const body = await bodyFor(row, logFields);

  if (row.eagleId && await put(s, String(row.eagleId), body, logFields)) {
    return { status: 'sent', eagleId: String(row.eagleId) };
  }
  // Held, not skipped: a skip records the version as sent, so the row would never go once the switch is on.
  if (!settings.eagle.nativeEnabled) return { status: 'held' };

  return createMinted(s, row, body, update, logFields, {
    kind: KIND,
    path: '/project',
    noun: 'project',
    put: (eagleId, fields) => put(s, eagleId, body, fields),
    unknownId: () => ({ line: 'Eagle stored the project under an unknown id; find it by name', fields: { name: body.name } })
  });
}

module.exports = {
  name: NAME,
  enabled: () => settings.eagle.enabled && settings.eagle.projectEnabled,
  enableSettings: Object.freeze(['SYNC_OUT_EAGLE_ENABLED', 'SYNC_OUT_EAGLE_PROJECT_ENABLED']),
  wants,
  inFlight: entry => Boolean(claimHeld(entry, Date.now())),
  send,
  bodyFor
};
