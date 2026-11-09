'use strict';

// Must run before any other require: the distro hooks `require`, so modules loaded earlier never
// report. Winston instrumentation is opt-in and is what carries logger output to Application Insights.
if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  const { useAzureMonitor } = require('@azure/monitor-opentelemetry');
  useAzureMonitor({
    // Counters duplicate free platform metrics and were the largest ingest table. Standard metrics
    // stay on: the Performance and Failures blades read them.
    enablePerformanceCounters: false,
    instrumentationOptions: {
      winston: { enabled: true }
    }
  });
}

const { app } = require('@azure/functions');

// Streaming response bodies for document downloads; needs @azure/functions 4.3.0+ and runtime 4.28+.
app.setup({ enableHttpStream: true });

// Exported for the timer and trigger test suites; the host is the only other caller.
module.exports = {
  reconcileEagle, reconcileEngage, syncTrackTeams, syncTrackProjects, bulkDownloadWorker,
  cleanupBulkDownloads, restampChunksWorker, searchDefinitionsWorker, syncOutWorker,
  announceUpdates, edgeBan, intakeScanSweep
};

// The audit buffer flushes on an unref()'d timer, so a host recycle loses it. appTerminate runs on
// graceful shutdown only, so this narrows the loss window rather than closing it.
app.hook.appTerminate(async () => {
  const { flush } = require('../src/utils/audit');
  await flush();
});

// One catch-all: the host matches routes in discovery order, not by specificity. The lazy require
// lets the timer tests load this file against a recording `app`.
const handler = (request, context) => require('../src/http/router').dispatch(request, context);

const HTTP = {
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
  authLevel: 'anonymous',
  handler
};

app.http('api', { ...HTTP, route: '{*path}' });
app.http('apiRoot', { ...HTTP, route: '' });

// Each trigger below registers only when its setting is set: the host resolves `%NAME%` at startup,
// and an unresolvable name is a startup error that takes the HTTP functions down too.
if (process.env.RECONCILE_SCHEDULE) {
  app.timer('reconcileEagle', {
    // The setting's name, not its value, so changing the app setting reschedules without a deploy.
    schedule: '%RECONCILE_SCHEDULE%',
    // Deploys restart this app, and a restart must not re-read the whole Eagle corpus.
    runOnStartup: false,
    handler: reconcileEagle
  });
}

// Report only: `--repair` stays a hand run, since it re-sends rows to Eagle.
if (require('../src/config').reconcileEngageSchedule) {
  app.timer('reconcileEngage', {
    schedule: '%RECONCILE_ENGAGE_SCHEDULE%',
    runOnStartup: false,
    handler: reconcileEngage
  });
}

if (process.env.SYNC_TEAMS_SCHEDULE) {
  app.timer('syncTrackTeams', {
    schedule: '%SYNC_TEAMS_SCHEDULE%',
    runOnStartup: false,
    handler: syncTrackTeams
  });
}

// Unset = Track edits wait for the nightly run.
if (process.env.SYNC_PROJECTS_SCHEDULE) {
  app.timer('syncTrackProjects', {
    schedule: '%SYNC_PROJECTS_SCHEDULE%',
    runOnStartup: false,
    handler: syncTrackProjects
  });
}

if (process.env.BULK_DOWNLOADS_QUEUE) {
  app.storageQueue('bulkDownloadWorker', {
    queueName: '%BULK_DOWNLOADS_QUEUE%',
    // The same identity-based connection the producer sends on.
    connection: 'AzureWebJobsStorage',
    handler: bulkDownloadWorker
  });
}

// Unset = the document controller skips the re-stamp and flags `parentFieldsPending` for
// `backfill-chunk-parent-fields.js --pending`; the inline walk is opt-in via `CHUNK_RESTAMP_INLINE`.
if (process.env.CHUNK_RESTAMP_QUEUE) {
  app.storageQueue('restampChunksWorker', {
    queueName: '%CHUNK_RESTAMP_QUEUE%',
    connection: 'AzureWebJobsStorage',
    handler: restampChunksWorker
  });
}

// A queue, not a route: the run waits for the indexers, which for chunks takes hours.
if (process.env.SEARCH_DEFINITIONS_QUEUE) {
  app.storageQueue('searchDefinitionsWorker', {
    queueName: '%SEARCH_DEFINITIONS_QUEUE%',
    connection: 'AzureWebJobsStorage',
    handler: searchDefinitionsWorker
  });
}

if (process.env.SYNC_OUT_QUEUE) {
  app.storageQueue('syncOutWorker', {
    queueName: '%SYNC_OUT_QUEUE%',
    connection: 'AzureWebJobsStorage',
    handler: syncOutWorker
  });
}

if (process.env.BULK_CLEANUP_SCHEDULE) {
  app.timer('cleanupBulkDownloads', {
    schedule: '%BULK_CLEANUP_SCHEDULE%',
    runOnStartup: false,
    handler: cleanupBulkDownloads
  });
}

if (process.env.ANNOUNCE_UPDATES_SCHEDULE) {
  app.timer('announceUpdates', {
    schedule: '%ANNOUNCE_UPDATES_SCHEDULE%',
    runOnStartup: false,
    handler: announceUpdates
  });
}

// Guarded on EDGE_BAN_MODE being SET, not its value: deployed apps set `off`, and an off tick clears the rule.
// Schedule as a value, not `%EDGE_BAN_SCHEDULE%`: an unset name would fail host startup, not default hourly.
if (process.env.EDGE_BAN_MODE) {
  app.timer('edgeBan', {
    schedule: require('../src/config').edgeBan.schedule,
    runOnStartup: false,
    handler: edgeBan
  });
}

// Guarded on the account so a release that ships before the intake infrastructure registers no timer.
if (require('../src/config').intake.storageAccount) {
  app.timer('intakeScanSweep', {
    schedule: require('../src/config').intake.sweepSchedule,
    runOnStartup: false,
    handler: intakeScanSweep
  });
}

// Read from host.json, which the queue extension obeys; a copy here would drift.
const MAX_DEQUEUE_COUNT = require('../host.json').extensions.queues.maxDequeueCount;

// Workers log the poison-alert string only on the last delivery; earlier failures still retry.
const deliveryAttempt = (context) =>
  Number((context && context.triggerMetadata && context.triggerMetadata.dequeueCount) || 1);

// Rethrows, unlike the timers: after `maxDequeueCount` the message must land in the poison queue
// the alert reads.
async function bulkDownloadWorker(message, context) {
  // `messageEncoding: "none"` (host.json): the body is the bare job id, a string or undecoded Buffer.
  const jobId = Buffer.isBuffer(message) ? message.toString('utf8') : String(message);
  await require('../src/jobs/bulk-download')
    .run(jobId, { attempt: deliveryAttempt(context), maxAttempts: MAX_DEQUEUE_COUNT });
}

// Throws on the last attempt only: earlier ones re-queue the ids, since host.json's hour-long
// `visibilityTimeout` (sized for zips) would hide each retry for an hour.
async function restampChunksWorker(message, context) {
  await require('../src/jobs/restamp-chunks')
    .run(message, { attempt: deliveryAttempt(context), maxAttempts: MAX_DEQUEUE_COUNT });
}

// Never rethrows: a retry would re-PUT definitions and reset indexers already rebuilding, so the
// job row holds the verdict.
async function searchDefinitionsWorker(message, context) {
  const jobId = Buffer.isBuffer(message) ? message.toString('utf8') : String(message);
  await require('../src/jobs/search-definitions')
    .run(jobId, { attempt: deliveryAttempt(context), maxAttempts: MAX_DEQUEUE_COUNT });
}

// Earlier failures re-queue with backoff (the hour-long `visibilityTimeout` is sized for zips). The
// last attempt does not throw: it parks the message in the poison queue and logs the alert once.
async function syncOutWorker(message, context) {
  await require('../src/sync-out')
    .run(message, { attempt: deliveryAttempt(context), maxAttempts: MAX_DEQUEUE_COUNT });
}

/** Swallows the failure as reconcileEagle does: the next run is the retry. */
async function intakeScanSweep() {
  const { logger } = require('../src/utils/logger');
  try {
    await require('../src/intake/sweep').sweep();
  } catch (err) {
    logger.error('[intake] sweep run failed', { error: err.message, stack: err.stack });
  }
}

/** Swallows the failure for the reason the reconcile does: the next run is the retry. */
async function cleanupBulkDownloads() {
  const { logger } = require('../src/utils/logger');
  try {
    await require('../src/scripts/cleanup-bulk-downloads').run();
  } catch (err) {
    logger.error('[bulk] cleanup run failed', { error: err.message, stack: err.stack });
  }
}

/** Swallows the failure for the reason the reconcile does: the next tick is the retry. */
async function announceUpdates() {
  const { logger } = require('../src/utils/logger');
  try {
    await require('../src/scripts/announce-updates').run();
  } catch (err) {
    logger.error('[updates] scheduled announce failed', { error: err.message, stack: err.stack });
  }
}

// Swallows the failure: drift reaches the alert through the log line, and the next night is the
// retry. The lazy require keeps the seed loader out of HTTP workers.
async function reconcileEagle() {
  const { logger } = require('../src/utils/logger');
  try {
    await require('../src/scripts/reconcile-eagle').run({ store: true });
  } catch (err) {
    logger.error('[reconcile] nightly run failed', { error: err.message, stack: err.stack });
  }
}

// `store: true` feeds GET /admin/reconcile-engage. Each kind's failure is swallowed so one kind
// cannot stop the rest.
async function reconcileEngage() {
  const { logger } = require('../src/utils/logger');
  const { KINDS } = require('../src/sync-out/kinds');
  for (const [kind, { reconcile }] of Object.entries(KINDS)) {
    try {
      await reconcile({ store: true });
    } catch (err) {
      logger.error('[reconcile-engage] nightly run failed', { kind, error: err.message, stack: err.stack });
    }
  }
}

// `live: true`: a scheduled dry run would report a plan nothing ever applies.
async function syncTrackTeams() {
  const { logger } = require('../src/utils/logger');
  try {
    await require('../src/scripts/sync-track-teams').run({ live: true });
  } catch (err) {
    logger.error('[track-teams] nightly run failed', { error: err.message, stack: err.stack });
  }
}

/** `live: true` for the reason syncTrackTeams gives. Swallows the failure as reconcileEagle does. */
async function syncTrackProjects() {
  const { logger } = require('../src/utils/logger');
  try {
    await require('../src/scripts/sync-track-projects').run({ live: true });
  } catch (err) {
    logger.error('[track-projects-poll] run failed', { error: err.message, stack: err.stack });
  }
}

/** Swallows the failure as reconcileEagle does; a bad mode or policy setting throws into the same catch. */
async function edgeBan() {
  const { logger } = require('../src/utils/logger');
  try {
    const { edgeBan: settings } = require('../src/config');
    const { mode, workspaceId, ruleId } = settings;
    if (!mode || !workspaceId || !ruleId) {
      logger.info('[edge-ban] EDGE_BAN_MODE, EDGE_LOG_WORKSPACE_ID or EDGE_BAN_RULE_ID is unset, run skipped');
      return;
    }
    // Off clears the rule and judges nothing, so a missing or broken policy must not block the kill switch.
    const policy = mode === 'off' ? null : settings.policy;
    if (mode !== 'off' && !policy) {
      logger.error('[edge-ban] EDGE_BAN_POLICY is unset or its Key Vault reference did not resolve, run skipped');
      return;
    }
    const summary = await require('../src/scripts/edge-ban').run({
      mode,
      now: new Date(),
      log: logger,
      policy,
      workspaceId,
      ruleId,
      credential: require('../src/utils/azure-credential').createCredential(),
      cosmos: require('../src/db/cosmos-nosql')
    });
    const count = (v) => (Array.isArray(v) ? v.length : v);
    logger.info('[edge-ban] run finished', {
      mode,
      candidates: count(summary.candidates),
      banned: count(summary.banned),
      expired: count(summary.expired),
      written: summary.written,
      warnings: summary.warnings
    });
  } catch (err) {
    logger.error('[edge-ban] run failed', { error: err.message, stack: err.stack });
  }
}
