'use strict';

/**
 * The nightly's half of the works dual write: each mirrored Track work as one `works` document.
 * Repair only: a document a push stamped after the pull started is the push's, and is left alone.
 */

const config = require('../config');
const works = require('../repositories/works');
const { writeGuarded } = require('../helpers/etag-write');
const { workDocOf } = require('../seed/track-mappers');
const { logger } = require('../utils/logger');

/** Any stamp after {pushedAt}: a push read Track after this pull did. */
const newerThan = (doc, pushedAt) => Number.isFinite(pushedAt) &&
  Object.values((doc && doc.pushStamps) || {}).some(stamp => stamp > pushedAt);

// Every key the mapper writes, bar the write time, so a quiet night writes nothing.
const sameDoc = (doc, stored) => Boolean(stored) && stored.deleted !== true &&
  Object.keys(doc).every(key => key === 'updatedAt' || JSON.stringify(doc[key]) === JSON.stringify(stored[key]));

/** `decide(current)` gives `{status}` to leave it, `{doc}` to save or `{tombstone: true}`. */
async function writeOne(projectId, id, stored, decide, live) {
  return writeGuarded({
    existing: stored,
    reread: () => works.get(projectId, id),
    attempt: async (current) => {
      const decided = decide(current);
      if (decided.status || !live) return { status: decided.status || 'written' };
      if (decided.tombstone) await works.tombstone(current, { etag: current._etag });
      else await works.save(decided.doc, { etag: current && current._etag });
      return { status: 'written' };
    },
    onLost: (_current, attempt) =>
      logger.warn('[track-works] work write lost its etag race, rebuilding', { projectId, id, attempt })
  });
}

/** A Track work as its document, keeping the stored push stamps. */
const upsert = (doc, pushedAt) => (current) => {
  if (newerThan(current, pushedAt)) return { status: 'stale' };
  const next = { ...doc, pushStamps: (current && current.pushStamps) || {} };
  return sameDoc(next, current) ? { status: 'unchanged' } : { doc: next };
};

/** A stored work missing from Track's list. */
const vanish = (pushedAt) => (current) => {
  if (!current || current.deleted === true) return { status: 'unchanged' };
  return newerThan(current, pushedAt) ? { status: 'stale' } : { tombstone: true };
};

/**
 * Saves each nested Track work ({trackWorks}) as its document and tombstones stored ones missing from it.
 * No container call while WORKS_WRITE is off or the works were not read; {pushedAt} is the pull's start.
 */
async function syncWorkDocs(projectId, trackWorks, { pushedAt = null, live = false, now = null } = {}) {
  const counts = { written: 0, unchanged: 0, stale: 0, failed: 0 };
  if (!config.worksWrite || !Array.isArray(trackWorks)) return counts;
  const tally = (id, { status }) => {
    if (status !== 'conflict') return counts[status]++;
    counts.failed++;
    logger.error(`[track-works] work ${projectId}/${id} not written`, { status });
  };
  try {
    const stored = new Map((await works.listByProject(projectId, { includeDeleted: true })).map(doc => [doc.id, doc]));
    const listed = new Set();
    for (const work of trackWorks) {
      const doc = workDocOf(work, { projectId, updatedAt: now });
      if (!doc) continue;
      listed.add(doc.id);
      tally(doc.id, await writeOne(projectId, doc.id, stored.get(doc.id) || null, upsert(doc, pushedAt), live));
    }
    for (const [id, doc] of stored) {
      if (!listed.has(id) && doc.deleted !== true) tally(id, await writeOne(projectId, id, doc, vanish(pushedAt), live));
    }
  } catch (err) {
    counts.failed++;
    logger.error(`[track-works] project ${projectId} works not written`, { error: err.message, stack: err.stack });
  }
  return counts;
}

module.exports = { syncWorkDocs };
