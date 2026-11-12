'use strict';

// Track's writes as they commit, one record per call under `/track/projects`. Refusals log `[track-push]` at
// error, which the alert matches; a race Track repeats, a missing parent and the works flag off log at warn.

const projects = require('../../repositories/projects');
const { levelOfRead } = require('../../helpers/access-sql');
const { DUPLICATE_ID } = require('../../helpers/duplicate-id');
const { isDemiOwnedProject } = require('../../merge/project');
const { isMirrored } = require('../../seed/track-mappers');
const { writeTrackProject } = require('../../scripts/sync-track-projects');
const { RESULT, writeTrackRecord } = require('../../scripts/track-record-write');
const { TRACK_PUSHED_AT } = require('../../ownership/project');
const { logger } = require('../../utils/logger');
const { auditEvent } = require('../../utils/audit');
const { deleteProjectRow } = require('./project');

const WRITTEN_STATUS = { created: 201, relinked: 201, updated: 200 };
const RETRY = 'The record is being written by another request. Try again.';
const TRACK_ID = /^[1-9]\d*$/;
const MAX_PUSH_AHEAD_MS = 5 * 60 * 1000;
// Below this a stamp is in seconds, and every later push in milliseconds would outrank it.
const MIN_PUSHED_AT = 1e12;

const isTrackId = (value) => TRACK_ID.test(String(value ?? ''));
const refusal = (code, message) => ({ refusal: [code, message] });

const REFUSAL_LEVEL = { PARENT_NOT_FOUND: 'warn', NOT_BACKFILLED: 'warn', RECORD_NOT_FOUND: 'info', PROJECT_NOT_FOUND: 'info' };

/** Nothing was written. Error, which the alert matches, unless Track expects the answer in normal running. */
function refuse(res, id, status, code, error, answerId = id) {
  const level = REFUSAL_LEVEL[code] || 'error';
  logger[level](`[track-push] refused id=${id} code=${code}`, { error });
  return res.status(status).json({ error, code, id: answerId });
}

/** The path segment is untrusted until it passes `TRACK_ID`, so it is encoded before it reaches the log. */
const refuseId = (res, id, code = 'PROJECT_ID_INVALID') =>
  refuse(res, encodeURIComponent(id), 400, code, 'The ids in the path must be positive integers');

/** A 500 with no detail in the body; only the log holds what went wrong. */
function failed(res, id, verb, err) {
  logger.error(`[track-push] ${verb} failed id=${id}`, { error: err.message, stack: err.stack });
  return res.status(500).json({ error: 'Internal server error', id });
}

// A stamp far ahead would make every real push look stale until the clock caught up.
const validStamp = (pushedAt) =>
  Number.isInteger(pushedAt) && pushedAt >= MIN_PUSHED_AT && pushedAt <= Date.now() + MAX_PUSH_AHEAD_MS;
const STAMP_REFUSAL = refusal('PUSHED_AT_INVALID', 'pushedAt must be integer epoch milliseconds, at most 5 minutes ahead');

/** The project record of `{ pushedAt, project }`, or a refusal; `id` is the path id, absent on POST. */
function projectRecord(body, id) {
  const { project, pushedAt } = body || {};
  if (!project || typeof project !== 'object' || !isTrackId(project.id)) {
    return refusal('PROJECT_ID_INVALID', 'body.project.id must be a positive integer');
  }
  if (id !== undefined && String(project.id) !== id) {
    return refusal('PROJECT_ID_MISMATCH', 'body.project.id must match the :id in the path');
  }
  if (!validStamp(pushedAt)) return STAMP_REFUSAL;
  // The row writer takes only the project's own fields; works arrive as their own records.
  const { works: _works, ...fields } = project;
  return { project: fields, pushedAt };
}

/** POST and PUT of a project row, created at level 1 when absent. */
async function writeProject(req, res, pathId) {
  const label = pathId ?? String((req.body && req.body.project && req.body.project.id) ?? '');
  try {
    const record = projectRecord(req.body, pathId);
    if (record.refusal) return refuse(res, encodeURIComponent(label), 400, ...record.refusal);
    const { project, pushedAt } = record;
    const id = String(project.id);

    const result = await writeTrackProject(project, { pushedAt });
    const { action, reason, held = [], stateMove = null } = result;
    const audit = (auditedAction) => auditEvent(req, {
      action: 'project.push',
      targetType: 'project',
      targetId: id,
      projectId: id,
      detail: { sourceSystem: 'track', action: auditedAction, pushedAt }
    });

    if (action === 'stale') {
      logger.info(`[track-push] stale id=${id}`, { [TRACK_PUSHED_AT]: pushedAt });
      return res.status(409).json({ error: 'A newer push for this project has already been written.', code: 'STALE_PUSH', id });
    }
    if (action === 'failed') {
      logger.error(`[track-push] write failed id=${id} status=${result.status}`);
      if (result.written) audit('relinked');
      return res.status(503).json({ error: RETRY, id });
    }
    if (action === 'skipped' && reason === 'createdBehind') {
      // Another push created the row after this one read none; sent again, this lands as an update. The writer warned.
      return res.status(409).json({ error: 'The project was created while this push ran. Send it again.', code: 'CREATED_BEHIND', id });
    }
    if (action === 'skipped') return res.json({ id, action, reason });

    logger.info(`[track-push] ${req.method === 'POST' ? 'post' : 'put'} id=${id} action=${action}`,
      { held, stateMove, [TRACK_PUSHED_AT]: pushedAt });
    if (WRITTEN_STATUS[action]) audit(action);
    return res.status(WRITTEN_STATUS[action] || 200).json({ id, action });
  } catch (err) {
    if (err.code === DUPLICATE_ID) {
      return refuse(res, label, 409, DUPLICATE_ID, 'This project\'s Eagle id is stored more than once. Nothing was written.');
    }
    return failed(res, encodeURIComponent(label), 'write', err);
  }
}

/** `POST /track/projects`: the id comes from the body. */
exports.postTrackProject = (req, res) => writeProject(req, res, undefined);

/** `PUT /track/projects/:id`. */
exports.putTrackProject = (req, res) => {
  const id = String(req.params.id);
  return isTrackId(id) ? writeProject(req, res, id) : refuseId(res, id);
};

/** Why a Track delete leaves this row alone: no Track source, DEMI's own, or linked to Eagle, whose admin must not feel it. */
function skipReason(row) {
  if (!(row.sources && row.sources.track)) return 'apiRow';
  if (isDemiOwnedProject(row)) return 'demiOwned';
  return row.sources.eagle ? 'eagleLinked' : null;
}

/** `DELETE /track/projects/:id`: unpublishes and keeps the row. Reads no body and no stamp. */
exports.deleteTrackProject = async (req, res) => {
  const id = String(req.params.id);
  if (!isTrackId(id)) return refuseId(res, id);
  try {
    const result = await deleteProjectRow(req, id, {
      // Unfiltered, like the Eagle push: a row hidden from this principal still has to come down.
      read: () => projects.readForWrite(id),
      marker: true,
      skip: skipReason,
      // A twin only ever sits beside a row holding `sources.eagle`, which `skipReason` leaves alone.
      twin: false,
      auditDetail: { sourceSystem: 'track' }
    });

    if (result.status === 'missing') {
      logger.info(`[track-push] delete found no row id=${id}`);
      return res.status(404).json({ error: 'Project not found', id });
    }
    if (result.status === 'conflict') {
      logger.error(`[track-push] delete lost its etag race id=${id}`);
      return res.status(503).json({ error: RETRY, id });
    }
    if (result.status === 'skipped') {
      logger.warn(`[track-push] delete skipped id=${id} reason=${result.reason}`);
      return res.json({ id, action: 'skipped', reason: result.reason });
    }
    if (result.status === 'failed') {
      logger.error(`[track-push] cascade owed id=${id}`, { error: result.error });
      return res.status(500).json({ success: false, error: result.error });
    }

    const { from } = result;
    // The level the row held, which the undo restores: restore, then PUT /projects/:id/level.
    if (from) logger.info(`[track-push] deleted id=${id}`, { priorLevel: levelOfRead(from.read) });
    return res.json({ id, action: from ? 'deleted' : 'unchanged' });
  } catch (err) {
    return failed(res, id, 'delete', err);
  }
};

/** Writer results that write nothing: `[status, code, message]`. */
const RECORD_REFUSALS = {
  [RESULT.STALE]: [409, 'STALE_PUSH', 'A newer push for this record has already been written.'],
  [RESULT.PARENT_NOT_FOUND]: [404, 'PARENT_NOT_FOUND', 'DEMI holds no live work or phase for this record.'],
  [RESULT.GONE]: [404, 'RECORD_NOT_FOUND', 'DEMI holds no live work with this record, so nothing is left to remove.'],
  [RESULT.PROJECT_NOT_FOUND]: [404, 'PROJECT_NOT_FOUND', 'Project not found'],
  [RESULT.NOT_BACKFILLED]: [409, 'NOT_BACKFILLED', 'DEMI does not take Track works yet.'],
  [RESULT.CONFLICT]: [503, 'WRITE_CONFLICT', RETRY],
  [RESULT.DERIVED_CONFLICT]: [503, 'DERIVED_CONFLICT', RETRY]
};
/** Writer results Track must not retry, answered 200 `skipped` with this `reason`. */
const RECORD_SKIPS = { [RESULT.API_ROW]: 'apiRow', [RESULT.ADOPTED]: 'adopted' };
// Track retries PARENT_NOT_FOUND once after 5 s, which covers a project row still in flight from another thread.
const PROJECT_PENDING = [404, 'PARENT_NOT_FOUND', 'DEMI holds no project row for this record yet.'];

/** The answer to a write that reached the writer; only a write a reader can see is audited. */
function answerRecord(req, res, { kind, method, pid, recordId, label, pushedAt }, { status, written }) {
  if (status === RESULT.APPLIED || written) {
    auditEvent(req, {
      action: 'project.push',
      targetType: kind,
      targetId: recordId,
      projectId: pid,
      detail: { sourceSystem: 'track', record: kind, method, pushedAt }
    });
  }
  if (status === RESULT.APPLIED) return res.json({ id: recordId, action: 'applied' });
  if (status === RESULT.UNCHANGED) return res.json({ id: recordId, action: 'unchanged' });
  if (RECORD_SKIPS[status]) {
    logger.warn(`[track-push] skipped id=${label} reason=${RECORD_SKIPS[status]}`);
    return res.json({ id: recordId, action: 'skipped', reason: RECORD_SKIPS[status] });
  }
  const [httpStatus, code, error] = status === RESULT.PROJECT_NOT_FOUND && method !== 'DELETE'
    ? PROJECT_PENDING : RECORD_REFUSALS[status];
  if (status === RESULT.STALE) logger.info(`[track-push] stale id=${label}`, { [TRACK_PUSHED_AT]: pushedAt });
  else if (status === RESULT.CONFLICT) {
    logger.error(`[track-push] ${method === 'DELETE' ? 'delete lost its etag race' : 'write failed'} id=${label}`);
  } else if (status !== RESULT.DERIVED_CONFLICT) return refuse(res, label, httpStatus, code, error, recordId);
  // The writer logged the lost derived patch.
  return res.status(httpStatus).json({ error, code, id: recordId });
}

/** Whether a new work carries its `phases[].events[]` lists; a missing one would clear the stored ones. */
const nestedListsOf = (work) =>
  Array.isArray(work.phases) && work.phases.every(phase => phase && Array.isArray(phase.events));

/** The ids nested in a new work that the merge stores or matches as sent; a string event `work_phase_id` drops it. */
const nestedIdsOf = (work) => work.phases.flatMap(phase =>
  [phase.id, ...phase.events.flatMap(event => [(event || {}).id, (event || {}).work_phase_id])]);

/** A child POST or PUT body checked against its path: `{ pushedAt, workTypeId }`, or a refusal. */
function childBody(kind, method, { pid, id }, body) {
  const { pushedAt, workTypeId, [kind]: record } = body || {};
  if (!record || typeof record !== 'object') return refusal('PAYLOAD_INVALID', `body.${kind} must be an object`);
  // A string id passes the path check but would never match the stored number, so the merge would add a twin.
  // The same holds for every id nested in a new work, checked below once its lists are known to exist.
  if (!Number.isInteger(record.id) || (method === 'POST' ? !isTrackId(record.id) : String(record.id) !== id)) {
    return refusal('RECORD_ID_MISMATCH', `body.${kind}.id must be a positive integer equal to any :id in the path`);
  }
  if (kind === 'work' && String(record.project_id) !== pid) {
    return refusal('PROJECT_ID_MISMATCH', 'body.work.project_id must match the :pid in the path');
  }
  if (!validStamp(pushedAt)) return STAMP_REFUSAL;
  if (!Number.isInteger(workTypeId) || workTypeId < 1) return refusal('WORK_TYPE_INVALID', 'workTypeId must be a positive integer');
  if (kind !== 'work' && !isTrackId(record.work_id)) {
    return refusal('PAYLOAD_INVALID', `body.${kind}.work_id must be a positive integer`);
  }
  if (kind === 'work' && method === 'POST' && !nestedListsOf(record)) {
    return refusal('PAYLOAD_INVALID', 'a new work must carry phases[], each with events[]');
  }
  if (kind === 'work' && method === 'POST' && !nestedIdsOf(record).every(Number.isInteger)) {
    return refusal('RECORD_ID_MISMATCH', 'every id in body.work.phases[] and their events[] must be an integer');
  }
  return { pushedAt, workTypeId };
}

/** A child DELETE's `?pushedAt=&workTypeId=`; both required, since an empty value would parse to 0. */
function childQuery(query = {}) {
  const pushedAt = /^\d+$/.test(String(query.pushedAt ?? '')) ? Number(query.pushedAt) : NaN;
  if (!validStamp(pushedAt)) return STAMP_REFUSAL;
  if (!isTrackId(query.workTypeId)) return refusal('WORK_TYPE_INVALID', 'workTypeId must be a positive integer');
  return { pushedAt, workTypeId: Number(query.workTypeId) };
}

/** One work, phase or event record written into its work document. */
const recordRoute = (kind, method) => async (req, res) => {
  const { pid } = req.params;
  const id = req.params.id === undefined ? undefined : String(req.params.id);
  if (!isTrackId(pid)) return refuseId(res, pid);
  if (id !== undefined && !isTrackId(id)) return refuseId(res, id, 'RECORD_ID_INVALID');

  const checked = method === 'DELETE' ? childQuery(req.query) : childBody(kind, method, { pid, id }, req.body);
  const recordId = id ?? String((((req.body || {})[kind]) || {}).id ?? '');
  const label = `${pid}/${kind}:${encodeURIComponent(recordId)}`;
  if (checked.refusal) return refuse(res, label, 400, ...checked.refusal, recordId);
  const { pushedAt, workTypeId } = checked;
  // The nightly leaves these work types out of DEMI, so their records have nowhere to land.
  if (!isMirrored({ work_type_id: workTypeId })) {
    logger.info(`[track-push] skipped id=${label} reason=unmirrored workTypeId=${workTypeId}`);
    return res.json({ id: recordId, action: 'skipped', reason: 'unmirrored' });
  }

  try {
    const body = method === 'DELETE' ? { pushedAt, workTypeId, id } : req.body;
    const result = await writeTrackRecord(kind, method, pid, body);
    return answerRecord(req, res, { kind, method, pid, recordId, label, pushedAt }, result);
  } catch (err) {
    return failed(res, label, method.toLowerCase(), err);
  }
};

exports.postTrackWork = recordRoute('work', 'POST');
exports.putTrackWork = recordRoute('work', 'PUT');
exports.deleteTrackWork = recordRoute('work', 'DELETE');
exports.postTrackPhase = recordRoute('phase', 'POST');
exports.putTrackPhase = recordRoute('phase', 'PUT');
exports.deleteTrackPhase = recordRoute('phase', 'DELETE');
exports.postTrackEvent = recordRoute('event', 'POST');
exports.putTrackEvent = recordRoute('event', 'PUT');
exports.deleteTrackEvent = recordRoute('event', 'DELETE');
