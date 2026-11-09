'use strict';

// Track's writes as they commit: `PUT` and `DELETE /track/projects/:id`, under the nightly run's merge rules.
// Every failure logs a `[track-push]` line at error, which the alert matches.

const projects = require('../../repositories/projects');
const { levelOfRead } = require('../../helpers/access-sql');
const { DUPLICATE_ID } = require('../../helpers/duplicate-id');
const { isDemiOwnedProject } = require('../../merge/project');
const { trackPushToSync } = require('../../seed/sources');
const { TRACK_PUSHED_AT, writeTrackProject } = require('../../scripts/sync-track-projects');
const { logger } = require('../../utils/logger');
const { auditEvent } = require('../../utils/audit');
const { deleteProjectRow } = require('./project');

const WRITTEN_STATUS = { created: 201, relinked: 201, updated: 200 };
const RETRY = 'The record is being written by another request. Try again.';

/** Logged at error: nothing was written. */
function refuse(res, id, status, code, error) {
  logger.error(`[track-push] refused id=${id} code=${code}`, { error });
  return res.status(status).json({ error, code, id });
}

/** A 500 with no detail in the body; only the log holds what went wrong. */
function failed(res, id, verb, err) {
  logger.error(`[track-push] ${verb} failed id=${id}`, { error: err.message, stack: err.stack });
  return res.status(500).json({ error: 'Internal server error', id });
}

/** `{ project, pushedAt }`, or `{ refusal: [code, message] }` when the body and path disagree. */
function trackPush(id, body) {
  const { project, pushedAt } = body || {};
  if (!project || typeof project !== 'object' || String(project.id ?? '') !== id) {
    return { refusal: ['PROJECT_ID_MISMATCH', 'body.project.id must match the :id in the path'] };
  }
  if (!Number.isFinite(pushedAt)) {
    return { refusal: ['PUSHED_AT_INVALID', 'body.pushedAt must be epoch milliseconds'] };
  }
  return { project, pushedAt };
}

/** `PUT /track/projects/:id`: creates the row when absent. */
exports.putTrackProject = async (req, res) => {
  const id = String(req.params.id);
  try {
    const push = trackPush(id, req.body);
    if (push.refusal) return refuse(res, id, 400, ...push.refusal);

    let mapped;
    try {
      mapped = trackPushToSync(push.project);
    } catch (err) {
      return refuse(res, id, 400, 'PAYLOAD_INVALID', err.message);
    }

    const { pushedAt } = push;
    const { project, phases, works } = mapped;
    const result = await writeTrackProject(project, { phases, works, pushedAt });
    const { action, reason, held = [], stateMove = null } = result;

    if (action === 'stale') {
      logger.info(`[track-push] stale id=${id}`, { [TRACK_PUSHED_AT]: pushedAt });
      return res.status(409).json({ error: 'A newer push for this project has already been written.', code: 'STALE_PUSH', id });
    }
    if (action === 'failed') {
      logger.error(`[track-push] write failed id=${id} status=${result.status}`);
      return res.status(503).json({ error: RETRY, id });
    }
    if (action === 'skipped' && reason === 'createdBehind') {
      // Another push created the row after this one read none; sent again, this lands as an update.
      return refuse(res, id, 409, 'CREATED_BEHIND', 'The project was created while this push ran. Send it again.');
    }
    if (action === 'skipped') return res.json({ id, action, reason });

    logger.info(`[track-push] put id=${id} action=${action}`, { held, stateMove, [TRACK_PUSHED_AT]: pushedAt });
    if (WRITTEN_STATUS[action]) {
      auditEvent(req, {
        action: 'project.push',
        targetType: 'project',
        targetId: id,
        projectId: id,
        detail: { sourceSystem: 'track', action, pushedAt }
      });
    }
    return res.status(WRITTEN_STATUS[action] || 200).json({ id, action });
  } catch (err) {
    if (err.code === DUPLICATE_ID) {
      return refuse(res, id, 409, DUPLICATE_ID, 'This project\'s Eagle id is stored more than once. Nothing was written.');
    }
    return failed(res, id, 'put', err);
  }
};

/** Why a Track delete leaves this row alone: an API or native row has no Track source, an owned row is DEMI's. */
function skipReason(row) {
  if (!(row.sources && row.sources.track)) return 'apiRow';
  return isDemiOwnedProject(row) ? 'demiOwned' : null;
}

/** `DELETE /track/projects/:id`: unpublishes and keeps the row. Reads no body and no stamp. */
exports.deleteTrackProject = async (req, res) => {
  const id = String(req.params.id);
  try {
    const result = await deleteProjectRow(req, id, {
      // Unfiltered, like the Eagle push: a row hidden from this principal still has to come down.
      read: () => projects.readForWrite(id),
      takeOver: false,
      marker: true,
      skip: skipReason
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
      logger.error(`[track-push] ${result.stage} owed id=${id}`, { error: result.error });
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
