'use strict';

/**
 * Container `credentials`, partitioned by `/party/id`. No read ACL: only `middleware/credentials.js`
 * and sysadmin `/credentials` routes reach it. Rows are never deleted; a revoke stamps `revokedAt`.
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
 * `projectId` matches project-scoped grants only: resolving a document-scoped grant's ids to a
 * project would need a read per id.
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
 * Revoke every live grant `{ id | batchId | party | projectId }` names. `patch`, never `upsert`: an
 * upsert would write a cached copy whole, as `api-keys.touchLastUsed` explains.
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
 * Drops the closed id from `scope.ids`; only a grant left with no id is revoked. Document-scoped
 * grants are left alone, as nothing here maps a document to its project.
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
