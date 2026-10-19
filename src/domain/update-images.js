'use strict';

/**
 * Images uploaded from the Update form (`documentSource: 'UPDATE'`) keep their public state in step
 * with the updates that show them. Ported from eagle-api `api/helpers/updateImages.js`.
 */

const documents = require('../repositories/documents');
const chunks = require('../repositories/chunks');
const updates = require('../repositories/updates');
const aiSearch = require('../search/ai-search');
const { systemAccess, levelOfRead, readForLevel } = require('../helpers/access-sql');
const { auditEvent } = require('../utils/audit');
const { logger } = require('../utils/logger');

const PUBLIC_LEVEL = 4;
// Back to the level an upload starts at, as eagle-api's unPublish does, not Rejected.
const PRIVATE_LEVEL = 2;

const present = (id) => id !== undefined && id !== null && String(id).trim() !== '';

/** Ids of the documents an update shows as images: the featured image and the gallery. */
function imageIds(row) {
  return [...new Set([
    row && row.featuredImage && row.featuredImage.document,
    ...(row && Array.isArray(row.images) ? row.images.map(image => image && image.document) : [])
  ].filter(present).map(String))];
}

/** The update's own uploads among `ids`, read unfiltered: a private image must still be found. */
async function uploadedImages(ids) {
  const docs = await Promise.all(ids.map(id => documents.getById(systemAccess(), id)));
  return docs.filter(doc => doc && doc.documentSource === documents.UPDATE_SOURCE);
}

/** Uploads of the same parent that publishing the update would publish (eagle-api `publishFor`'s filter). */
async function publishable(row, parentId) {
  const docs = await uploadedImages(imageIds(row));
  return docs.filter(doc => levelOfRead(doc.read) < PUBLIC_LEVEL &&
    String(doc.projectId || '') === String(parentId || ''));
}

/** Move one image and everything that copies its read: the search index and any chunks. */
async function moveImage(ctx, doc, level, updateId) {
  const saved = await documents.setPublished(doc.id, doc.projectId, level,
    { levelHeldAt: documents.levelHoldAfter(doc, level, null) });
  const read = saved && Array.isArray(saved.read) && saved.read.length ? saved.read : readForLevel(level);
  await aiSearch.writeAcls(aiSearch.indexes().documents, [{ id: doc.id, read, isPublished: level === PUBLIC_LEVEL }]);
  await chunks.setAclForDocument(systemAccess(), doc.id, read);
  auditEvent(ctx.req, {
    action: level === PUBLIC_LEVEL ? 'record.widen' : 'record.narrow',
    targetType: 'document',
    targetId: doc.id,
    projectId: doc.projectId,
    detail: { from: levelOfRead(doc.read), to: level, reason: `update image ${updateId}` }
  });
  logger.info(`[Update Images] moved image ${doc.id} to level ${level}`, { documentId: doc.id, updateId, level });
  return { ...doc, read };
}

/** Ids among `docIds` that some published update shows. */
async function shownIds(docIds) {
  const rows = await updates.listShowingDocuments(docIds);
  return new Set(rows.flatMap(row => [...imageIds(row), ...(row.attachments || []).map(String)]));
}

/**
 * Unpublish the uploads among `ids` that no published update shows. Call after the update is
 * saved, so its own new state counts. Never throws: the update change already stands.
 */
async function release(ctx, ids, updateId) {
  if (!ids.length) return;
  try {
    const docs = (await uploadedImages(ids)).filter(doc => levelOfRead(doc.read) === PUBLIC_LEVEL);
    if (!docs.length) return;
    const shown = await shownIds(docs.map(doc => doc.id));
    const unpublished = [];
    for (const doc of docs.filter(d => !shown.has(String(d.id)))) {
      try {
        unpublished.push(await moveImage(ctx, doc, PRIVATE_LEVEL, updateId));
      } catch (err) {
        logger.error('[Update Images] could not unpublish image, it stays public', {
          documentId: doc.id, updateId, error: err.message, stack: err.stack
        });
      }
    }
    if (!unpublished.length) return;
    // An update that saved published after the read above skipped these as public; publish them back.
    const nowShown = await shownIds(unpublished.map(doc => doc.id));
    for (const doc of unpublished.filter(d => nowShown.has(String(d.id)))) {
      await moveImage(ctx, doc, PUBLIC_LEVEL, updateId);
      logger.warn('[Update Images] republished image a published update started showing', { documentId: doc.id, updateId });
    }
  } catch (err) {
    logger.error('[Update Images] could not release images', { updateId, error: err.message, stack: err.stack });
  }
}

/** Unpublish what `publishFor` published, for a save that failed. Never throws. */
const revert = (ctx, docs, updateId) => release(ctx, docs.map(doc => String(doc.id)), updateId || '(not saved)');

/**
 * Publish the update's own private uploads before it is saved, so it is never live with a private
 * image. On a failure, reverts what it published and throws.
 *
 * @returns {Promise<object[]>} the documents it published, for `revert`
 */
async function publishFor(ctx, row, parentId) {
  const published = [];
  // The update's read is already capped by its parent, so an image never rises above the parent's
  // level, the rule setLevel enforces with its 409. eagle-api had no such cap.
  if (levelOfRead(row.read || []) < PUBLIC_LEVEL) {
    logger.info('[Update Images] update not public under its parent, images left as they are', { updateId: row.id });
    return published;
  }
  try {
    for (const doc of await publishable(row, parentId)) {
      published.push(await moveImage(ctx, doc, PUBLIC_LEVEL, row.id));
    }
  } catch (err) {
    logger.error('[Update Images] publishing images failed', { updateId: row.id, error: err.message, stack: err.stack });
    await revert(ctx, published, row.id);
    throw err;
  }
  return published;
}

/**
 * `publishFor` again once a published update is saved: a concurrent release may have unpublished a
 * shared image in between. Never throws: the update change already stands.
 */
async function republish(ctx, row, parentId) {
  try {
    await publishFor(ctx, row, parentId);
  } catch (err) {
    logger.error('[Update Images] update saved published but its images could not be republished', {
      updateId: row.id, error: err.message
    });
  }
}

module.exports = { imageIds, publishable, publishFor, republish, release, revert };
