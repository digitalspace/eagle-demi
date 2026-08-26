'use strict';

/**
 * The nightly Eagle drift report, run in the API process.
 *
 * In-process because there is nowhere else: the app is `functionapp,linux` on a B1 plan, Linux App
 * Service has no cron and no WebJobs, and a second Azure resource for one report a day is not worth
 * owning. `alwaysOn` keeps the worker up, so a timer set at boot survives to fire.
 *
 * OFF unless RECONCILE_HOUR_UTC names an hour — see azure/modules/api-web-app.bicep.
 *
 * ponytail: a worker recycle (deploy, config change) restarts the clock, so a run whose hour passes
 * during the restart is skipped rather than caught up. One missed nightly report is a day of
 * blindness on a check that has read drift=0 since it existed; a catch-up needs durable state,
 * which means a Functions timer trigger with its storage singleton.
 */

const { logger } = require('./utils/logger');

/** ms from `now` until the next HH:00 UTC — tomorrow's, once today's has passed. */
function msUntilHour(hourUtc, now = new Date()) {
  const next = new Date(now.getTime());
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function scheduleNext(hourUtc, job) {
  // unref'd: a daily timer must never be what holds the worker open through a shutdown.
  setTimeout(async () => {
    // Rescheduled either way. A failed run is a missing report, not a stopped schedule — and the
    // next tick is a fresh attempt at the thing that failed.
    try {
      await job();
    } catch (err) {
      logger.error('[reconcile] nightly run failed', { error: err.message, stack: err.stack });
    }
    scheduleNext(hourUtc, job);
  }, msUntilHour(hourUtc)).unref();
}

/**
 * @param {function} [job]  test seam; defaults to the reconcile script's own run()
 * @param {string}   [hour] RECONCILE_HOUR_UTC. Absent or empty = off, which is the default state
 * @returns {boolean} whether a nightly run was scheduled
 */
function startReconcileSchedule(job, hour = process.env.RECONCILE_HOUR_UTC) {
  if (!hour) return false;
  const hourUtc = Number(hour);
  if (!Number.isInteger(hourUtc) || hourUtc < 0 || hourUtc > 23) {
    logger.warn(`[reconcile] RECONCILE_HOUR_UTC="${hour}" is not an hour 0-23; nightly run is off`);
    return false;
  }
  // Required lazily: it pulls in the seed loader and both repositories, which the request path has
  // no use for in an environment that never sets the hour.
  scheduleNext(hourUtc, job || (() => require('./scripts/reconcile-eagle').run()));
  logger.info(`[reconcile] nightly run scheduled for ${String(hourUtc).padStart(2, '0')}:00 UTC`);
  return true;
}

module.exports = { msUntilHour, startReconcileSchedule };
