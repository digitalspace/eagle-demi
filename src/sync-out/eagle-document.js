'use strict';

// Sync-out consumer: DEMI and ENGAGE document rows that already hold an Eagle id, written back through
// eagle-api's document PUT and publish/unpublish. It never creates an Eagle document.

const crypto = require('node:crypto');
const settings = require('../config').syncOut;
const { logger } = require('../utils/logger');
const { isScanCleared } = require('../repositories/documents');
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

/** Rows that came from Eagle are Eagle's own; only a row DEMI or ENGAGE owns, tied to an Eagle id, is sent. */
const wants = row => Boolean(row && row.eagleId && row.sourceSystem !== 'eagle' && isScanCleared(row));

/** Take the row's send claim; `{ claim }`, `{ missing: true }`, or throws while another delivery holds one. */
async function claimSend(row, update) {
  const claim = crypto.randomUUID();
  let held = false;
  const result = await update((current) => {
    const entry = current.syncOut && current.syncOut[NAME];
    held = claimHeld(entry, Date.now());
    if (held) return null;
    // `creating` is the only status claimHeld and the engine's inFlight treat as a live claim.
    return {
      ...current,
      syncOut: { ...current.syncOut, [NAME]: { ...entry, status: 'creating', claim, claimedAt: new Date().toISOString() } }
    };
  });
  if (result.status === 'missing') return { missing: true };
  if (held) throw new Error(`another delivery is sending document ${row.id} to Eagle`);
  return { claim };
}

async function put(s, row, logFields) {
  const path = `/document/${encodeURIComponent(row.eagleId)}`;
  const res = await call(s, 'PUT', path, bodyFor(row), logFields);
  if (res.status === 404) throw new Error(`Eagle has no document ${row.eagleId} stored on row ${row.id}`);
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
  const s = requireSettings();
  const eagleId = String(row.eagleId);
  const published = Array.isArray(row.read) && row.read.includes('public');
  const logFields = { rowId: row.id, eagleId, kind: 'document' };

  const claimed = await claimSend(row, update);
  if (claimed.missing) return { status: 'skipped' };
  const { claim } = claimed;
  try {
    await put(s, row, logFields);
    // A PUT slower than the lease may have lost the claim; the new holder sends the newer state.
    await refreshClaim(row, update, claim);
    await setPublished(s, row, published, logFields);
    await endClaim(update, claim, 'sent');
  } catch (err) {
    logger.error(`[sync-out eagle] document ${row.id} not sent to Eagle ${eagleId}: ${err.message}`,
      { ...logFields, error: err.message });
    await endClaim(update, claim, 'failed').catch(releaseErr => logger.error('[sync-out eagle] claim not released',
      { ...logFields, error: releaseErr.message }));
    throw err;
  }
  logger.info(`[sync-out eagle] document ${row.id} sent to Eagle ${eagleId}, ${published ? 'published' : 'unpublished'}`,
    { ...logFields, published });
  return { status: 'sent', eagleId };
}

module.exports = {
  name: NAME,
  enabled: () => settings.eagle.enabled,
  wants,
  inFlight: entry => Boolean(claimHeld(entry, Date.now())),
  send,
  bodyFor
};
