'use strict';

/**
 * Re-derive a container's ACLs from its parent's, in one bulk patch.
 *
 * The `commentPeriods` and `comments` halves of the public-read cascade differ only in which
 * partition they read, so the rule itself lives here once. Documents keep their own copy in
 * `repositories/documents`: they carry a lazily captured `ownRead` snapshot, which these two do
 * not need — the Eagle push is the only writer of either container and it stores the raw upstream
 * record, so `sources.eagle.read` is always the row's own unconstrained ACL.
 */

const cosmos = require('../db/cosmos-nosql');
const { constrainToProject, DELETED_CEILING } = require('../repositories/documents');
const { seedAcl } = require('../seed/transform');

/**
 * @param {Array}  rows        `{id, read, eagleRead, isDeleted}` from the container's own acl
 *   projection. `isDeleted` is projected only by the containers that carry the flag.
 * @param {string} parentRead  the parent's new ACL
 * @returns {Array} `{id, read, isPublished}` per row, in `rows` order
 */
function deriveAcls(rows, parentRead) {
  return rows.map(row => {
    // The upstream ACL when the raw record still carries one, otherwise what the row holds today.
    // `seedAcl` fails closed, so a record with no upstream `read[]` lands at level 2 rather than
    // inheriting the parent's.
    const own = Array.isArray(row.eagleRead) && row.eagleRead.length > 0
      ? seedAcl(row.eagleRead)
      : (Array.isArray(row.read) && row.read.length > 0 ? row.read : seedAcl(null));
    // A deleted row's raw Eagle record still says `public` — it was published right up to the
    // delete — so without this ceiling the next project publish would republish it.
    const next = row.isDeleted === true
      ? constrainToProject(constrainToProject(own, parentRead), DELETED_CEILING)
      : constrainToProject(own, parentRead);
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
