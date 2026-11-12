'use strict';

/**
 * Container `bulkDownloads`, partitioned by `/id`. No row ACL: the job UUID is the capability, and the
 * document ACL gates the ids a job names. `quota:` and `searchdef:` rows share it, read by id only.
 */

const cosmos = require('../db/cosmos-nosql');
const documents = require('./documents');

const CONTAINER = 'bulkDownloads';

// Only controller-minted UUIDs: no request may reach a `quota:` or `searchdef:` row by bare id.
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Tell a search-definition row from a zip row. One copy only: a second lets the two kinds start
// reaching each other's rows.
const SEARCH_DEF_PREFIX = 'searchdef:';
const SEARCH_DEF_KIND = 'searchDefinitions';

// What `queued` and `running` mean for a search-definition job: the run is not over, so a second
// apply must not start. Every other status in STATUSES is terminal for that kind.
const ACTIVE_STATUSES = ['queued', 'running'];

// Every status of both job kinds. A patch condition takes no parameters, so `patchIfStatus`
// interpolates, and this list keeps callers' values out of it.
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
 * Only rows still naming parts: a `cancelled` row keeps its status, so the sweep would page over it
 * forever. `limit` is one page, so a backlog clears over several nights.
 */
async function listExpired(cutoffIso, { statuses = ['ready', 'failed'], limit = 500 } = {}) {
  const names = statuses.map((_, i) => `@status${i}`);
  const { items } = await cosmos.query(CONTAINER, {
    query: `SELECT c.id, c.status, c.parts, c.finishedAt, c.createdAt, c.requesterKey, ` +
      `c.slotReleasedAt FROM c ` +
      `WHERE (c.status IN (${names.join(', ')}) AND c.finishedAt < @cutoff ` +
      `AND ARRAY_LENGTH(c.parts) > 0) ` +
      // Keeps out search-definition rows: a `running` one past the cutoff is not a dead zip. The
      // first clause needs no guard, as those rows carry no `parts`.
      "OR (c.status = 'running' AND c.startedAt < @cutoff AND IS_DEFINED(c.documentIds))",
    parameters: [
      ...names.map((name, i) => ({ name, value: String(statuses[i]) })),
      { name: '@cutoff', value: String(cutoffIso) }
    ]
  }, { maxItemCount: limit });
  return items;
}

/**
 * Drained, not paged: a cross-partition page can come back short while rows remain. `startedAt`
 * comes back because a killed worker leaves `running` behind; the caller dates the row.
 */
async function listActiveSearchDefinitionJobs() {
  const names = ACTIVE_STATUSES.map((_, i) => `@status${i}`);
  const { items } = await cosmos.query(CONTAINER, {
    query: `SELECT c.id, c.status, c.createdAt, c.startedAt FROM c ` +
      `WHERE STARTSWITH(c.id, @prefix) AND c.status IN (${names.join(', ')})`,
    parameters: [
      { name: '@prefix', value: SEARCH_DEF_PREFIX },
      ...names.map((name, i) => ({ name, value: ACTIVE_STATUSES[i] }))
    ]
  });
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
 * Test-and-set inside Cosmos: a count then a write lets concurrent requests pass a cap together.
 * The caps are interpolated, safe as config.js throws at load on anything but whole numbers.
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
 * The floor is in the condition, so a release that arrives twice cannot drive the counter negative
 * and hand out a free slot.
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
