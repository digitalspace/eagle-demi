'use strict';

/**
 * Bulk download jobs — Cosmos NoSQL.
 *
 * Container `bulkDownloads`, partitioned by `/id` where the id IS the job id, so every status poll
 * is a point read in a single partition.
 *
 * NO visibility predicate applies to the JOB rows, and unlike `api-keys.js` that is not because
 * the container is admin-gated — it is because a job row is not application data at all. The job
 * id is the capability (an unguessable UUID) and the controller binds an authenticated job to its
 * requester before answering, so a foreign or unknown id is a 404 either way. Deliberately stated
 * so nobody later "fixes" the missing predicate by wiring this container into an ACL-driven read:
 * a row names the document ids its owner asked for, and the ACL that matters is applied to the
 * DOCUMENTS, by `documents.listByIdsUnscoped` here and again in the worker.
 *
 * The container also holds one QUOTA row per requester, id `quota:<requesterKey>`. It shares the
 * container because the quota is only ever read by id, so it costs a point read and no second
 * container — and because a UUID job id can never collide with a prefixed one.
 */

const cosmos = require('../db/cosmos-nosql');
const documents = require('./documents');

const CONTAINER = 'bulkDownloads';
const PARTITION_FIELD = 'id';

// Every status a job row may carry. A patch condition takes no parameters, so `patchIfStatus`
// interpolates; this is what keeps the interpolated values off the callers' hands.
const STATUSES = ['queued', 'running', 'ready', 'failed', 'expired', 'cancelled'];

// Rolling window for the per-day cap, and how long a quota row outlives its last use. Two days, so
// an in-flight count that leaked (a job whose worker never ran) clears itself.
const WINDOW_MS = 24 * 60 * 60 * 1000;
const QUOTA_TTL_SECONDS = 2 * 24 * 60 * 60;

/** Point read by job id. */
async function getById(id) {
  return cosmos.readItem(CONTAINER, String(id), String(id));
}

/** `create`, not `upsert`: a job id collision is a bug, and a 409 says so. */
async function create(job) {
  return cosmos.create(CONTAINER, job);
}

const setOps = fields => Object.entries(fields).map(([name, value]) => ({
  op: 'set', path: `/${name}`, value
}));

/** Partial update — the worker patches progress onto a row the controller may be reading. */
async function patch(id, fields) {
  return cosmos.patch(CONTAINER, String(id), String(id), setOps(fields));
}

/**
 * Jobs whose zips are past retention: the parts to delete, when the job finished or was created
 * (what is left of its row TTL — a row still `running` has no finish time) and whose slot to give
 * back, if the worker never did.
 *
 * A finished job is only selected while it still names parts, because the sweep empties them: a
 * `cancelled` row keeps its status, so without that clause it matches this query again on the next
 * page and the sweep pages over the same rows forever.
 *
 * `limit` is a page, not a filter: the read takes one page and stops, so a backlog is swept over
 * several nights rather than draining an unbounded result set into one timer invocation.
 */
async function listExpired(cutoffIso, { statuses = ['ready', 'failed'], limit = 500 } = {}) {
  const names = statuses.map((_, i) => `@status${i}`);
  const { items } = await cosmos.query(CONTAINER, {
    query: `SELECT c.id, c.status, c.parts, c.finishedAt, c.createdAt, c.requesterKey, ` +
      `c.slotReleasedAt FROM c ` +
      `WHERE (c.status IN (${names.join(', ')}) AND c.finishedAt < @cutoff ` +
      `AND ARRAY_LENGTH(c.parts) > 0) ` +
      "OR (c.status = 'running' AND c.startedAt < @cutoff)",
    parameters: [
      ...names.map((name, i) => ({ name, value: String(statuses[i]) })),
      { name: '@cutoff', value: String(cutoffIso) }
    ]
  }, { maxItemCount: limit });
  return items;
}

function quotaId(requesterKey) {
  return `quota:${requesterKey}`;
}

/**
 * @returns {Promise<'ok'|'refused'|'missing'>} `refused` is Cosmos rejecting the condition (412),
 * which for these callers means "the counter was at its cap", not an error.
 */
async function conditionalPatch(id, operations, condition) {
  try {
    await cosmos.patch(CONTAINER, id, id, operations, condition);
    return 'ok';
  } catch (err) {
    const status = err && (err.code || err.statusCode);
    if (status === 412) return 'refused';
    if (status === 404) return 'missing';
    throw err;
  }
}

/**
 * Move a job to a terminal status only while it is still in one of `statuses`.
 *
 * A cancel and the worker's own `ready`/`failed` write race each other, and the loser must not
 * overwrite the winner — nor give the requester's in-flight slot back a second time.
 *
 * @returns {Promise<boolean>} false: another writer already took the row out of `statuses`.
 */
async function patchIfStatus(id, fields, statuses) {
  const unknown = statuses.filter(status => !STATUSES.includes(status));
  if (unknown.length > 0) {
    throw new RangeError(`[bulk] not a job status: ${unknown.join(', ')}`);
  }
  const list = statuses.map(status => `'${status}'`).join(', ');
  const outcome = await conditionalPatch(
    String(id), setOps(fields), `FROM c WHERE c.status IN (${list})`
  );
  return outcome === 'ok';
}

/**
 * Take one of this requester's job slots, or refuse.
 *
 * Test-and-set inside Cosmos, not a count followed by a write: two requests arriving together each
 * read the same count and both pass, which is how a "maximum 3 in flight" rule hands out five. The
 * caps are interpolated into the condition because a patch condition takes no parameters — they are
 * whole numbers from config.js, which throws at load on anything else.
 *
 * @returns {Promise<boolean>} false means at a cap; the caller answers 429 and takes no slot.
 */
async function acquireSlot(requesterKey, { maxInFlight, maxPerDay }) {
  const id = quotaId(requesterKey);
  const now = new Date();
  const ttl = { op: 'set', path: '/ttl', value: QUOTA_TTL_SECONDS };

  const take = [
    { op: 'incr', path: '/inFlight', value: 1 },
    { op: 'incr', path: '/windowCount', value: 1 },
    ttl
  ];
  const takeIfUnderCaps =
    `FROM c WHERE c.inFlight < ${Number(maxInFlight)} AND c.windowCount < ${Number(maxPerDay)}`;

  // The same acquisition, for a requester whose 24-hour window has ended: the day counter restarts
  // at this request rather than being reset by a separate write somebody has to schedule.
  const roll = [
    { op: 'set', path: '/windowStart', value: now.toISOString() },
    { op: 'set', path: '/windowCount', value: 1 },
    { op: 'incr', path: '/inFlight', value: 1 },
    ttl
  ];
  const rollIfWindowEnded = `FROM c WHERE c.inFlight < ${Number(maxInFlight)} ` +
    `AND c.windowStart < "${new Date(now.getTime() - WINDOW_MS).toISOString()}"`;

  let outcome = await conditionalPatch(id, take, takeIfUnderCaps);
  if (outcome === 'missing') {
    // create, not upsert: two first requests race here, and an upsert would zero the counter the
    // other one had just incremented. A 409 means the other request won, so the retry is the point.
    await create({ id, inFlight: 0, windowStart: now.toISOString(), windowCount: 0, ttl: QUOTA_TTL_SECONDS })
      .catch((err) => {
        if ((err && (err.code || err.statusCode)) !== 409) throw err;
      });
    outcome = await conditionalPatch(id, take, takeIfUnderCaps);
  }
  if (outcome === 'refused') outcome = await conditionalPatch(id, roll, rollIfWindowEnded);

  return outcome === 'ok';
}

/**
 * Give the slot back — the job finished, failed, or was never queued.
 *
 * The floor is in the condition rather than applied after a read, so a release that arrives twice
 * (a retried queue message) cannot drive the counter negative and hand out a free slot.
 */
async function releaseSlot(requesterKey) {
  const outcome = await conditionalPatch(
    quotaId(requesterKey),
    [{ op: 'incr', path: '/inFlight', value: -1 }],
    'FROM c WHERE c.inFlight > 0'
  );
  return outcome === 'ok';
}

module.exports = {
  CONTAINER,
  PARTITION_FIELD,
  getById,
  create,
  patch,
  patchIfStatus,
  listExpired,
  acquireSlot,
  releaseSlot,
  // The worker and the controller share one document read, and it lives in documents.js because it
  // IS a document read — gated, projected and batched like every other.
  listDocumentsByIds: documents.listByIdsUnscoped
};
