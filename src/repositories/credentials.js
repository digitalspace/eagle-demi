'use strict';

/**
 * Selected Credentials — Cosmos NoSQL.
 *
 * Container `credentials`, partitioned by `/party/id`. The read on the hot path is "what does this
 * party hold", so it runs in one partition; the operator listings and the bulk revokes are
 * cross-partition and rare.
 *
 * NO read ACL applies here, for the same reason `api-keys.js` has none: this container is never
 * exposed through the ACL-driven read paths. It is reached by `middleware/credentials.js` (by
 * party, internally) and by the `/credentials` routes, which are `requireWrite` +
 * `requireRole('sysadmin')`. Nobody should later "fix" the missing visibility predicate by wiring
 * this into a public read.
 *
 * A row is never deleted. A grant is revoked by stamping `revokedAt`, so the row stays as the
 * record of what was granted, to whom, by whom, and when it stopped. The one edit is `scope.ids`,
 * narrowed when a single project of a multi-project grant closes.
 */

const crypto = require('crypto');
const cosmos = require('../db/cosmos-nosql');
const { auditEvent } = require('../utils/audit');

const CONTAINER = 'credentials';
const PARTITION_FIELD = 'party.id';

/** Not yet revoked. `revokedAt` is absent on a fresh grant and null on one written by the API. */
const LIVE = '(NOT IS_DEFINED(c.revokedAt) OR IS_NULL(c.revokedAt))';

/** Every unrevoked grant this party holds; the middleware re-checks revokedAt and the window. */
async function listForParty(partyId) {
  const { items } = await cosmos.query(CONTAINER, {
    query: `SELECT * FROM c WHERE c.party.id = @party AND ${LIVE}`,
    parameters: [{ name: '@party', value: String(partyId) }]
  }, { partitionKey: String(partyId) });
  return items || [];
}

/**
 * The four ways an operator names a set of grants, as a WHERE fragment.
 *
 * `projectId` matches project-scoped grants only: a document-scoped grant names document ids, and
 * resolving those to a project would need a second read per id.
 */
function selectorClause(selector = {}) {
  if (selector.id) {
    return { clause: 'c.id = @id', params: [{ name: '@id', value: String(selector.id) }] };
  }
  if (selector.batchId) {
    return {
      clause: 'c.batchId = @batchId',
      params: [{ name: '@batchId', value: String(selector.batchId) }]
    };
  }
  if (selector.party) {
    return {
      clause: 'c.party.id = @party',
      params: [{ name: '@party', value: String(selector.party) }]
    };
  }
  if (selector.projectId) {
    return {
      clause: "c.scope.type = 'project' AND ARRAY_CONTAINS(c.scope.ids, @projectId)",
      params: [{ name: '@projectId', value: String(selector.projectId) }]
    };
  }
  return null;
}

/** Live grants matching one selector. Returns [] for a selector nothing names. */
async function find(selector) {
  const where = selectorClause(selector);
  if (!where) return [];

  const { items } = await cosmos.query(CONTAINER, {
    query: `SELECT * FROM c WHERE ${where.clause} AND ${LIVE}`,
    parameters: where.params
  });
  return items || [];
}

/** Live grants over one project — what `GET /api/credentials?projectId=` reads. */
const listForProject = (projectId) => find({ projectId });

/** Every live project-scoped grant, in one cross-partition read. The nightly close sweep reads
 *  this once and intersects the ids itself, rather than a query per closed project. */
async function listLiveProjectScoped() {
  const { items } = await cosmos.query(CONTAINER, {
    query: `SELECT * FROM c WHERE c.scope.type = 'project' AND ${LIVE}`,
    parameters: []
  });
  return items || [];
}

async function insert(record) {
  return cosmos.create(CONTAINER, { id: crypto.randomUUID(), ...record });
}

/**
 * Revoke every live grant a selector names — `{ id | batchId | party | projectId }`.
 *
 * `patch`, never `upsert`: the row this process holds may be a cached copy, and an upsert would
 * write it whole (the failure `api-keys.touchLastUsed` documents).
 *
 * @returns {object[]} the rows revoked, as they were before the stamp
 */
const stampRevoked = (row, at) => cosmos.patch(CONTAINER, row.id, String(row.party.id), [
  { op: 'set', path: '/revokedAt', value: at }
]);

async function revokeBy(selector, at = new Date().toISOString()) {
  const rows = await find(selector);

  for (const row of rows) await stampRevoked(row, at);
  return rows;
}

/**
 * Close out one project's grants because its state changed — it closed, or its work completed.
 *
 * A grant that names other projects as well keeps them: the closed id is dropped from
 * `scope.ids` and the row stays live. Only a grant left with no id is revoked.
 *
 * Document-scoped grants name document ids, not project ids, and nothing here resolves a document
 * to its project, so a project close leaves them alone.
 *
 * Called by `src/scripts/sync-track-teams.js` on the `syncTrackTeams` timer with
 * `cause: 'project-closed'`. Work-complete is not in Track's feed. Nothing announces an ordinary
 * expiry: the holder reads each `end` on GET /api/me, the grantor on GET /api/credentials.
 *
 * @returns {object[]} the rows touched, narrowed or revoked, as they were before the write
 */
async function revokeForProject(projectId, cause, at = new Date().toISOString()) {
  const id = String(projectId);
  const rows = await find({ projectId: id });

  for (const row of rows) {
    const remaining = (row.scope.ids || []).filter(one => String(one) !== id);
    const event = { targetType: 'credential', targetId: row.id, projectId: id };

    if (remaining.length) {
      await cosmos.patch(CONTAINER, row.id, String(row.party.id), [
        { op: 'set', path: '/scope/ids', value: remaining }
      ]);
      auditEvent(null, {
        ...event,
        action: 'credential.narrow',
        detail: { cause, removed: [id], remaining: remaining.length }
      });
      continue;
    }

    await stampRevoked(row, at);
    auditEvent(null, {
      ...event,
      action: 'credential.revoke',
      detail: { cause, party: row.party, levels: row.levels, batchId: row.batchId }
    });
  }
  return rows;
}

module.exports = {
  CONTAINER,
  PARTITION_FIELD,
  listForParty,
  listForProject,
  listLiveProjectScoped,
  insert,
  revokeBy,
  revokeForProject
};
