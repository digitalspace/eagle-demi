'use strict';

// One Track record (work, phase or event) applied to one stored work document. Pure: the caller
// reads the document, writes the result and sets `updatedAt`. Each answer is `{ status, doc }`.

const {
  isShownEvent, docMilestoneOf, docPhaseOf, docWorkFieldsOf, settledDoc
} = require('../seed/track-mappers');

const STATUS = Object.freeze({ APPLIED: 'applied', STALE: 'stale', PARENT_NOT_FOUND: 'parent-not-found' });

/** Keys a document holds beside the work's own fields; `settledDoc` rebuilds all but `deleted`. */
const DOC_TAIL = new Set(['outcome', 'phases', 'pushStamps', 'updatedAt', 'deleted']);

const stampsOf = (doc) => ({ ...((doc && doc.pushStamps) || {}) });

function stampOf(doc, key) {
  const stamp = stampsOf(doc)[key];
  return typeof stamp === 'number' ? stamp : -Infinity;
}

/** Older than the stored stamp for that record; an equal stamp re-applies. */
const isStale = (doc, key, pushedAt) => Number(pushedAt) < stampOf(doc, key);

const isLive = (doc) => Boolean(doc) && doc.deleted !== true;

const fieldsOf = (doc) => Object.fromEntries(Object.entries(doc).filter(([key]) => !DOC_TAIL.has(key)));

const applied = (doc, phases, stamps) =>
  ({ status: STATUS.APPLIED, doc: settledDoc(fieldsOf(doc), phases, stamps, doc.updatedAt ?? null) });

const unchanged = (status, doc) => ({ status, doc });

/** A work PUT: the work's own fields replaced, its stored phases and milestones kept. */
function applyWork(doc, { pushedAt, work }, { projectId = null } = {}) {
  if (isStale(doc, 'work', pushedAt)) return unchanged(STATUS.STALE, doc);
  const fields = docWorkFieldsOf(work, doc ? doc.projectId : projectId);
  const stamps = { ...stampsOf(doc), work: Number(pushedAt) };
  return { status: STATUS.APPLIED,
    doc: settledDoc(fields, isLive(doc) ? doc.phases : [], stamps, doc ? doc.updatedAt ?? null : null) };
}

/** A phase POST or PUT: its fields replaced, its stored milestones kept. */
function applyPhase(doc, { pushedAt, phase }) {
  if (!isLive(doc) || Number(phase.work_id) !== doc.trackWorkId) return unchanged(STATUS.PARENT_NOT_FOUND, doc);
  const key = `phase:${phase.id}`;
  if (isStale(doc, key, pushedAt)) return unchanged(STATUS.STALE, doc);
  const held = doc.phases.find(p => p.trackPhaseId === phase.id);
  const phases = doc.phases.filter(p => p !== held).concat(docPhaseOf(phase, held ? held.milestones : []));
  return applied(doc, phases, { ...stampsOf(doc), [key]: Number(pushedAt) });
}

const withoutEvent = (phases, eventId) =>
  phases.map(p => ({ ...p, milestones: p.milestones.filter(m => m.trackEventId !== eventId) }));

/** An event POST or PUT, nested under the phase its `work_phase_id` names; a HIDDEN one is taken out. */
function applyEvent(doc, { pushedAt, event }) {
  const parent = isLive(doc) && Number(event.work_id) === doc.trackWorkId
    ? doc.phases.find(p => p.trackPhaseId === event.work_phase_id) : null;
  if (!parent) return unchanged(STATUS.PARENT_NOT_FOUND, doc);
  const key = `event:${event.id}`;
  if (isStale(doc, key, pushedAt)) return unchanged(STATUS.STALE, doc);
  const phases = withoutEvent(doc.phases, event.id).map(p => (p.trackPhaseId === parent.trackPhaseId && isShownEvent(event)
    ? { ...p, milestones: [...p.milestones, docMilestoneOf(event)] } : p));
  return applied(doc, phases, { ...stampsOf(doc), [key]: Number(pushedAt) });
}

/** A phase DELETE: the phase and its milestones go; each keeps a stamp so an older PUT cannot bring it back. */
function removePhase(doc, { pushedAt, phaseId }) {
  if (!isLive(doc)) return unchanged(STATUS.PARENT_NOT_FOUND, doc);
  const key = `phase:${phaseId}`;
  if (isStale(doc, key, pushedAt)) return unchanged(STATUS.STALE, doc);
  const at = Number(pushedAt);
  const stamps = { ...stampsOf(doc), [key]: at };
  const gone = doc.phases.find(p => p.trackPhaseId === Number(phaseId));
  for (const m of gone ? gone.milestones : []) {
    stamps[`event:${m.trackEventId}`] = Math.max(stampOf(doc, `event:${m.trackEventId}`), at);
  }
  return applied(doc, doc.phases.filter(p => p !== gone), stamps);
}

/** An event DELETE: the milestone goes and its stamp stays. */
function removeEvent(doc, { pushedAt, eventId }) {
  if (!isLive(doc)) return unchanged(STATUS.PARENT_NOT_FOUND, doc);
  const key = `event:${eventId}`;
  if (isStale(doc, key, pushedAt)) return unchanged(STATUS.STALE, doc);
  return applied(doc, withoutEvent(doc.phases, Number(eventId)), { ...stampsOf(doc), [key]: Number(pushedAt) });
}

/** A work DELETE: a tombstone holding the stamps, so no older record of the work lands after it. */
function removeWork(doc, { pushedAt, workId, workTypeId }, { projectId = null } = {}) {
  if (isStale(doc, 'work', pushedAt)) return unchanged(STATUS.STALE, doc);
  return { status: STATUS.APPLIED, doc: {
    id: `track-${workId}`,
    projectId: doc ? doc.projectId : projectId,
    trackWorkId: Number(workId),
    workTypeId: Number(workTypeId ?? (doc ? doc.workTypeId : NaN)),
    deleted: true,
    pushStamps: { ...stampsOf(doc), work: Number(pushedAt) },
    updatedAt: doc ? doc.updatedAt ?? null : null
  } };
}

/** Folds steps over the document: applied when any step applied, else the first step's answer. */
function fold(doc, steps) {
  let current = doc;
  let first = null;
  let anyApplied = false;
  for (const step of steps) {
    const result = step(current);
    current = result.doc;
    first = first || result.status;
    anyApplied = anyApplied || result.status === STATUS.APPLIED;
  }
  return { status: anyApplied ? STATUS.APPLIED : first, doc: current };
}

/**
 * A nested new-work POST: the work, its phases and their events as Track held them at `pushedAt`.
 * Stored phases and events it lacks go, each part only where its own stamp is not newer.
 */
function applyNewWork(doc, { pushedAt, work }, { projectId = null } = {}) {
  const phases = work.phases || [];
  const events = phases.flatMap(wp => wp.events || []);
  const phaseIds = new Set(phases.map(wp => wp.id));
  const eventIds = new Set(events.map(e => e.id));
  const record = (body) => ({ pushedAt, ...body });
  return fold(doc, [
    (d) => applyWork(d, record({ work }), { projectId }),
    (d) => fold(d, (isLive(d) ? d.phases : []).filter(p => !phaseIds.has(p.trackPhaseId))
      .map(p => (one) => removePhase(one, record({ phaseId: p.trackPhaseId })))),
    (d) => fold(d, phases.map(wp => (one) => applyPhase(one, record({ phase: { ...wp, work_id: work.id } })))),
    (d) => fold(d, (isLive(d) ? d.phases : []).flatMap(p => p.milestones).filter(m => !eventIds.has(m.trackEventId))
      .map(m => (one) => removeEvent(one, record({ eventId: m.trackEventId })))),
    (d) => fold(d, events.map(e => (one) => applyEvent(one, record({ event: { ...e, work_id: work.id } }))))
  ]);
}

module.exports = {
  STATUS, applyWork, applyNewWork, applyPhase, applyEvent, removePhase, removeEvent, removeWork
};
