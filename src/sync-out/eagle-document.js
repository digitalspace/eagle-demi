'use strict';

// Sync-out consumer: DEMI document rows, written to Eagle through eagle-api. A row with no Eagle id is
// created under a minted id once SYNC_OUT_EAGLE_NATIVE_ENABLED is on, pointing at DEMI's stored object.

const crypto = require('node:crypto');
const path = require('node:path');
const settings = require('../config').syncOut;
const { logger } = require('../utils/logger');
const documents = require('../repositories/documents');
const projects = require('../repositories/projects');
const { ownedOutsideEagle } = require('../ownership/document');
const { isNativeProject, isMintedNative } = require('../merge/project');
const { resolveObjectKey } = require('../storage/objectKey');
const { DOCUMENT } = require('./kinds');
const {
  requireSettings, call, failure, claimHeld, refreshClaim, endClaim, createMinted, refuseStray, setPublished, isPublic
} = require('./eagle');

const NAME = 'eagle';

/** DEMI row field to the eagle-api PUT field it fills. `eaoStatus` is left out: it moves `read`. */
const PUT_FIELDS = Object.freeze({
  displayName: 'displayName',
  description: 'description',
  typeId: 'type',
  milestoneId: 'milestone',
  projectPhaseId: 'projectPhase',
  documentAuthorTypeId: 'documentAuthorType',
  datePosted: 'datePosted',
  dateUploaded: 'dateUploaded',
  legislation: 'legislation',
  sortOrder: 'sortOrder'
});

/** eagle-api's document PUT body. Visibility rides only on publish or unpublish, never here. */
function bodyFor(row) {
  const body = {};
  for (const [field, eagleField] of Object.entries(PUT_FIELDS)) {
    if (row[field] !== undefined && row[field] !== null) body[eagleField] = row[field];
  }
  return body;
}

/**
 * Fields cleared in DEMI that eagle-api's PUT skips, as it skips every falsy value, so Eagle keeps
 * its old one. Named only against Eagle's raw copy: without one, a never-set field is not a dropped clear.
 */
function unsendable(row) {
  const copy = row.sources && row.sources.eagle;
  if (!copy) return [];
  return Object.entries(PUT_FIELDS)
    .filter(([field, eagleField]) => Object.hasOwn(row, field) && !row[field] && Boolean(copy[eagleField]))
    .map(([field]) => field);
}

const owned = row => Boolean(row && ownedOutsideEagle(row) && documents.isScanCleared(row) &&
  row.syncOut?.eagle?.eagleDeleted !== true);

/** No Eagle id, or a minted one whose create never recorded a send: Eagle may hold nothing under it. */
const needsCreate = row => !row.eagleId || (isMintedNative(row) && !Number.isInteger(row.syncOut?.eagle?.sentVersion));

/** A row DEMI owns that Eagle has not deleted; a row Eagle may not hold yet is wanted only while the native switch is on. */
const wants = row => owned(row) && (!needsCreate(row) || settings.eagle.nativeEnabled);

/**
 * Take the row's send claim: `{ claim, published }` with the level last sent, `{ missing: true }`,
 * or throws while another delivery holds one.
 */
async function claimSend(row, update) {
  const claim = crypto.randomUUID();
  let held = false;
  let published;
  const result = await update((current) => {
    const entry = current.syncOut && current.syncOut[NAME];
    held = claimHeld(entry, Date.now());
    if (held) return null;
    published = entry && entry.published;
    // `creating` is the only status claimHeld and the engine's inFlight treat as a live claim.
    return {
      ...current,
      syncOut: { ...current.syncOut, [NAME]: { ...entry, status: 'creating', claim, claimedAt: new Date().toISOString() } }
    };
  });
  if (result.status === 'missing') return { missing: true };
  if (held) throw new Error(`another delivery is sending document ${row.id} to Eagle`);
  return { claim, published };
}

const noDocument = (row, eagleId = row.eagleId) => new Error(`Eagle has no document ${eagleId} stored on row ${row.id}`);

/** Whether Eagle's copy is public now; asked only when neither an echo nor a send has shown the level. */
async function eaglePublished(s, row, eagleId, logFields) {
  const target = pathOf(eagleId);
  const res = await call(s, 'GET', target, null, logFields);
  if (!res.ok) throw failure('GET', target, res);
  const [doc] = Array.isArray(res.body) ? res.body : [];
  if (!doc) throw noDocument(row, eagleId);
  return isPublic(doc.read);
}

const pathOf = eagleId => `/document/${encodeURIComponent(eagleId)}`;

/** PUT the row's fields; false when Eagle has no document under the id. */
async function put(s, eagleId, row, logFields) {
  const target = pathOf(eagleId);
  const res = await call(s, 'PUT', target, bodyFor(row), logFields);
  if (res.status === 404) return false;
  if (!res.ok) throw failure('PUT', target, res);
  return true;
}

const internalExtOf = row => String(row.fileExt || path.posix.extname(row.s3Key || '')).replace(/^\./, '').toLowerCase();

/** The create body for `/document/stored`. eagle-api's download needs both the file name and the type. */
const storedBodyFor = (row, project) => ({
  ...bodyFor(row),
  project,
  internalURL: resolveObjectKey(row.s3Key),
  documentFileName: row.displayName || path.posix.basename(row.s3Key),
  internalExt: internalExtOf(row),
  passedAVCheck: row.scanStatus === 'clean'
});

/**
 * The parent's Eagle id, once Eagle holds the parent. A missing parent, or a native one whose create has
 * not landed, is waited for; any other parent without an Eagle id never reaches Eagle through sync-out.
 */
async function readyParentEagleId(row, logFields) {
  const fields = { ...logFields, parentId: row.projectId };
  const parent = await projects.readForWrite(row.projectId);
  const out = parent?.syncOut?.eagle;
  if (parent && !parent.eagleId && !isNativeProject(parent)) {
    logger.error(`[sync-out eagle] project ${row.projectId} of row ${row.id} has no eagleId, nothing sent`, fields);
    throw new Error(`project ${row.projectId} of row ${row.id} has no eagleId`);
  }
  if (!parent || !parent.eagleId || (out?.mintedId === String(parent.eagleId) && !Number.isInteger(out.sentVersion))) {
    logger.warn(`[sync-out eagle] parent project ${row.projectId} not yet in Eagle; document ${row.id} waits`, fields);
    throw new Error(`parent project ${row.projectId} of document ${row.id} not yet in Eagle`);
  }
  return String(parent.eagleId);
}

/** Move a just-created record to the row's level, from the echo's `read`, else Eagle's own answer. */
async function levelAfterCreate(s, row, eagleId, logFields) {
  const stored = await documents.readForWrite(row.id, row.projectId);
  const eagleRead = stored?.sources?.eagle?.read;
  const before = Array.isArray(eagleRead) ? isPublic(eagleRead) : await eaglePublished(s, row, eagleId, logFields);
  const published = isPublic(row.read);
  if (before !== published) await setPublished(s, pathOf(eagleId), published, logFields);
}

/** POST a row Eagle does not hold yet under a minted id; eagle-api points the record at DEMI's stored object. */
async function create(s, row, update) {
  const logFields = { rowId: row.id, eagleId: row.eagleId || null, kind: DOCUMENT };
  // Held, not skipped: a skip records the version as sent, so the row would never go once the switch is on.
  if (!settings.eagle.nativeEnabled) return { status: 'held' };
  refuseStray(row);
  if (!row.s3Key || !internalExtOf(row)) {
    const reason = row.s3Key ? `no file type in fileExt or s3Key ${row.s3Key}` : 'no s3Key';
    logger.error(`[sync-out eagle] document ${row.id} has ${reason}, not created in Eagle`, logFields);
    throw new Error(`document ${row.id} has ${reason}`);
  }
  const body = storedBodyFor(row, await readyParentEagleId(row, logFields));
  return createMinted(s, row, body, update, logFields, {
    kind: DOCUMENT,
    path: '/document/stored',
    noun: 'document',
    put: (eagleId, fields) => put(s, eagleId, row, fields),
    mintedOnly: true,
    unknownId: () => ({
      line: 'Eagle stored the document under an unknown id; find it by project and file name',
      fields: { eagleProjectId: body.project, documentFileName: body.documentFileName }
    }),
    twinOf: async eagleId => Boolean(await documents.readForWrite(eagleId, row.projectId)),
    // A new record is staff-only, but after a 409 it holds whatever level an earlier attempt left.
    afterCreate: (eagleId, fields) => levelAfterCreate(s, row, eagleId, fields)
  });
}

/** Write the row's fields and level to its Eagle document. `update` is the engine's etag-guarded write of this row. */
async function send(row, { update }) {
  if (!owned(row)) return { status: 'skipped' };
  const s = requireSettings({ milestone: false });
  if (needsCreate(row)) return create(s, row, update);
  const eagleId = String(row.eagleId);
  const published = isPublic(row.read);
  const logFields = { rowId: row.id, eagleId, kind: DOCUMENT };

  const claimed = await claimSend(row, update);
  if (claimed.missing) return { status: 'skipped' };
  const { claim } = claimed;
  let changed;
  try {
    const eagleRead = row.sources?.eagle?.read;
    let before;
    if (Array.isArray(eagleRead)) before = eagleRead.includes('public');
    else if (typeof claimed.published === 'boolean') before = claimed.published;
    else before = await eaglePublished(s, row, eagleId, logFields);
    changed = published !== before;
    if (!await put(s, eagleId, row, logFields)) throw noDocument(row);
    // A PUT slower than the lease may have lost the claim; the new holder sends the newer state.
    await refreshClaim(row, update, claim);
    // eagle-api's unpublish marks the document Rejected, so it is called only when the level moved.
    if (changed) await setPublished(s, pathOf(eagleId), published, logFields);
    await endClaim(update, claim, 'sent', null, { published });
  } catch (err) {
    logger.error(`[sync-out eagle] document ${row.id} not sent to Eagle ${eagleId}: ${err.message}`,
      { ...logFields, error: err.message });
    await endClaim(update, claim, 'failed').catch(releaseErr => logger.error('[sync-out eagle] claim not released',
      { ...logFields, error: releaseErr.message }));
    throw err;
  }
  const level = changed ? (published ? 'published' : 'unpublished') : 'level unchanged';
  logger.info(`[sync-out eagle] document ${row.id} sent to Eagle ${eagleId}, ${level}`, { ...logFields, published, changed });
  const cleared = unsendable(row);
  if (cleared.length) {
    logger.warn(`[sync-out eagle] document ${row.id}: eagle-api cannot clear ${cleared.join(', ')}, Eagle keeps its old values`,
      { ...logFields, fields: cleared });
  }
  return { status: 'sent', eagleId };
}

module.exports = {
  name: NAME,
  // The flag lives here, not in wants(): a message queued while it is off must stay queued, not be recorded as sent.
  enabled: () => settings.eagle.enabled && settings.eagle.documentEnabled,
  enableSettings: Object.freeze(['SYNC_OUT_EAGLE_ENABLED', 'SYNC_OUT_EAGLE_DOCUMENT_ENABLED']),
  wants,
  inFlight: entry => Boolean(claimHeld(entry, Date.now())),
  send,
  bodyFor
};
