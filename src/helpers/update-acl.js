'use strict';

/**
 * Re-derive a project's Updates' ACLs when its visibility changes, by the push's own rule
 * (`update-parent:updateRead`, which drops compliance) off `sources.eagle`, or `sources.demi` on a DEMI row. Not `acl-cascade.cascadeAcl`: that derives
 * through `constrainToProject`, whose ladder-token rewrite would widen an Update, and patches one partition while
 * `updates` partitions on `/id`.
 */

const cosmos = require('../db/cosmos-nosql');
const updates = require('../repositories/updates');
const notifications = require('../repositories/notifications');
const updateParent = require('./update-parent');
const images = require('../domain/update-images');
const { heldSealed } = require('./access-sql');
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
    // `status` and `active` too: a row with no read (`update-parent:inheritsParentRead`) follows the project.
    query: 'SELECT c.id, c.read, c.sealedAt, c.sources.eagle.read AS eagleRead, ' +
      'c.sources.eagle.status AS eagleStatus, c.sources.eagle.active AS eagleActive, ' +
      'c.sourceSystem, c.sources.demi.read AS demiRead, c.sources.demi.status AS demiStatus, ' +
      'c.featuredImage, c.images ' +
      'FROM c WHERE c.projectId = @projectId',
    parameters: [{ name: '@projectId', value: String(projectEagleId) }]
  }, {});
  // A row DEMI sealed keeps its seal, as a push does (`eagle-mirror:keepSeal`); one an Eagle push
  // sealed is re-derived like any other.
  const derived = items.filter(row => !heldSealed(row)).map(row => {
    // A row DEMI created has no Eagle copy; its own read and status are in `sources.demi` (domain/updates.js).
    const source = row.sourceSystem === 'demi'
      ? { read: row.demiRead, status: row.demiStatus }
      : { read: row.eagleRead, status: row.eagleStatus, active: row.eagleActive };
    const read = updateParent.updateRead(source, { read: projectRead });
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
  await publishOpenedImages(projectEagleId, items, derived, result);
  return { ...result, ids: derived.map(r => r.id), rows: derived };
}

/**
 * A DEMI update the cascade left public shows its own uploads, as publishing it would have
 * (domain/update-images.js). The reverse needs nothing here: `documents.setAclForProject` caps them.
 * Never throws: the visibility change already stands.
 */
async function publishOpenedImages(projectEagleId, items, derived, result) {
  const unpatched = new Set([...(result.failedIds || []), ...(result.skippedIds || [])].map(String));
  const readOf = new Map(derived.filter(row => row.isPublished && !unpatched.has(row.id)).map(row => [row.id, row.read]));
  const opened = items.filter(item => item.sourceSystem === 'demi' && readOf.has(String(item.id)) &&
    images.imageIds(item).length > 0);
  if (opened.length === 0) return;
  try {
    const parent = await updateParent.readParent(String(projectEagleId));
    for (const item of opened) {
      await images.publishFor({ req: null }, { ...item, id: String(item.id), read: readOf.get(String(item.id)) },
        parent && parent.id);
    }
  } catch (err) {
    logger.error('[update-acl] images of an opened update not published', { projectEagleId, error: err.message, stack: err.stack });
  }
}

module.exports = { setAclForProject };
