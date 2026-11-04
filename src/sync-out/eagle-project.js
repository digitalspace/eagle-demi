'use strict';

// Sync-out consumer: DEMI-created (`isNativeProject`) and taken-over (`isDemiOwnedProject`) projects, PUT through
// eagle-api. Only a DEMI-created one is POSTed, under a minted id, once SYNC_OUT_EAGLE_NATIVE_ENABLED is on.

const settings = require('../config').syncOut;
const projects = require('../repositories/projects');
const {
  isNativeProject, isDemiOwnedProject, eagleOnlyProjectId, isMintedNative: mintedHere
} = require('../merge/project');
const { logger } = require('../utils/logger');
const {
  requireSettings, call, failure, claimHeld, createMinted, refuseStray, setPublished, syncLevel, isPublic
} = require('./eagle');
const { organizationEagleId } = require('./eagle-organization');

const NAME = 'eagle';
const KIND = 'project';

/** DEMI field to the eagle-api field its PUT writes, where the names differ. */
const RENAMED = Object.freeze({ projectType: 'type', abbreviation: 'shortName', address: 'location' });
/** Fields eagle-api's PUT writes under the same name, as stored. */
const SAME_NAME = Object.freeze([
  'name', 'description', 'eaStatus', 'eaStatusDate', 'decisionDate', 'CEAALink', 'build',
  'sector', 'commodity', 'region', 'substantially', 'substantiallyDate', 'intake', 'dispute', 'disputeDate'
]);
/** ObjectId fields in eagle-api's model that DEMI may hold as `{ _id, name }` refs: sent as the bare id or null. */
const REFS = Object.freeze(['currentPhaseName', 'eacDecision', 'CEAAInvolvement', 'projectLeadId', 'responsibleEPDId']);
// Not eagle-mirror's refId: a stored `{ _id: null, name: null }` would come out as "[object Object]".
const bareId = (ref) => {
  const id = ref && typeof ref === 'object' ? ref._id : ref;
  return id ? String(id) : null;
};

const pathOf = eagleId => `/project/${encodeURIComponent(eagleId)}`;

const takenOver = row => isDemiOwnedProject(row) && Boolean(row.eagleId);

/** The block eagle-api's PUT rewrites: the current `legislation_<year>` of Eagle's copy, else its flat fields. */
function eagleBlockOf(row) {
  const eagle = (row.sources && row.sources.eagle) || {};
  const block = eagle[eagle.currentLegislationYear];
  return block && typeof block === 'object' ? block : eagle;
}

// eagle-api stores `intake.investmentNotes` but its PUT reads `intake.notes`, so a round trip would clear the notes.
const putIntake = intake => (intake && typeof intake === 'object'
  ? { investment: intake.investment, notes: intake.investmentNotes }
  : intake);

async function bodyFor(row, logFields) {
  // eagle-api's PUT clears every field the body leaves out, so a taken-over row sends Eagle's value where it has none.
  const eagle = takenOver(row) ? eagleBlockOf(row) : {};
  const pick = (field, eagleField = field) => (row[field] !== undefined ? row[field] : eagle[eagleField]);
  const body = {};
  for (const field of SAME_NAME) {
    const value = pick(field);
    if (value !== undefined) body[field] = value;
  }
  if (body.intake !== undefined) body.intake = putIntake(body.intake);
  for (const [field, eagleField] of Object.entries(RENAMED)) {
    const value = pick(field, eagleField);
    if (value !== undefined) body[eagleField] = value;
  }
  for (const field of REFS) {
    const value = pick(field);
    if (value !== undefined) body[field] = bareId(value);
  }
  if (row.centroid && Array.isArray(row.centroid.coordinates)) body.centroid = row.centroid.coordinates;
  else if (row.centroid === undefined && Array.isArray(eagle.centroid)) body.centroid = eagle.centroid;
  // eagle-api refuses a project without a proponent, so a row whose proponent Eagle lacks sends nothing.
  body.proponent = await organizationEagleId(row.proponentId,
    `proponent ${row.proponentId ?? 'none'} of project ${row.id}`, logFields);
  return body;
}

/** PUT the row's fields; false when Eagle has no project under the id. */
async function put(s, eagleId, body, logFields) {
  const path = pathOf(eagleId);
  const res = await call(s, 'PUT', path, body, logFields);
  if (res.status === 404) return false;
  if (!res.ok) throw failure('PUT', path, res);
  return true;
}

const owned = row => (isNativeProject(row) || takenOver(row)) && row.isDeleted !== true;
const wants = row => owned(row) && (row.eagleId ? mintedHere(row) || takenOver(row) : settings.eagle.nativeEnabled);

/** Write the row to its Eagle project, creating one only for a row sync-out minted. `update` is the engine's guarded write. */
async function send(row, { update }) {
  if (!owned(row)) return { status: 'skipped' };
  const logFields = { rowId: row.id, eagleId: row.eagleId || null, kind: KIND };
  if (row.eagleId && !mintedHere(row) && !takenOver(row)) {
    logger.warn(`[sync-out eagle] project ${row.id} holds Eagle id ${row.eagleId}, which sync-out did not create; not sent`,
      logFields);
    return { status: 'skipped' };
  }
  const s = requireSettings({ milestone: false });
  refuseStray(row);
  // Held, not skipped: a skip records the version as sent, so the row would never go once the switch is on.
  if (!row.eagleId && !settings.eagle.nativeEnabled) return { status: 'held' };
  const body = await bodyFor(row, logFields);
  if (takenOver(row)) logger.info('[sync-out eagle] sending DEMI-owned Eagle project', logFields);

  if (row.eagleId && await put(s, String(row.eagleId), body, logFields)) {
    await syncLevel(s, pathOf(row.eagleId), row, logFields);
    return { status: 'sent', eagleId: String(row.eagleId) };
  }
  if (!settings.eagle.nativeEnabled) return { status: 'held' };

  return createMinted(s, row, body, update, logFields, {
    kind: KIND,
    path: '/project',
    noun: 'project',
    put: (eagleId, fields) => put(s, eagleId, body, fields),
    // A PUT naming a year whose block the Eagle project lacks answers 404, so the year rides the create only.
    ...(row.legislationYear !== undefined ? { postOnly: { legislationYear: row.legislationYear } } : {}),
    // A taken-over project holds the id Eagle made, so a PUT miss ends as a skip, never a POST.
    mintedOnly: true,
    mirrorRowId: eagleOnlyProjectId,
    unknownId: () => ({ line: 'Eagle stored the project under an unknown id; find it by name', fields: { name: body.name } }),
    twinOf: async (eagleId) => Boolean(await projects.readForWrite(eagleOnlyProjectId(eagleId))),
    // eagle-api's POST stores every new project staff-only, and its echo narrows the DEMI row to match.
    ...(isPublic(row.read) ? { afterCreate: (eagleId, fields) => setPublished(s, pathOf(eagleId), true, fields) } : {})
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
