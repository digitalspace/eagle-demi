'use strict';

// Sync-out consumer: comments created in DEMI, written into Eagle through eagle-api. A row with an `eagleId` is
// PUT; one Eagle lacks is POSTed under a minted id once SYNC_OUT_EAGLE_NATIVE_ENABLED is on.

const settings = require('../config').syncOut;
const comments = require('../repositories/comments');
const { EAGLE_OBJECT_ID } = require('../repositories/projects');
const commentPeriods = require('../repositories/comment-periods');
const documents = require('../repositories/documents');
const { logger } = require('../utils/logger');
const {
  requireSettings, call, failure, missingOnPut, claimHeld, createMinted, refuseStray, refsFor, mirrorRowUnder
} = require('./eagle');

const NAME = 'eagle';
const KIND = 'comment';
const NATIVE = 'demi';
const ROUTE = '/comment';

/**
 * The fields eagle-api's POST and PUT copy, as DEMI stores them. The PUT takes only the review fields and sets the
 * read from `eaoStatus` as the status route does, so a status change needs no second call.
 */
const FIELDS = Object.freeze([
  'author', 'comment', 'dateAdded', 'datePosted', 'eaoNotes', 'eaoStatus', 'isAnonymous', 'location', 'proponentNotes',
  'proponentStatus', 'publishedNotes', 'rejectedNotes', 'rejectedReason', 'submittedCAC', 'valuedComponents'
]);

const pathOf = eagleId => `${ROUTE}/${encodeURIComponent(eagleId)}`;

/** eagle-api's comment body, the period and documents as Eagle ids, and the records not in Eagle yet. */
async function bodyFor(row, logFields) {
  const body = {};
  for (const field of FIELDS) {
    if (row[field] !== undefined) body[field] = row[field];
  }
  const { ref, refuse, waiting } = refsFor(KIND, row, logFields);
  // With no status eagle-api keeps its default read, and no moderation list shows the comment.
  body.eaoStatus = row.eaoStatus ?? 'Pending';
  // eagle-api's POST answers a non-ObjectId with 400 and saves the comment anyway.
  for (const vc of body.valuedComponents || []) {
    if (!EAGLE_OBJECT_ID.test(String(vc))) refuse(`valued component ${vc} is not an Eagle id`);
  }
  body.period = ref('comment period', row.periodId,
    await commentPeriods.readForWrite(row.periodId, row.projectId));
  const ids = Array.isArray(row.documents) ? row.documents : [];
  const stored = new Map((await documents.listSyncRefs(ids)).map(doc => [String(doc.id), doc]));
  body.documents = ids.map(id => ref('document', id, stored.get(String(id))));
  return { body, waiting: waiting() };
}

/** PUT the row's fields; false when Eagle has no comment under the id. */
async function put(s, eagleId, body, logFields) {
  const path = pathOf(eagleId);
  const res = await call(s, 'PUT', path, body, logFields);
  if (missingOnPut(res)) return false;
  if (!res.ok) throw failure('PUT', path, res);
  return true;
}

const owned = row => Boolean(row && row.sourceSystem === NATIVE);
const wants = row => owned(row) && Boolean(row.eagleId || settings.eagle.nativeEnabled);

/** Write the row to its Eagle comment, creating it when Eagle has none. `update` is the engine's guarded write. */
async function send(row, { update }) {
  if (!owned(row)) return { status: 'skipped' };
  const s = requireSettings({ milestone: false });
  refuseStray(row);
  const logFields = { rowId: row.id, eagleId: row.eagleId || null, kind: KIND };
  // Held, not skipped: a skip records the version as sent, so the row would never go once the switch is on.
  if (!row.eagleId && !settings.eagle.nativeEnabled) return { status: 'held' };
  const { body, waiting } = await bodyFor(row, logFields);
  if (waiting.length) {
    // The engine queues the row again when that period or document's own send lands (index.js, queueHeldOn).
    logger.warn(`[sync-out eagle] comment ${row.id} held: ${waiting.join('; ')}`, { ...logFields, waiting });
    return { status: 'held' };
  }

  if (row.eagleId && await put(s, String(row.eagleId), body, logFields)) {
    return { status: 'sent', eagleId: String(row.eagleId) };
  }
  if (!settings.eagle.nativeEnabled) return { status: 'held' };

  return createMinted(s, row, body, update, logFields, {
    kind: KIND,
    path: ROUTE,
    noun: 'comment',
    put: (eagleId, fields) => put(s, eagleId, body, fields),
    unknownId: () => ({
      line: 'Eagle stored the comment under an unknown id; find it by period and text', fields: { period: body.period }
    }),
    // eagle-api's POST does not copy `submittedCAC`.
    ...(row.submittedCAC === true ? { afterCreate: (eagleId, fields) => put(s, eagleId, body, fields) } : {}),
    // The mirror reads by id first, so a row already stored under the id would take every echo for good.
    heldByMirror: mirroredAsEagleRow,
    twinOf: mirroredAsEagleRow
  });
}

const mirroredAsEagleRow = mirrorRowUnder(eagleId => comments.readForWrite(eagleId));

module.exports = {
  name: NAME,
  enabled: () => settings.eagle.enabled && settings.eagle.commentEnabled,
  enableSettings: Object.freeze(['SYNC_OUT_EAGLE_ENABLED', 'SYNC_OUT_EAGLE_COMMENT_ENABLED']),
  wants,
  inFlight: entry => Boolean(claimHeld(entry, Date.now())),
  send
};
