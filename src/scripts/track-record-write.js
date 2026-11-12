'use strict';

// One Track work, phase or event record: one work document written, then the project row's derived
// fields patched only where they moved. Answers plain `{ status }` values; the routes map them to HTTP.

const { isDeepStrictEqual } = require('node:util');
const config = require('../config');
const { logger } = require('../utils/logger');
const projects = require('../repositories/projects');
const works = require('../repositories/works');
const { writeGuarded } = require('../helpers/etag-write');
const { deriveInputs } = require('../domain/works-derive');
const {
  STATUS, TRACK_OWNED, applyWork, applyNewWork, applyPhase, applyEvent, removePhase, removeEvent, removeWork
} = require('../merge/track-record');

const RESULT = Object.freeze({
  ...STATUS,
  UNCHANGED: 'unchanged',
  GONE: 'gone',
  API_ROW: 'api-row',
  NOT_BACKFILLED: 'not-backfilled',
  PROJECT_NOT_FOUND: 'project-not-found',
  CONFLICT: 'conflict',
  DERIVED_CONFLICT: 'derived-conflict',
  ADOPTED: 'adopted'
});

/** The document as stored, without Cosmos' own fields and the write time. */
const storedFields = (doc) => Object.fromEntries(Object.entries(doc || {})
  .filter(([key]) => !key.startsWith('_') && key !== 'updatedAt'));

/** What a reader sees of a document: a tombstone and an absent work show nothing, and stamps are not shown. */
function visible(doc) {
  if (!doc || doc.deleted === true) return null;
  const { pushStamps: _stamps, ...fields } = storedFields(doc);
  return fields;
}

const holdsPhase = (id) => (doc) => doc.phases.some(p => p.trackPhaseId === Number(id));
const holdsEvent = (id) => (doc) => doc.phases.some(p => p.milestones.some(m => m.trackEventId === Number(id)));

/**
 * Per kind and method: the work the record lands in, by id or (a phase or event DELETE names no work)
 * by the stored work holding the child, and the merge step for it.
 */
const STEPS = {
  work: {
    POST: (body, opts) => ({ workId: body.work.id, apply: (doc) => applyNewWork(doc, body, opts) }),
    PUT: (body, opts) => ({ workId: body.work.id, apply: (doc) => applyWork(doc, body, opts) }),
    DELETE: ({ pushedAt, workTypeId, id }, opts) =>
      ({ workId: id, apply: (doc) => removeWork(doc, { pushedAt, workId: id, workTypeId }, opts) })
  },
  phase: {
    POST: (body) => ({ workId: body.phase.work_id, apply: (doc) => applyPhase(doc, body) }),
    PUT: (body) => ({ workId: body.phase.work_id, apply: (doc) => applyPhase(doc, body) }),
    DELETE: ({ pushedAt, id }) => ({ holds: holdsPhase(id), apply: (doc) => removePhase(doc, { pushedAt, phaseId: id }) })
  },
  event: {
    POST: (body) => ({ workId: body.event.work_id, apply: (doc) => applyEvent(doc, body) }),
    PUT: (body) => ({ workId: body.event.work_id, apply: (doc) => applyEvent(doc, body) }),
    DELETE: ({ pushedAt, id }) => ({ holds: holdsEvent(id), apply: (doc) => removeEvent(doc, { pushedAt, eventId: id }) })
  }
};

async function workIdOf(projectId, step) {
  if (step.workId !== undefined) return step.workId;
  const holder = (await works.listByProject(projectId, { owner: TRACK_OWNED.owner })).find(step.holds);
  return holder ? holder.trackWorkId : null;
}

/**
 * Applies the step to the stored document and saves it under its etag; a lost race re-reads and re-applies.
 * `unchanged` when a reader would see no difference: the save then only carries moved stamps, or is skipped.
 */
async function saveWork(projectId, workId, step) {
  const read = () => works.get(projectId, `track-${workId}`);
  return writeGuarded({
    existing: await read(),
    reread: read,
    attempt: async (doc) => {
      const { status, doc: next } = step.apply(doc);
      if (status !== RESULT.APPLIED) return { status };
      const changed = !isDeepStrictEqual(visible(doc), visible(next));
      if (!changed && isDeepStrictEqual(storedFields(doc), storedFields(next))) return { status: RESULT.UNCHANGED };
      const updatedAt = changed ? new Date().toISOString() : next.updatedAt;
      const saved = await works.save({ ...next, updatedAt },
        { owner: TRACK_OWNED.owner, etag: doc ? doc._etag : undefined, existing: doc });
      if (saved.status === 'foreign') return { status: RESULT.ADOPTED };
      return { status: changed ? RESULT.APPLIED : RESULT.UNCHANGED };
    }
  });
}

/**
 * One Track record (`kind` work, phase or event) to `{ status }` of RESULT. `body` is the record as Track sends it;
 * a DELETE has none, so its route passes `{ pushedAt, workTypeId, id }` from the path and query.
 */
async function writeTrackRecord(kind, method, trackProjectId, body) {
  if (!config.worksWrite) return { status: RESULT.NOT_BACKFILLED };
  const projectId = String(trackProjectId);
  const row = await projects.readForWrite(projectId);
  if (!row) return { status: RESULT.PROJECT_NOT_FOUND };
  // Same skip as the project writer: stamping Track's works onto an API row would pass it off as a Track row.
  if (!(row.sources || {}).track) return { status: RESULT.API_ROW };

  // A phase or event DELETE with no live work holding it has nothing left to remove.
  const missing = method === 'DELETE' && kind !== 'work' ? RESULT.GONE : RESULT.PARENT_NOT_FOUND;
  const step = STEPS[kind][method](body, { projectId: row.id });
  const workId = await workIdOf(row.id, step);
  if (workId === null) return { status: missing };

  const saved = await saveWork(row.id, workId, step);
  if (saved.status === RESULT.PARENT_NOT_FOUND) return { status: missing };
  if (saved.status !== RESULT.APPLIED && saved.status !== RESULT.UNCHANGED) return saved;

  // Runs on an unchanged document too: a retry after a lost patch carries the same stamp and must still repair the row.
  const derived = await projects.patchDerived(row.id, { inputsFor: deriveInputs });
  if (derived.status === RESULT.CONFLICT) {
    logger.error(`[track-push] derived patch lost id=${projectId}/work:${workId}`);
    // The retry finds the document saved and answers unchanged, so only this call can audit the write.
    return { status: RESULT.DERIVED_CONFLICT, written: saved.status === RESULT.APPLIED };
  }
  return { status: saved.status };
}

module.exports = { RESULT, writeTrackRecord };
