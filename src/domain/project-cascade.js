'use strict';

const projects = require('../repositories/projects');
const documents = require('../repositories/documents');
const commentPeriods = require('../repositories/comment-periods');
const comments = require('../repositories/comments');
const groups = require('../repositories/groups');
const inspections = require('../repositories/inspections');
const { unlessUnprovisioned } = require('../helpers/unprovisioned');
const { systemAccess } = require('../helpers/access-sql');
const aiSearch = require('../search/ai-search');
const updateAcl = require('../helpers/update-acl');
const { logger } = require('../utils/logger');
const { raced } = require('../helpers/etag-write');

/**
 * Carry a project's visibility to its index row and its child rows (`ownRead ∩ projectRead`); an error message, or null.
 * ponytail: documents only, not chunks — a chunk gates on its parent document at query time.
 */
async function cascadeProjectVisibility(projectId, acl, eagleId, options) {
  const failure = await cascadeOnce(projectId, acl, eagleId, options);
  const stored = await projects.readForWrite(projectId).catch(err => err);
  if (!stored || stored instanceof Error) {
    logger.warn('[Project Controller] project not re-read after its cascade', { projectId, error: stored && stored.message });
    return failure;
  }
  const now = { read: stored.read, isPublished: stored.isPublished };
  if (!visibilityMoved(acl, now)) return failure;
  // One more pass only: whoever moves the row after this read runs its own cascade.
  logger.warn('[Project Controller] project moved during cascade, re-running', { projectId });
  return cascadeOnce(projectId, now, eagleId, options);
}

async function cascadeOnce(projectId, acl, eagleId, { updates = true } = {}) {
  // Index row first and outside the try: lists read the index, and the Cosmos write has already
  // landed, so the row must narrow even if the cascade below fails.
  await aiSearch.writeAcls(aiSearch.indexes().projects, [
    { id: projectId, read: acl.read, isPublished: acl.isPublished }
  ]);

  // Both, whatever either says: documents and engagement are independent containers, and stopping
  // at the first failure would leave the other carrying the old ACL with nothing recorded.
  const failures = [
    await cascadeDocumentVisibility(projectId, acl),
    await cascadeEngagementVisibility(projectId, acl.read),
    await cascadeMirrorVisibility('groups', groups, projectId, acl.read),
    await cascadeMirrorVisibility('inspections', inspections, projectId, acl.read),
    updates ? await cascadeUpdateVisibility(projectId, eagleId, acl.read) : null
  ].filter(Boolean);
  return failures.length ? failures.join(' ') : null;
}

/** Re-derive the comment periods' and comments' ACLs, which the mirror caps only at push time; an error message, or null. */
async function cascadeEngagementVisibility(projectId, read) {
  try {
    const periods = await commentPeriods.setAclForProject(systemAccess(), projectId, read);
    let commentsWritten = 0;
    let commentsFailed = 0;
    // Per period, because `comments` partitions on it — one bulk request each, and a project
    // carries a handful.
    for (const period of periods.rows) {
      const cascade = await comments.setAclForPeriod(systemAccess(), period.id, period.read);
      commentsWritten += cascade.succeeded;
      commentsFailed += cascade.failed;
    }

    const counts = {
      projectId, periods: periods.succeeded, periodsFailed: periods.failed,
      comments: commentsWritten, commentsFailed
    };
    if (periods.failed > 0 || commentsFailed > 0) {
      logger.error('[Project Controller] engagement ACL cascade partially failed', counts);
      return 'Project visibility changed, but its comment periods were not fully updated.';
    }
    logger.info('[Project Controller] engagement ACL cascade', counts);
    return null;
  } catch (cascadeErr) {
    logger.error('[Project Controller] engagement ACL cascade failed', {
      projectId, error: cascadeErr.message, stack: cascadeErr.stack
    });
    return 'Project visibility changed, but its comment periods were not updated.';
  }
}

/** The project's Updates, keyed by the EAGLE id (`updates.projectId`); an error message the caller must 500 with, or null. */
async function cascadeUpdateVisibility(projectId, eagleId, read) {
  try {
    const cascade = await updateAcl.setAclForProject(eagleId, read);
    if (cascade.failed > 0) {
      logger.error('[Project Controller] update ACL cascade partially failed', {
        projectId, eagleId, succeeded: cascade.succeeded, failed: cascade.failed
      });
      return 'Project visibility changed, but its updates were not fully updated.';
    }
    return null;
  } catch (cascadeErr) {
    logger.error('[Project Controller] update ACL cascade failed', {
      projectId, eagleId, error: cascadeErr.message, stack: cascadeErr.stack
    });
    return 'Project visibility changed, but its updates were not updated.';
  }
}

/**
 * The project's groups, or its inspections with their elements and items, each capped by the project at push time
 * and gated by its own `read[]`. An error message the caller must 500 with, or null.
 */
async function cascadeMirrorVisibility(label, repo, projectId, read) {
  try {
    const cascade = await unlessUnprovisioned(repo.CONTAINER, () => repo.setAclForProject(projectId, read));
    if (!cascade) return null;
    if (cascade.failed > 0) {
      logger.error(`[Project Controller] ${label} ACL cascade partially failed`, {
        projectId, succeeded: cascade.succeeded, failed: cascade.failed
      });
      return `Project visibility changed, but its ${label} were not fully updated.`;
    }
    return null;
  } catch (cascadeErr) {
    logger.error(`[Project Controller] ${label} ACL cascade failed`, {
      projectId, error: cascadeErr.message, stack: cascadeErr.stack
    });
    return `Project visibility changed, but its ${label} were not updated.`;
  }
}

/** @returns {Promise<string|null>} an error message the caller must 500 with, or null */
async function cascadeDocumentVisibility(projectId, acl) {
  try {
    const cascade = await documents.setAclForProject(systemAccess(), projectId, acl.read);
    if (cascade.failed > 0) {
      // Rows that landed still go to the index, else they list under the old ACL until the next
      // indexer pass. With no per-row verdicts nothing is written.
      const failedIds = new Set(cascade.failedIds || (cascade.rows || []).map(r => r.id));
      const landed = (cascade.rows || []).filter(row => !failedIds.has(row.id));
      if (landed.length) await aiSearch.writeAcls(aiSearch.indexes().documents, landed);
      logger.error('[Project Controller] document ACL cascade partially failed', {
        projectId, ...cascade, ids: undefined, rows: undefined
      });
      return 'Project visibility changed, but its documents were not fully updated.';
    }

    // The same derived ACLs the cascade just wrote to Cosmos, into the documents index. One
    // request per 1,000 documents, and it cannot throw.
    await aiSearch.writeAcls(aiSearch.indexes().documents, cascade.rows);
    return null;
  } catch (cascadeErr) {
    logger.error('[Project Controller] document ACL cascade failed', {
      projectId, error: cascadeErr.message, stack: cascadeErr.stack
    });
    return 'Project visibility changed, but its documents were not updated.';
  }
}

/** Whether a write moved what the documents, periods and the index row are gated on. */
function visibilityMoved(before, after) {
  if (before.isPublished !== after.isPublished) return true;
  const was = [...(before.read || [])].sort();
  const now = [...(after.read || [])].sort();
  return was.length !== now.length || was.some((role, i) => role !== now[i]);
}

/**
 * Cascade the project's visibility; on failure mark the row so the next push cascades again, since
 * a retried push leaves visibility unmoved. Returns an error message to 500 with, or null.
 */
async function runCascade(saved, eagleId, options) {
  let failure;
  try {
    failure = await cascadeProjectVisibility(saved.id,
      { read: saved.read, isPublished: saved.isPublished }, saved.eagleId, options);
  } catch (cascadeErr) {
    logger.error('[Project Controller] project visibility cascade threw', {
      projectId: saved.id, eagleId, error: cascadeErr.message, stack: cascadeErr.stack
    });
    failure = 'Project visibility changed, but its documents, engagement and updates were not updated.';
  }
  if (failure) await markCascadePending(saved, eagleId);
  return failure;
}

/** Best effort, and deliberately so: the 500 the caller is about to send is the real answer. */
async function markCascadePending(saved, eagleId) {
  const at = new Date().toISOString();
  try {
    // Owing a cascade is never wrong, so a row that moved since `saved` still takes the marker.
    await projects.patchCascadePending(saved.id, at, saved._etag).catch(async (err) => {
      if (!raced(err)) throw err;
      const fresh = await projects.readForWrite(saved.id);
      if (fresh) await projects.patchCascadePending(saved.id, at, fresh._etag);
    });
  } catch (patchErr) {
    logger.error('[Project Controller] could not record the owed visibility cascade', {
      projectId: saved.id, eagleId, error: patchErr.message, stack: patchErr.stack
    });
  }
}

/** Also best effort: a marker left behind only costs the next push one redundant cascade. */
async function clearCascadePending(saved, eagleId) {
  try {
    await projects.patchCascadePending(saved.id, null, saved._etag);
  } catch (patchErr) {
    logger.error('[Project Controller] could not clear the owed visibility cascade', {
      projectId: saved.id, eagleId, error: patchErr.message, stack: patchErr.stack
    });
  }
}

module.exports = {
  cascadeProjectVisibility, cascadeUpdateVisibility, visibilityMoved, runCascade, markCascadePending, clearCascadePending
};
