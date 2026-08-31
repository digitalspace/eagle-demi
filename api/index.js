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
module.exports = { reconcileEagle, syncTrackTeams };

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
