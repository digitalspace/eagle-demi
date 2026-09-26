'use strict';

/**
 * Re-derive a project's Updates' ACLs when its visibility changes, by the push's own rule
 * (`update-parent:readUnder`, which drops compliance) off `sources.eagle.read`. Not `acl-cascade.cascadeAcl`: that derives
 * through `seedAcl` and ladder tokens, which would widen an Update, and patches one partition while
 * `updates` partitions on `/id`.
 */

const cosmos = require('../db/cosmos-nosql');
const updates = require('../repositories/updates');
const notifications = require('../repositories/notifications');
const { readUnder } = require('./update-parent');
const { heldSealed } = require('../controllers/nosql/eagle-mirror');
const { logger } = require('../utils/logger');

const NOTHING = Object.freeze({ succeeded: 0, failed: 0, statusCounts: {}, requestCharge: 0, ids: [], rows: [] });

/**
 * @param {string}   projectEagleId  the project's EAGLE id: `updates.projectId` holds that id space
 * @param {string[]} projectRead     the project's new ACL
 * @returns {Promise<object>} the bulk result plus `ids` and the derived `rows`
 */
async function setAclForProject(projectEagleId, projectRead) {
  if (!Array.isArray(projectRead) || projectRead.length === 0) {
    throw new TypeError('[update-acl] requires a non-empty read[] ACL');
  }
  if (!projectEagleId) return NOTHING;
  // The parent gate's cached rows hold this project's old read.
  updates.forgetParents();

  // A notification wins an id a Track project also carries (`parent-admit:pickParent`), so those
  // Updates hang off the notification and this project's visibility is not theirs to follow.
  // Unfiltered: a sealed notification still holds its id.
  if (await notifications.readForWrite(String(projectEagleId))) return NOTHING;

  const { items } = await cosmos.query(updates.CONTAINER, {
    query: 'SELECT c.id, c.read, c.sealedAt, c.sources.eagle.read AS eagleRead FROM c WHERE c.projectId = @projectId',
    parameters: [{ name: '@projectId', value: String(projectEagleId) }]
  }, {});
  // A row DEMI sealed keeps its seal, as a push does (`eagle-mirror:keepSeal`); one an Eagle push
  // sealed is re-derived like any other.
  const derived = items.filter(row => !heldSealed(row)).map(row => {
    const read = readUnder(row.eagleRead, { read: projectRead });
    return { id: String(row.id), read, isPublished: read.includes('public') };
  });
  if (derived.length === 0) return NOTHING;

  const result = await cosmos.bulkVerified(updates.CONTAINER, derived.map(row => ({
    operationType: 'Patch',
    partitionKey: row.id,
    id: row.id,
    resourceBody: {
      operations: [
        { op: 'set', path: '/read', value: row.read },
        { op: 'set', path: '/isPublished', value: row.isPublished },
        // The parent moved, so an announce the parent gate skipped is due again (`notifySkippedAt`).
        { op: 'set', path: '/notifySkippedAt', value: null },
        { op: 'set', path: '/notifySkipReason', value: null }
      ]
    }
  })));

  logger.debug('[update-acl] updates re-derived under project', {
    projectEagleId, succeeded: result.succeeded, failed: result.failed
  });
  return { ...result, ids: derived.map(r => r.id), rows: derived };
}

module.exports = { setAclForProject };
