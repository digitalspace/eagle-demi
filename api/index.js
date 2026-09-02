'use strict';

// Azure Monitor has to start before anything else is required. The distro instruments modules by
// hooking `require`, so any library loaded ahead of it — http, winston — is captured as the
// uninstrumented original and never reports.
//
// Guarded on the connection string so the test suite runs untouched: no connection string, no
// telemetry, no exporter retry noise in the console.
// Winston instrumentation is opt-in; the distro leaves it off by default, and it is the whole
// reason the existing logger's output reaches Application Insights at all.
if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  const { useAzureMonitor } = require('@azure/monitor-opentelemetry');
  useAzureMonitor({
    // Performance counters off: they were 46.97 MB of a 84.68 MB/30d workspace ingest — the single
    // largest table — and every one of them (CPU, memory, request rate) is already collected free
    // as App Service platform metrics, which never enter the workspace and so are not subject to
    // its dailyQuotaGb cap either. Paying per-GB to duplicate a free metric is the whole of the loss.
    //
    // Standard metrics stay ON deliberately. They are the next-largest table (AppMetrics, 30.67 MB)
    // and killing them would save roughly a dollar a month, but they are what the Performance and
    // Failures blades read — request duration, dependency duration, failure rate. Platform metrics
    // do NOT cover those. Cutting them buys pennies and blinds the tool.
    enablePerformanceCounters: false,
    instrumentationOptions: {
      winston: { enabled: true }
    }
  });
}

const { app } = require('@azure/functions');

// Exported for test/reconcile-timer.test.js and test/sync-teams-timer.test.js — the host is the
// only other caller of either.
module.exports = { reconcileEagle, syncTrackTeams, bulkDownloadWorker, cleanupBulkDownloads };

// Drain buffered audit events before the worker goes away.
//
// src/utils/audit.js buffers events and flushes on a 1-second timer, which is correct for a
// long-lived process and wrong here: the Functions host owns this worker's lifecycle and recycles
// it on deploy, config change, scale and idle. Work deferred past a response is not guaranteed to
// run, and the flush timer is unref()'d, so it does not hold the process open either. Measured on
// the first staging deploy: events buffered at 21:50 were lost to the restart at 21:52.
//
// appTerminate covers graceful shutdown — deploys, restarts, scale-in, which is every recycle we
// have actually observed. Microsoft is explicit that it does not run on a forced kill and that
// handlers get a limited grace period, so this shortens the loss window rather than closing it.
//
// Registered here rather than in audit.js because this file is the only Azure-specific entry point.
app.hook.appTerminate(async () => {
  const { flush } = require('../src/utils/audit');
  await flush();
});

// ONE catch-all, not one registration per route: the Functions host matches routes in DISCOVERY
// order rather than by specificity (host issue #9876), so per-route registrations plus a fallback
// route non-deterministically. src/http/routes.js is the route table; the require is lazy so the
// timer tests can load this file against a recording `app`.
const handler = (request, context) => require('../src/http/router').dispatch(request, context);

const HTTP = {
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
  authLevel: 'anonymous',
  handler
};

app.http('api', { ...HTTP, route: '{*path}' });
app.http('apiRoot', { ...HTTP, route: '' });

// The Eagle drift report, nightly. The host owns the clock, holds the singleton lease in
// AzureWebJobsStorage and survives a worker recycle, none of which an in-process setTimeout can do.
//
// REGISTERED ONLY WHEN RECONCILE_SCHEDULE IS SET, and that is a guard on the app setting rather
// than on the binding: `%RECONCILE_SCHEDULE%` is resolved by the HOST, and an unresolvable name is
// a startup error that takes the HTTP functions down with it. Local development and the test suite
// set nothing and so register nothing.
if (process.env.RECONCILE_SCHEDULE) {
  app.timer('reconcileEagle', {
    // The setting's name, not its value: the host reads the schedule at startup, so changing the
    // app setting reschedules the job without a code deploy. NCRONTAB, six fields, seconds first.
    schedule: '%RECONCILE_SCHEDULE%',
    // A restart is not a reason to re-read the whole Eagle corpus, and deploys restart this app.
    runOnStartup: false,
    handler: reconcileEagle
  });
}

// The Track team feed, on the same terms and guarded the same way. Stays empty until both realm
// clients exist in the environment's realm — see TODO-rbac.md P3-0.
if (process.env.SYNC_TEAMS_SCHEDULE) {
  app.timer('syncTrackTeams', {
    schedule: '%SYNC_TEAMS_SCHEDULE%',
    runOnStartup: false,
    handler: syncTrackTeams
  });
}

// The zip builder, one job per message. Guarded on the queue NAME for the reason the timers are
// guarded on their schedules: `%BULK_DOWNLOADS_QUEUE%` is resolved by the host, and an
// unresolvable name is a startup error that takes the HTTP functions with it.
if (process.env.BULK_DOWNLOADS_QUEUE) {
  app.storageQueue('bulkDownloadWorker', {
    queueName: '%BULK_DOWNLOADS_QUEUE%',
    // The host's own storage account, identity-based — the same connection the producer sends on.
    connection: 'AzureWebJobsStorage',
    handler: bulkDownloadWorker
  });
}

// Deletes zips past their retention window. Off unless the schedule is set, same guard again.
if (process.env.BULK_CLEANUP_SCHEDULE) {
  app.timer('cleanupBulkDownloads', {
    schedule: '%BULK_CLEANUP_SCHEDULE%',
    runOnStartup: false,
    handler: cleanupBulkDownloads
  });
}

// Read from host.json rather than repeated here: the queue extension is what actually decides how
// many deliveries a message gets, and a copy of the number drifts silently.
const MAX_DEQUEUE_COUNT = require('../host.json').extensions.queues.maxDequeueCount;

/**
 * Unlike the timers this RETHROWS: a failed zip has a retry, and after `maxDequeueCount` the
 * message belongs in the poison queue where the alert can see it. Swallowing here would report
 * every failure as a success and lose the job.
 */
async function bulkDownloadWorker(message, context) {
  // `messageEncoding: "none"` (host.json) means the body arrives as the bare job id. The binding
  // hands over a string, or a Buffer if the host ever passes the body through undecoded.
  const jobId = Buffer.isBuffer(message) ? message.toString('utf8') : String(message);
  // Which delivery this is. The worker logs the string the poison alert matches only on the last
  // one — an earlier failure still has a retry, and paging for it would be noise.
  const attempt = Number(
    (context && context.triggerMetadata && context.triggerMetadata.dequeueCount) || 1
  );
  await require('../src/jobs/bulk-download').run(jobId, { attempt, maxAttempts: MAX_DEQUEUE_COUNT });
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

/**
 * Swallows the failure deliberately: `run()` reports drift through the log line the alert reads,
 * and there is nothing for the host to retry — the next night is the retry. Required lazily so the
 * seed loader and both repositories stay out of an HTTP worker that will never run this.
 */
async function reconcileEagle() {
  const { logger } = require('../src/utils/logger');
  try {
    await require('../src/scripts/reconcile-eagle').run();
  } catch (err) {
    logger.error('[reconcile] nightly run failed', { error: err.message, stack: err.stack });
  }
}

/**
 * `live: true`: the timer exists to write the roles, and a scheduled dry run would report a plan
 * nothing ever applies. Swallows the failure for the reason the reconcile does.
 */
async function syncTrackTeams() {
  const { logger } = require('../src/utils/logger');
  try {
    await require('../src/scripts/sync-track-teams').run({ live: true });
  } catch (err) {
    logger.error('[track-teams] nightly run failed', { error: err.message, stack: err.stack });
  }
}
