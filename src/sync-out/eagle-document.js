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
  requireSettings, putRecord, call, failure, claimHeld, refreshClaim, endClaim, createMinted, refuseStray, setPublished, isPublic
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

const isDeleted = row => row.isDeleted === true;

/** A row DEMI owns that Eagle has not deleted; a row Eagle may not hold yet only while the native switch is on, and never deleted. */
const wants = row => owned(row) && (!needsCreate(row) || (settings.eagle.nativeEnabled && !isDeleted(row)));

/** The level and feature state Eagle's copy should hold: a deleted row is neither public nor featured. */
const targetOf = row => ({
  published: !isDeleted(row) && isPublic(row.read),
  // DEMI's featured limit counts no deleted row, so Eagle's must not either.
  featured: !isDeleted(row) && row.isFeatured === true
});

/**
 * Take the row's send claim: `{ claim, last }` with the state last sent, `{ missing: true }`,
 * or throws while another delivery holds one.
 */
async function claimSend(row, update) {
  const claim = crypto.randomUUID();
  let held = false;
  let last;
  const result = await update((current) => {
    const entry = current.syncOut && current.syncOut[NAME];
    held = claimHeld(entry, Date.now());
    if (held) return null;
    // Sync-out creates Eagle records unfeatured and records each feature it makes, so a send without one left none.
    if (typeof entry?.published === 'boolean') last = { published: entry.published, featured: entry.featured === true };
    // `creating` is the only status claimHeld and the engine's inFlight treat as a live claim.
    return {
      ...current,
      syncOut: { ...current.syncOut, [NAME]: { ...entry, status: 'creating', claim, claimedAt: new Date().toISOString() } }
    };
  });
  if (result.status === 'missing') return { missing: true };
  if (held) throw new Error(`another delivery is sending document ${row.id} to Eagle`);
  return { claim, last };
}

const noDocument = (row, eagleId = row.eagleId) => new Error(`Eagle has no document ${eagleId} stored on row ${row.id}`);

const pathOf = eagleId => `/document/${encodeURIComponent(eagleId)}`;

/** Eagle's copy as `{ published, featured }`, from the echo's raw copy, else `last` sent, else one GET. */
async function eagleState(s, row, eagleId, stored, last, logFields) {
  const copy = stored?.sources?.eagle;
  // eagle-api's push carries the whole saved record, where `isFeatured` defaults to false.
  if (copy && Array.isArray(copy.read)) return { published: isPublic(copy.read), featured: copy.isFeatured === true };
  if (last) return last;
  const target = `${pathOf(eagleId)}?fields=isFeatured`;
  const res = await call(s, 'GET', target, null, logFields);
  if (!res.ok) throw failure('GET', target, res);
  const [doc] = Array.isArray(res.body) ? res.body : [];
  if (!doc) throw noDocument(row, eagleId);
  return { published: isPublic(doc.read), featured: doc.isFeatured === true };
}

/** Feature or unfeature Eagle's copy. eagle-api answers 403 when its project already holds its featured limit. */
async function setFeatured(s, eagleId, featured, logFields) {
  const target = `${pathOf(eagleId)}/${featured ? 'feature' : 'unfeature'}`;
  const res = await call(s, 'PUT', target, null, logFields);
  if (featured && res.status === 403) {
    const limit = res.body?.limit;
    logger.error(`[sync-out eagle] Eagle did not feature document ${eagleId}: its project holds eagle-api's limit` +
      `${limit === undefined ? '' : ` of ${limit}`} featured documents`, { ...logFields, limit });
  }
  if (!res.ok) throw failure('PUT', target, res);
}

/** The state a send left, for the claim record. Unfeatured reads as absent, so false is written only over a true. */
const sentState = (target, last) =>
  ({ published: target.published, ...(target.featured || last?.featured ? { featured: target.featured } : {}) });

/** Move Eagle's level, then its feature state, to `target` where `before` differs. */
async function moveState(s, eagleId, before, target, logFields) {
  // eagle-api's unpublish marks the document Rejected, so it is called only when the level moved.
  if (before.published !== target.published) await setPublished(s, pathOf(eagleId), target.published, logFields);
  // Asked again, eagle-api counts the document itself against the limit and answers 403.
  if (before.featured !== target.featured) await setFeatured(s, eagleId, target.featured, logFields);
}

/** PUT the row's fields; false when Eagle has no document under the id. */
const put = async (s, eagleId, row, logFields) => putRecord(s, pathOf(eagleId), bodyFor(row), logFields);

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

/** Move a just-created record to the row's level and feature state, from the echo, else Eagle's own answer. */
async function stateAfterCreate(s, row, eagleId, logFields) {
  const stored = await documents.readForWrite(row.id, row.projectId);
  await moveState(s, eagleId, await eagleState(s, row, eagleId, stored, null, logFields), targetOf(row), logFields);
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
    afterCreate: (eagleId, fields) => stateAfterCreate(s, row, eagleId, fields)
  });
}

/** Write the row's fields and level to its Eagle document. `update` is the engine's etag-guarded write of this row. */
async function send(row, { update }) {
  if (!owned(row)) return { status: 'skipped' };
  const s = requireSettings({ milestone: false });
  if (needsCreate(row)) return isDeleted(row) ? { status: 'skipped' } : create(s, row, update);
  const eagleId = String(row.eagleId);
  const target = targetOf(row);
  const { published } = target;
  const logFields = { rowId: row.id, eagleId, kind: DOCUMENT };

  const claimed = await claimSend(row, update);
  if (claimed.missing) return { status: 'skipped' };
  const { claim } = claimed;
  let changed;
  try {
    const before = await eagleState(s, row, eagleId, row, claimed.last, logFields);
    changed = published !== before.published;
    if (!await put(s, eagleId, row, logFields)) throw noDocument(row);
    // A PUT slower than the lease may have lost the claim; the new holder sends the newer state.
    await refreshClaim(row, update, claim);
    await moveState(s, eagleId, before, target, logFields);
    await endClaim(update, claim, 'sent', null, sentState(target, claimed.last));
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
