'use strict';

/**
 * Public-read cascade shared by `commentPeriods` and `comments`. Documents keep their own copy in
 * `repositories/documents` because they need an `ownRead` snapshot; these two do not.
 */

const cosmos = require('../db/cosmos-nosql');
const { constrainToProject, DELETED_CEILING } = require('../repositories/documents');
const { eagleBaseAcl, eagleReadUnder } = require('../seed/transform');

/**
 * @param {Array}  rows        `{id, read, eagleRead, isDeleted}` from the container's own acl
 *   projection. `isDeleted` is projected only by the containers that carry the flag.
 * @param {string} parentRead  the parent's new ACL
 * @returns {Array} `{id, read, isPublished}` per row, in `rows` order
 */
function deriveAcls(rows, parentRead) {
  return rows.map(row => {
    // Upstream ACL when the raw record has one, else the row's current ACL. `eagleBaseAcl` fails
    // closed: no upstream `read[]` lands at level 2, not at the parent's ACL.
    const capped = Array.isArray(row.eagleRead) && row.eagleRead.length > 0
      ? eagleReadUnder(row.eagleRead, parentRead)
      : constrainToProject(Array.isArray(row.read) && row.read.length > 0 ? row.read : eagleBaseAcl(null), parentRead);
    // A deleted row's raw Eagle record still says `public` — it was published right up to the
    // delete — so without this ceiling the next project publish would republish it.
    const next = row.isDeleted === true ? constrainToProject(capped, DELETED_CEILING) : capped;
    return { id: String(row.id), read: next, isPublished: next.includes('public') };
  });
}

/**
 * Patch the derived ACLs onto one partition.
 *
 * @returns {Promise<object>} the bulk result plus `ids` and the derived `rows`
 */
async function cascadeAcl(container, partitionKey, rows, parentRead) {
  if (!Array.isArray(parentRead) || parentRead.length === 0) {
    throw new TypeError('[acl-cascade] requires a non-empty read[] ACL');
  }
  if (rows.length === 0) {
    return { succeeded: 0, failed: 0, statusCounts: {}, requestCharge: 0, ids: [], rows: [] };
  }

  const derived = deriveAcls(rows, parentRead);
  const pk = String(partitionKey);
  const updatedAt = new Date().toISOString();
  const result = await cosmos.bulkVerified(container, derived.map(row => ({
    operationType: 'Patch',
    partitionKey: pk,
    id: row.id,
    resourceBody: {
      operations: [
        { op: 'set', path: '/read', value: row.read },
        { op: 'set', path: '/isPublished', value: row.isPublished },
        { op: 'set', path: '/updatedAt', value: updatedAt }
      ]
    }
  })));

  return { ...result, ids: derived.map(r => r.id), rows: derived };
}

module.exports = { deriveAcls, cascadeAcl };
