'use strict';

/**
 * Search definition apply — submit a run, poll it.
 *
 * The run PUTs indexes and indexers and then rebuilds them, which takes minutes for `projects` and
 * hours for `chunks`, so this side only validates, records the job and enqueues it
 * (src/jobs/search-definitions.js). Unlike a bulk download the job id is NOT a capability: every
 * route here is sysadmin-gated, because the request decides what the search service serves.
 */

const jobs = require('../repositories/bulk-downloads');
const searchDefinitions = require('../jobs/search-definitions');
const { serverError } = require('../helpers/response');
const { logger } = require('../utils/logger');

// Stricter than a shrug at unknown keys: a misspelled `datasource` would silently apply nothing to
// the data sources and report success, which is the failure mode this whole path exists to end.
const ALLOWED_BODY_KEYS = ['only', 'datasources', 'live', 'check'];

/** A list of known names, or the 400 that says which one is not known. */
function names(value, field, known) {
  if (value === undefined) return { value: [] };
  if (!Array.isArray(value)) return { error: `${field} must be an array of names.` };
  const unknown = value.filter(name => typeof name !== 'string' || !known.includes(name));
  if (unknown.length > 0) {
    return { error: `${field} names nothing this package carries: ${unknown.join(', ')}. Known: ${known.join(', ')}.` };
  }
  return { value };
}

function flag(value, field) {
  if (value === undefined) return { value: false };
  if (typeof value !== 'boolean') return { error: `${field} must be true or false.` };
  return { value };
}

exports.applySearchDefinitions = async (req, res) => {
  try {
    const body = (req && req.body) || {};

    const unknown = Object.keys(body).filter(key => !ALLOWED_BODY_KEYS.includes(key));
    if (unknown.length > 0) {
      return res.status(400).json({ error: `Unknown body parameter(s): ${unknown.join(', ')}` });
    }

    const only = names(body.only, 'only', searchDefinitions.knownNames());
    if (only.error) return res.status(400).json({ error: only.error });
    const datasources = names(body.datasources, 'datasources', searchDefinitions.knownDataSourceNames());
    if (datasources.error) return res.status(400).json({ error: datasources.error });
    const live = flag(body.live, 'live');
    if (live.error) return res.status(400).json({ error: live.error });
    const check = flag(body.check, 'check');
    if (check.error) return res.status(400).json({ error: check.error });

    // The same pair the CLI refuses together: `check` reads the live schema and writes nothing,
    // `live` PUTs. Accepting both would make the flag that decided what happened whichever branch
    // the job looked at first.
    if (live.value && check.value) {
      return res.status(400).json({ error: 'live and check are mutually exclusive.' });
    }
    if (check.value && datasources.value.length > 0) {
      return res.status(400).json({ error: 'check writes nothing, so it cannot take datasources.' });
    }

    if (!searchDefinitions.enabled()) {
      return res.status(503).json({ error: 'search definition apply disabled' });
    }

    const user = (req && req.user) || {};
    const job = searchDefinitions.newJob({
      only: only.value,
      datasources: datasources.value,
      live: live.value,
      check: check.value,
      requesterId: String(user.keyId || user.sub || user.preferred_username || '')
    });

    // Row FIRST, then the message, for the reason the zip controller does it in that order: a
    // worker that dequeues an id with no row can only give up, whereas a message that never
    // arrives leaves a queued row somebody can requeue.
    const saved = await jobs.create(job);
    const id = job.id.slice(searchDefinitions.JOB_PREFIX.length);
    try {
      await searchDefinitions.enqueue(job.id);
    } catch (err) {
      logger.error(`[search-definitions] could not enqueue ${job.id}: ${err.message}`, {
        error: err.message, stack: err.stack
      });
      await jobs.patch(job.id, {
        status: 'failed', error: 'enqueue failed', finishedAt: new Date().toISOString()
      }).catch(() => {});
      return res.status(503).json({ error: 'search definition apply could not be queued' });
    }

    logger.info(`[search-definitions] job queued job=${job.id} only=${only.value.join(',') || 'all'} ` +
      `live=${live.value} check=${check.value}`);

    return res.status(202).json({
      jobId: id,
      status: (saved && saved.status) || job.status,
      request: job.request,
      statusUrl: `/api/admin/search-definitions/jobs/${id}`
    });
  } catch (err) {
    return serverError(res, err, 'search definitions controller failed');
  }
};

exports.getSearchDefinitionJob = async (req, res) => {
  try {
    const id = String((req.params && req.params.id) || '');
    // The stored id carries the prefix that keeps these rows off the bulk-download route; a caller
    // only ever sees the UUID, so an id that is not one cannot name a row at all.
    if (!jobs.JOB_ID.test(id)) {
      return res.status(404).json({ error: 'Search definition job not found' });
    }
    const job = await jobs.getById(`${searchDefinitions.JOB_PREFIX}${id}`);
    if (!job) {
      return res.status(404).json({ error: 'Search definition job not found' });
    }

    return res.json({
      jobId: id,
      status: job.status,
      request: job.request || null,
      steps: job.steps || [],
      stepsDropped: job.stepsDropped || 0,
      results: job.results || [],
      error: job.error || null,
      createdAt: job.createdAt || null,
      startedAt: job.startedAt || null,
      resetIssuedAt: job.resetIssuedAt || null,
      finishedAt: job.finishedAt || null
    });
  } catch (err) {
    return serverError(res, err, 'search definitions controller failed');
  }
};
