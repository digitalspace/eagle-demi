'use strict';

/**
 * Queue producer and handler that apply the committed search definitions; a chunks rebuild outlives
 * an HTTP request. Needs Search Service Contributor, so a run outside a grant window gets a 403.
 */

const crypto = require('crypto');

const config = require('../config');
const { queueClientFor } = require('./queue-client');
const jobs = require('../repositories/bulk-downloads');
const aiSearch = require('../search/ai-search');
const apply = require('../scripts/apply-search-definitions');
const datasources = require('../scripts/put-search-datasources');
// Required as modules, not destructured, so tests can stand in for them with `t.mock`.
const resetIndexers = require('../scripts/reset-and-run-indexers');
const { logger } = require('../utils/logger');

// Job rows share `bulkDownloads`; the prefix keeps them off GET /bulk-downloads/:id (bare UUID).
const JOB_PREFIX = jobs.SEARCH_DEF_PREFIX;

// The kind is checked too: `run()` resets indexers only for a row this module recorded.
const JOB_KIND = jobs.SEARCH_DEF_KIND;

// A finished job is never re-run: a redelivered message for one has nothing left to do.
const TERMINAL = ['succeeded', 'failed', 'warned'];

// Step lines kept on the row; the head is the apply report, the tail poll lines. The log has all.
const MAX_STEPS = 200;

// Under host.json's 30-minute functionTimeout, so the wait ends while this invocation can still
// write the row; at the ceiling the host kills it mid-write and the job stays `running`.
const WAIT_TIMEOUT_MS = 25 * 60 * 1000;

// Past the wait ceiling plus a margin for queue handoff and the final patch, a worker is dead.
const STALE_AFTER_MS = WAIT_TIMEOUT_MS + 10 * 60 * 1000;

const SECONDS_PER_DAY = 24 * 60 * 60;

/** Whether the queue exists to send to — the NAME, the setting api/index.js guards the trigger on. */
function enabled() {
  return Boolean(config.searchDefinitionsQueue);
}

function queueClient() {
  return queueClientFor({
    name: config.searchDefinitionsQueue,
    setting: 'SEARCH_DEFINITIONS_QUEUE',
    feature: 'search definition apply'
  });
}

/** The definition names a request may ask for: an index (`chunks`) or its indexer (`chunks-indexer`). */
function knownNames() {
  return [
    ...apply.load(apply.INDEX_DIR).map(d => d.body.name),
    ...apply.load(apply.INDEXER_DIR).map(d => d.body.name)
  ];
}

/** The data sources this package carries. Nothing else may be PUT: there is no committed copy. */
function knownDataSourceNames() {
  return apply.load(apply.DATASOURCE_DIR).map(d => d.body.name);
}

/**
 * Is this `queued` or `running` row one nothing works on, such as a killed worker's? A row with no
 * readable stamp is not stale: a refused apply costs a retry, a second one resets a rebuild.
 */
function isStale(job, now = Date.now()) {
  if (!job) return false;
  // `queued` has never started, so its own age is what says the message was never picked up.
  const stamp = job.status === 'queued' ? job.createdAt : (job.startedAt || job.createdAt);
  const at = Date.parse(stamp || '');
  if (!Number.isFinite(at)) return false;
  return now - at > STALE_AFTER_MS;
}

async function enqueue(jobId) {
  // `messageEncoding: "none"` (host.json): the body is the bare job id, as the zip worker's is.
  await queueClient().sendMessage(String(jobId));
}

/**
 * The `queued` row a request creates. The handler re-reads `request` from the row, never the message
 * body, so a redelivery cannot change what was asked for.
 */
function newJob({ only, datasources: dataSourceNames, live, check, requesterId }) {
  return {
    id: `${JOB_PREFIX}${crypto.randomUUID()}`,
    kind: JOB_KIND,
    status: 'queued',
    request: { only, datasources: dataSourceNames, live, check },
    requesterId,
    steps: [],
    results: [],
    createdAt: new Date().toISOString(),
    ttl: config.bulkJobTtlDays * SECONDS_PER_DAY
  };
}

/**
 * Step lines go onto the row (bounded), into the log, and into results when they are
 * reset-and-run-indexers.js `DEMI_*` verdicts, the contract demi-devbox.sh also reads.
 */
function sink(jobId) {
  const steps = [];
  const results = [];
  let dropped = 0;
  let warned = false;

  const record = (line) => {
    const result = /^DEMI_RESULT name=(\S+) status=(\S+) items=(\S+) failed=(\S+) tracking=(\S+)/.exec(line);
    if (result) {
      results.push({
        indexer: result[1], status: result[2],
        itemsProcessed: result[3], itemsFailed: result[4], tracking: result[5]
      });
      return;
    }
    const warn = /^DEMI_WARN (\S+) ?(.*)/.exec(line);
    if (warn) {
      warned = true;
      results.push(warn[2].includes('still running')
        ? { indexer: warn[1], status: 'stillRunning' }
        : { indexer: warn[1], status: 'warned', message: warn[2] });
      return;
    }
    const noWait = /^DEMI_NOWAIT (\S+)/.exec(line);
    if (noWait) results.push({ indexer: noWait[1], status: 'started' });
  };

  const log = (...parts) => {
    const line = parts.join(' ');
    if (steps.length < MAX_STEPS) steps.push(line); else dropped++;
    record(line);
    logger.info(`[search-definitions] ${jobId} ${line}`);
  };

  return { log, steps, results, get dropped() { return dropped; }, get warned() { return warned; } };
}

/** The indexers a request's `only` list selects, deduplicated, in definition order. */
function indexersFor(only) {
  if (only.length === 0) return apply.load(apply.INDEXER_DIR).map(d => d.body.name);
  const names = new Set();
  for (const name of only) {
    for (const d of apply.select(name).indexers) names.add(d.body.name);
  }
  return [...names];
}

/**
 * One job. `resetIssuedAt` is written before the reset, so a redelivery only watches. Failures never
 * rethrow: a queue retry would re-PUT and re-reset; the row carries the verdict for a person.
 */
async function run(jobId, { attempt = 1, maxAttempts = 1 } = {}) {
  const id = String(jobId);
  // The zip queue reads the same container, so a non-prefixed id is dropped before any read; the
  // handler must never patch another worker's row.
  if (!id.startsWith(JOB_PREFIX)) {
    logger.error(`[search-definitions] refusing a message that is not a ${JOB_PREFIX} job id: ${id}`);
    return;
  }
  const job = await jobs.getById(id);
  if (!job) {
    logger.error(`[search-definitions] no job row for ${id} (attempt ${attempt}/${maxAttempts})`);
    return;
  }
  // The id got past the prefix check, so this is a row somebody wrote with a colliding id rather
  // than a job this module created. Refused before the first patch, for the same reason.
  if (job.kind !== JOB_KIND) {
    logger.error(`[search-definitions] ${id} is not a ${JOB_KIND} row (kind=${job.kind}) — refusing`);
    return;
  }
  if (TERMINAL.includes(job.status)) {
    logger.info(`[search-definitions] ${id} is already ${job.status}; nothing to do`);
    return;
  }

  const request = job.request || {};
  const only = Array.isArray(request.only) ? request.only : [];
  const out = sink(id);
  // Set once the first delivery got as far as the reset. Its presence, not the status, is what
  // says the indexers are already rebuilding.
  const resuming = Boolean(job.resetIssuedAt);

  const finish = async (status, extra = {}) => {
    await jobs.patch(id, {
      status,
      steps: out.steps,
      stepsDropped: out.dropped,
      results: out.results,
      finishedAt: new Date().toISOString(),
      ...extra
    });
    logger.info(`[search-definitions] ${id} ${status}`);
  };

  try {
    // The route refuses this pair, so such a row was written elsewhere; it would reset every indexer.
    if (request.live && only.length === 0) {
      await finish('failed', {
        error: 'live needs a non-empty only list: applying everything resets every indexer, chunks included.'
      });
      return;
    }

    // Claimed, not stamped, so a redelivery cannot start a second apply. A redelivery past the
    // reset stamp takes the resume path instead.
    if (!resuming) {
      const claimed = await jobs.patchIfStatus(
        id, { status: 'running', startedAt: new Date().toISOString() }, ['queued']
      );
      if (!claimed) {
        logger.warn(`[search-definitions] ${id} is not queued any more — another delivery has it; ` +
          'dropping this message');
        return;
      }
    }

    const cfg = aiSearch.config();
    if (!cfg.configured) throw new Error('SEARCH_ENDPOINT is not set — nothing to apply against');
    const endpoint = cfg.endpoint.replace(/\/$/, '');

    if (request.check) {
      let drifted = 0;
      for (const name of only.length > 0 ? only : ['']) {
        drifted += await apply.runCheck({ endpoint, only: name, log: out.log });
      }
      await finish(drifted > 0 ? 'warned' : 'succeeded', { drifted });
      return;
    }

    if (resuming) {
      out.log(`resumed after redelivery: the reset was issued at ${job.resetIssuedAt}, watching only`);
      // `isStale` dates a running row from `startedAt`; the original stamp would let a long resume
      // look dead to the 409 guard while this worker still watches.
      await jobs.patch(id, { startedAt: new Date().toISOString(), steps: out.steps });
    } else {
      // One `run()` per name: `--only` takes a single definition.
      for (const name of only.length > 0 ? only : ['']) {
        await apply.run({
          endpoint, live: Boolean(request.live), only: name,
          liveNames: apply.servingNames(cfg), log: out.log
        });
      }

      const dataSourceNames = Array.isArray(request.datasources) ? request.datasources : [];
      if (dataSourceNames.length > 0 && request.live) {
        await datasources.putDataSources({ names: dataSourceNames, log: out.log });
      } else if (dataSourceNames.length > 0) {
        out.log(`dry run — data sources ${dataSourceNames.join(', ')} were not written`);
      }
    }

    if (!request.live) {
      await finish('succeeded');
      return;
    }

    const names = indexersFor(only);
    if (names.length === 0) {
      await finish(out.warned ? 'warned' : 'succeeded');
      return;
    }

    // The stamp goes down BEFORE the first reset and is never rewritten, so a redelivery at any
    // point past this line watches instead of resetting.
    if (!resuming) {
      await jobs.patch(id, { resetIssuedAt: new Date().toISOString(), steps: out.steps });
    }

    const code = await resetIndexers.resetAndRun({
      names,
      endpoint,
      token: await aiSearch.getToken(),
      log: out.log,
      timeoutMs: WAIT_TIMEOUT_MS,
      mode: resuming ? 'watch' : 'reset'
    });

    if (code !== 0) {
      await finish('failed', { error: 'an indexer did not finish cleanly — see steps' });
      return;
    }
    await finish(out.warned ? 'warned' : 'succeeded');
  } catch (err) {
    logger.error(`[search-definitions] ${id} failed: ${err.message}`, {
      error: err.message, stack: err.stack
    });
    await finish('failed', { error: err.message }).catch(patchErr => logger.error(
      `[search-definitions] ${id} could not be marked failed: ${patchErr.message}`
    ));
  }
}

module.exports = {
  JOB_PREFIX, JOB_KIND, WAIT_TIMEOUT_MS, STALE_AFTER_MS,
  enabled, enqueue, newJob, knownNames, knownDataSourceNames, indexersFor, isStale, run
};
