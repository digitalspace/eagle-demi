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
 *
 * Search-definition jobs (`searchdef:<uuid>`, src/jobs/search-definitions.js) share it on the same
 * terms: point reads by id, a prefix no UUID can collide with, and their own controller. Only
 * `listExpired` sees more than one row at a time, and it names the fields that tell them apart.
 */

const cosmos = require('../db/cosmos-nosql');
const documents = require('./documents');

const CONTAINER = 'bulkDownloads';
const PARTITION_FIELD = 'id';

// Job ids are UUIDs a controller minted. Anything else is not a job that ever existed — and the
// container also holds `quota:<requester>` and `searchdef:<uuid>` rows, which no request may reach
// by bare id. Shared by both controllers so one id shape is enforced in one place.
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The id prefix and the `kind` field that tell a search-definition row from a zip row. They live
// here, with the container, because both workers and both controllers have to agree on them and a
// second copy of either string is a way for the two kinds to start reaching each other's rows.
const SEARCH_DEF_PREFIX = 'searchdef:';
const SEARCH_DEF_KIND = 'searchDefinitions';

// What `queued` and `running` mean for a search-definition job: the run is not over, so a second
// apply must not start. Every other status in STATUSES is terminal for that kind.
const ACTIVE_STATUSES = ['queued', 'running'];

// Every status a job row in this container may carry — a zip job's (`ready`, `cancelled`) and a
// search-definition job's (`succeeded`, `warned`) alike, because both kinds are patched through
// `patchIfStatus`. A patch condition takes no parameters, so `patchIfStatus` interpolates; this
// list is what keeps the interpolated values off the callers' hands.
const STATUSES = [
  'queued', 'running', 'ready', 'succeeded', 'warned', 'failed', 'expired', 'cancelled'
];

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
 * Selected only while it still names parts, because the sweep empties them: a `cancelled` row
 * keeps its status, so without that clause the sweep pages over the same rows forever.
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
      // IS_DEFINED(c.documentIds) because the container also holds the search-definition job rows
      // (`searchdef:` ids, src/jobs/search-definitions.js), and one of those still 'running' past
      // the cutoff is not a dead zip: the sweep would stamp it `expired` and take its status away.
      // The first clause needs no such guard — those rows carry no `parts`.
      "OR (c.status = 'running' AND c.startedAt < @cutoff AND IS_DEFINED(c.documentIds))",
    parameters: [
      ...names.map((name, i) => ({ name, value: String(statuses[i]) })),
      { name: '@cutoff', value: String(cutoffIso) }
    ]
  }, { maxItemCount: limit });
  return items;
}

/**
 * The search-definition jobs that are still going.
 *
 * A prefix match on the id, which is also the partition key, so this reads the container's own
 * index rather than scanning rows. `limit` is a page: the caller only needs to know whether there
 * is one, so there is no reason to drain the set.
 *
 * `startedAt` comes back with the row because `running` alone does not say a run is in flight: a
 * worker the host killed leaves that status behind for the rest of the row's TTL. The caller dates
 * the row against the worker's own wait ceiling (src/jobs/search-definitions.js).
 */
async function listActiveSearchDefinitionJobs({ limit = 10 } = {}) {
  const names = ACTIVE_STATUSES.map((_, i) => `@status${i}`);
  const { items } = await cosmos.query(CONTAINER, {
    query: `SELECT c.id, c.status, c.createdAt, c.startedAt FROM c ` +
      `WHERE STARTSWITH(c.id, @prefix) AND c.status IN (${names.join(', ')})`,
    parameters: [
      { name: '@prefix', value: SEARCH_DEF_PREFIX },
      ...names.map((name, i) => ({ name, value: ACTIVE_STATUSES[i] }))
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
 * Move a job to a terminal status only while it is still in one of `statuses` — a cancel and the
 * worker's own `ready`/`failed` write race, and the loser must not overwrite the winner.
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
 * Claim this job's one slot release. Every releaser — the worker, a cancel, the cleanup sweep —
 * writes this stamp first, so the counter below moves once however they interleave.
 *
 * @returns {Promise<boolean>} false: somebody else already claimed it.
 */
async function claimSlotRelease(id, at) {
  const outcome = await conditionalPatch(
    String(id), setOps({ slotReleasedAt: at }), 'FROM c WHERE NOT IS_DEFINED(c.slotReleasedAt)'
  );
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
  JOB_ID,
  SEARCH_DEF_PREFIX,
  SEARCH_DEF_KIND,
  getById,
  listActiveSearchDefinitionJobs,
  create,
  patch,
  patchIfStatus,
  listExpired,
  acquireSlot,
  releaseSlot,
  claimSlotRelease,
  // The worker and the controller share one document read, and it lives in documents.js because it
  // IS a document read — gated, projected and batched like every other.
  listDocumentsByIds: documents.listByIdsUnscoped
};
