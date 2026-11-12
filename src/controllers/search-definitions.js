'use strict';

/**
 * Search definition apply: validate, record and enqueue (src/jobs/search-definitions.js), then poll.
 * Sysadmin-gated, unlike bulk download, because the request decides what the search service serves.
 */

const jobs = require('../repositories/bulk-downloads');
const searchDefinitions = require('../jobs/search-definitions');
const { serverError } = require('../helpers/response');
const { logger } = require('../utils/logger');
// Required as a MODULE, not destructured: the test replaces it with `t.mock.method`, which cannot
// reach a destructured binding.
const audit = require('../utils/audit');

// Stricter than a shrug at unknown keys: a misspelled `datasource` would silently apply nothing to
// the data sources and report success, which is the failure mode this whole path exists to end.
const ALLOWED_BODY_KEYS = ['only', 'datasources', 'live', 'check'];

// Checked before names are read: the 400 echoes unknown entries, and each `only` entry is a run.
const MAX_NAMES = 20;
// Twice the longest name the package carries; bounds what the unknown-name 400 can echo back.
const MAX_NAME_LENGTH = 64;

/** A list of known names, deduplicated, or the 400 that says what is wrong with it. */
function names(value, field, known) {
  if (value === undefined) return { value: [] };
  if (!Array.isArray(value)) return { error: `${field} must be an array of names.` };
  if (value.length > MAX_NAMES) {
    return { error: `${field} takes at most ${MAX_NAMES} names.` };
  }
  if (value.some(name => typeof name === 'string' && name.length > MAX_NAME_LENGTH)) {
    return { error: `${field} names are at most ${MAX_NAME_LENGTH} characters.` };
  }
  const unknown = value.filter(name => typeof name !== 'string' || !known.includes(name));
  if (unknown.length > 0) {
    return { error: `${field} names nothing this package carries: ${unknown.join(', ')}. Known: ${known.join(', ')}.` };
  }
  // A repeat is not a second thing to do: the job PUTs once per entry, so `['chunks','chunks']`
  // would apply and reset the same indexer twice.
  return { value: [...new Set(value)] };
}

function flag(value, field) {
  if (value === undefined) return { value: false };
  if (typeof value !== 'boolean') return { error: `${field} must be true or false.` };
  return { value };
}

const APPLY_EVENT = { action: 'searchDefinitions.apply', targetType: 'searchDefinitions' };

/** Every refused apply is audited too, so probing the route leaves a durable trace. */
function refuse(req, res, status, payload, targetId) {
  audit.auditEvent(req, {
    ...APPLY_EVENT, outcome: 'failure', targetId, detail: { status, error: payload.error }
  });
  return res.status(status).json(payload);
}

exports.applySearchDefinitions = async (req, res) => {
  try {
    const body = (req && req.body) || {};
    const badRequest = error => refuse(req, res, 400, { error });

    const unknown = Object.keys(body).filter(key => !ALLOWED_BODY_KEYS.includes(key));
    if (unknown.length > 0) return badRequest(`Unknown body parameter(s): ${unknown.join(', ')}`);

    const only = names(body.only, 'only', searchDefinitions.knownNames());
    if (only.error) return badRequest(only.error);
    const datasources = names(body.datasources, 'datasources', searchDefinitions.knownDataSourceNames());
    if (datasources.error) return badRequest(datasources.error);
    const live = flag(body.live, 'live');
    if (live.error) return badRequest(live.error);
    const check = flag(body.check, 'check');
    if (check.error) return badRequest(check.error);

    // Refused together, as in the CLI: `check` writes nothing and `live` PUTs.
    if (live.value && check.value) return badRequest('live and check are mutually exclusive.');
    if (check.value && datasources.value.length > 0) {
      return badRequest('check writes nothing, so it cannot take datasources.');
    }

    // An empty `only` on a live run resets every indexer, chunks included: hours of partial search.
    if (live.value && only.value.length === 0) {
      return badRequest(
        'live needs a non-empty only list: applying everything resets every indexer, chunks included.');
    }

    if (!searchDefinitions.enabled()) {
      return refuse(req, res, 503, { error: 'search definition apply disabled' });
    }

    // One apply at a time: a second reset discards the first run's high-water mark. Stale rows
    // are skipped, else a killed worker's `running` row would block applies for its whole TTL.
    const active = (await jobs.listActiveSearchDefinitionJobs())
      .filter(job => !searchDefinitions.isStale(job));
    if (active.length > 0) {
      const running = active[0];
      return refuse(req, res, 409, {
        error: `a search definition apply is already ${running.status}.`,
        jobId: String(running.id).slice(searchDefinitions.JOB_PREFIX.length)
      }, running.id);
    }

    const user = (req && req.user) || {};
    const job = searchDefinitions.newJob({
      only: only.value,
      datasources: datasources.value,
      live: live.value,
      check: check.value,
      requesterId: String(user.keyId || user.sub || user.preferred_username || '')
    });

    // Row first, then message: a dequeued id with no row cannot run, but a lost message can be requeued.
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
      return refuse(req, res, 503, { error: 'search definition apply could not be queued' }, job.id);
    }

    logger.info(`[search-definitions] job queued job=${job.id} only=${only.value.join(',') || 'all'} ` +
      `live=${live.value} check=${check.value}`);

    // Audited only once queued, with the stored row id; this privileged action belongs in
    // EagleAudit_CL beside apikey.create, not only the short-lived app log.
    audit.auditEvent(req, {
      ...APPLY_EVENT,
      targetId: job.id,
      detail: {
        only: only.value,
        datasources: datasources.value,
        live: live.value,
        check: check.value
      }
    });

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
