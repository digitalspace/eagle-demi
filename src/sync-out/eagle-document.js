'use strict';

// Sync-out consumer: DEMI document rows that already hold an Eagle id, written back through
// eagle-api's document PUT and publish/unpublish. It never creates an Eagle document.

const crypto = require('node:crypto');
const settings = require('../config').syncOut;
const { logger } = require('../utils/logger');
const { isScanCleared } = require('../repositories/documents');
const { ownedOutsideEagle } = require('../ownership/document');
const {
  requireSettings, call, failure, claimHeld, refreshClaim, endClaim
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

/**
 * Only a row DEMI owns that is tied to an Eagle id Eagle has not deleted. send() asks too:
 * queued messages and retries reach it without wants().
 */
const wants = row => Boolean(row && row.eagleId && ownedOutsideEagle(row) && isScanCleared(row) &&
  row.syncOut?.eagle?.eagleDeleted !== true);

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

const noDocument = row => new Error(`Eagle has no document ${row.eagleId} stored on row ${row.id}`);

/** Whether Eagle's copy is public now; asked only before a row's first send records the level. */
async function eaglePublished(s, row, logFields) {
  const path = `/document/${encodeURIComponent(row.eagleId)}`;
  const res = await call(s, 'GET', path, null, logFields);
  if (!res.ok) throw failure('GET', path, res);
  const [doc] = Array.isArray(res.body) ? res.body : [];
  if (!doc) throw noDocument(row);
  return Array.isArray(doc.read) && doc.read.includes('public');
}

async function put(s, row, logFields) {
  const path = `/document/${encodeURIComponent(row.eagleId)}`;
  const res = await call(s, 'PUT', path, bodyFor(row), logFields);
  if (res.status === 404) throw noDocument(row);
  if (!res.ok) throw failure('PUT', path, res);
}

async function setPublished(s, row, published, logFields) {
  const path = `/document/${encodeURIComponent(row.eagleId)}/${published ? 'publish' : 'unpublish'}`;
  const res = await call(s, 'PUT', path, null, logFields);
  if (!res.ok) throw failure('PUT', path, res);
}

/** Write the row's fields and level to its Eagle document. `update` is the engine's etag-guarded write of this row. */
async function send(row, { update }) {
  if (!wants(row)) return { status: 'skipped' };
  const s = requireSettings({ milestone: false });
  const eagleId = String(row.eagleId);
  const published = Array.isArray(row.read) && row.read.includes('public');
  const logFields = { rowId: row.id, eagleId, kind: 'document' };

  const claimed = await claimSend(row, update);
  if (claimed.missing) return { status: 'skipped' };
  const { claim } = claimed;
  let changed;
  try {
    const eagleRead = row.sources?.eagle?.read;
    let before;
    if (Array.isArray(eagleRead)) before = eagleRead.includes('public');
    else if (typeof claimed.published === 'boolean') before = claimed.published;
    else before = await eaglePublished(s, row, logFields);
    changed = published !== before;
    await put(s, row, logFields);
    // A PUT slower than the lease may have lost the claim; the new holder sends the newer state.
    await refreshClaim(row, update, claim);
    // eagle-api's unpublish marks the document Rejected, so it is called only when the level moved.
    if (changed) await setPublished(s, row, published, logFields);
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
  wants,
  inFlight: entry => Boolean(claimHeld(entry, Date.now())),
  send,
  bodyFor
};
