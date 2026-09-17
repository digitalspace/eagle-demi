'use strict';

/**
 * Apply the committed search definitions from inside the Function app. Producer and handler
 * together, the same shape as src/jobs/restamp-chunks.js.
 *
 * WHY A QUEUE. The apply PUTs indexes and indexers, then resets and runs the indexers and waits
 * for them. A full chunks rebuild runs for hours and the platform cuts an HTTP request off at
 * about 230 seconds, so the route can only accept the work and hand back a job id.
 *
 * WHAT IT REPLACES. The same steps used to run on demi-devbox through `az vm run-command invoke`,
 * where every call is a 20-45 s ARM long poll. docs/runbook-search-outage.md keeps the devbox
 * recipe as break-glass for when this app itself is broken.
 *
 * THE ROLE IS STILL THE CONSTRAINT: writing definitions needs Search Service Contributor at the
 * service scope, which this app's identity is not meant to hold permanently. A run outside a grant
 * window fails on the first PUT with the 403 apply-search-definitions.js explains.
 */

const crypto = require('crypto');

const config = require('../config');
const { queueClientFor } = require('./queue-client');
const jobs = require('../repositories/bulk-downloads');
const aiSearch = require('../search/ai-search');
const apply = require('../scripts/apply-search-definitions');
const datasources = require('../scripts/put-search-datasources');
// Required as MODULES, not destructured: a destructured binding cannot be replaced by `t.mock`,
// and these three are what a test stands in for (src/scripts/apply-search-definitions.js says the
// same about aiSearch).
const resetIndexers = require('../scripts/reset-and-run-indexers');
const { logger } = require('../utils/logger');

/**
 * Job rows share the `bulkDownloads` container, so the id says which kind of row this is. The
 * prefix is what keeps these rows off GET /bulk-downloads/:id, whose id check is a bare UUID —
 * the same trick the `quota:` rows in that container use.
 */
const JOB_PREFIX = 'searchdef:';

// A finished job is never re-run: a redelivered message for one has nothing left to do.
const TERMINAL = ['succeeded', 'failed', 'warned'];

// Step lines kept ON THE ROW. The apply report is the first few dozen; everything after that is
// poll lines, so the head is what a reader wants and the tail is what gets dropped. Every line
// also goes to the log, which is where a full transcript lives.
const MAX_STEPS = 200;

// Shorter than host.json's 30-minute functionTimeout on purpose: the wait has to end while this
// invocation can still write the row. At the ceiling the host kills the worker mid-write and the
// job stays `running` with nothing coming to finish it.
const WAIT_TIMEOUT_MS = 25 * 60 * 1000;

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

/**
 * The definition names a request may ask for: an index (`chunks`), or its indexer
 * (`chunks-indexer`), because `--only` has always accepted either.
 */
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

async function enqueue(jobId) {
  // `messageEncoding: "none"` (host.json): the body is the bare job id, as the zip worker's is.
  await queueClient().sendMessage(String(jobId));
}

/**
 * The row a request creates, `queued`, before its message is sent.
 *
 * `request` is the whole of what the handler acts on — it re-reads the row rather than trusting a
 * message body, so a redelivery cannot change what was asked for.
 */
function newJob({ only, datasources: dataSourceNames, live, check, requesterId }) {
  return {
    id: `${JOB_PREFIX}${crypto.randomUUID()}`,
    kind: 'searchDefinitions',
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
 * Collect the step lines: onto the row (bounded), into the log (all of them), and into the result
 * table when the line is one of reset-and-run-indexers.js's verdicts.
 *
 * Those `DEMI_*` lines are that script's reporting contract — demi-devbox.sh reads the same ones
 * off a run-command transcript.
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
    const warn = /^DEMI_WARN (\S+)/.exec(line);
    if (warn) {
      warned = true;
      results.push({ indexer: warn[1], status: 'stillRunning' });
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

/** What the app is serving from right now — the names `run()` refuses to PUT non-additively over. */
function servingNames(cfg) {
  return [cfg.index, cfg.projectsIndex, cfg.documentsIndex, cfg.activitiesIndex, cfg.notificationsIndex];
}

/**
 * One job, start to finish.
 *
 * REDELIVERY IS THE CASE THIS IS SHAPED AROUND. A queue message can arrive again — the host
 * redelivers after a worker recycle — and a second reset would throw away the high-water mark of
 * an indexer already rebuilding, which for chunks is hours of work. So `resetIssuedAt` is written
 * BEFORE the reset, and a redelivery that finds it skips the apply and the reset and only watches
 * the executions the first delivery started.
 *
 * Failures do NOT rethrow. The queue's retry is the wrong tool here: a half-applied definition set
 * needs a human to look at the row, and a retry that re-PUT and re-reset would cost another
 * rebuild. The row carries the verdict and the steps that led to it.
 */
async function run(jobId, { attempt = 1, maxAttempts = 1 } = {}) {
  const id = String(jobId);
  const job = await jobs.getById(id);
  if (!job) {
    logger.error(`[search-definitions] no job row for ${id} (attempt ${attempt}/${maxAttempts})`);
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
    await jobs.patch(id, { status: 'running', startedAt: new Date().toISOString() });

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
    } else {
      // ONE `run()` PER NAME. The script's `--only` takes a single definition, and a list has to
      // fail before the first PUT rather than partway through, which is the guard it already runs
      // per call.
      for (const name of only.length > 0 ? only : ['']) {
        await apply.run({
          endpoint, live: Boolean(request.live), only: name,
          liveNames: servingNames(cfg), log: out.log
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
  JOB_PREFIX, WAIT_TIMEOUT_MS,
  enabled, enqueue, newJob, knownNames, knownDataSourceNames, indexersFor, run
};
