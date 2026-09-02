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
 * A row is never deleted or edited. A grant is revoked by stamping `revokedAt`, so the row stays
 * as the record of what was granted, to whom, by whom, and when it stopped.
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
async function revokeBy(selector, at = new Date().toISOString()) {
  const rows = await find(selector);

  for (const row of rows) {
    await cosmos.patch(CONTAINER, row.id, String(row.party.id), [
      { op: 'set', path: '/revokedAt', value: at }
    ]);
  }
  return rows;
}

/**
 * Revoke every grant over a project because its state changed — it closed, or its work completed.
 *
 * Called by `src/scripts/sync-track-teams.js` on the `syncTrackTeams` timer with
 * `cause: 'project-closed'`. Work-complete is not in Track's feed, and the 7-day pre-expiry notice
 * needs a mailer this repo does not have (TODO-rbac.md P3-6).
 */
async function revokeForProject(projectId, cause) {
  const revoked = await revokeBy({ projectId });

  for (const row of revoked) {
    auditEvent(null, {
      action: 'credential.revoke',
      targetType: 'credential',
      targetId: row.id,
      projectId,
      detail: { cause, party: row.party, levels: row.levels, batchId: row.batchId }
    });
  }
  return revoked;
}

module.exports = {
  CONTAINER,
  PARTITION_FIELD,
  listForParty,
  listForProject,
  insert,
  revokeBy,
  revokeForProject
};
