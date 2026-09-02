'use strict';

const config = require('../config');
const monitor = require('../azure/monitor');
const { sendError, serverError } = require('../helpers/response');
const { logger } = require('../utils/logger');

// Log Analytics bounds a query by `timespan`, so the window is a service-side parameter and never
// reaches the KQL text. These are the only windows offered; anything else is a 400.
const AUDIT_WINDOWS = { 24: 'PT24H', 168: 'P7D', 720: 'P30D' };
const ANALYTICS_WINDOWS = { 7: 'P7D', 30: 'P30D' };

// Everything else IS interpolated into KQL, so it is matched against a whitelist first and
// rejected outright otherwise. Neither pattern admits a quote, so the single quotes below cannot
// be closed early; there is no escaping step to get wrong because nothing needing one gets through.
const ACTION_RE = /^[a-z][a-z.]{0,40}$/;
const ACTOR_RE = /^[\w.@-]{1,80}$/;

const COST_TTL_MS = 60 * 60 * 1000;
// ponytail: per-instance cache, so each Flex instance pays its own first call. Move it to the
// config container if the Cost Management API starts rate-limiting (429).
let costCache = null;

function notConfigured(res) {
  return sendError(res, 'not configured', 503);
}

/** The `hours`/`days`/`action`/`actor`/`limit` inputs, or an `error` naming the bad one. */
function auditQuery(query) {
  const hours = parseInt(query.hours || '24', 10);
  if (!AUDIT_WINDOWS[hours]) return { error: 'hours must be one of 24, 168, 720' };

  const limit = parseInt(query.limit || '100', 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) return { error: 'limit must be 1-500' };

  const action = query.action || '';
  if (action && !ACTION_RE.test(action)) return { error: 'invalid action' };

  const actor = query.actor || '';
  if (actor && !ACTOR_RE.test(actor)) return { error: 'invalid actor' };

  return { hours, limit, action, actor };
}

function auditFilter({ action, actor }) {
  let kql = '';
  if (action) kql += ` | where Action == '${action}'`;
  // Either identifier: the panel's filter box takes whichever one the operator has to hand.
  if (actor) kql += ` | where ActorId == '${actor}' or ActorName == '${actor}'`;
  return kql;
}

/** GET /admin/audit — the audit trail, newest first, plus a count per action over the window. */
async function getAudit(req, res) {
  if (!config.auditWorkspaceCustomerId) return notConfigured(res);

  const q = auditQuery((req && req.query) || {});
  if (q.error) return sendError(res, q.error, 400);

  const filter = auditFilter(q);
  const timespan = AUDIT_WINDOWS[q.hours];

  try {
    const [rows, byAction] = await Promise.all([
      monitor.queryLogs(
        config.auditWorkspaceCustomerId,
        `DemiAudit_CL${filter} | top ${q.limit} by TimeGenerated desc` +
          ' | project TimeGenerated, EventId, Action, Outcome, ActorId, ActorName, ActorType,' +
          ' ActorRoles, SourceIp, TargetType, TargetId, ProjectId, CorrelationId, Env, Detail',
        timespan
      ),
      monitor.queryLogs(
        config.auditWorkspaceCustomerId,
        `DemiAudit_CL${filter} | summarize c = count() by Action | order by c desc`,
        timespan
      )
    ]);

    return res.json({
      success: true,
      hours: q.hours,
      // The window total, not `rows.length` — `top` caps the rows and would understate it.
      total: byAction.reduce((sum, row) => sum + (row.c || 0), 0),
      byAction: byAction.map((row) => ({ action: row.Action, count: row.c })),
      rows
    });
  } catch (err) {
    return serverError(res, err, 'GET /admin/audit');
  }
}

/** GET /admin/analytics — DEMI usage and demi-api request health over the same window. */
async function getAnalytics(req, res) {
  // Both workspaces: usage rows land in the audit workspace, AppRequests in the app one.
  if (!config.auditWorkspaceCustomerId || !config.appLogsWorkspaceCustomerId) return notConfigured(res);

  const days = parseInt(((req && req.query) || {}).days || '7', 10);
  if (!ANALYTICS_WINDOWS[days]) return sendError(res, 'days must be one of 7, 30', 400);

  const timespan = ANALYTICS_WINDOWS[days];
  const events = config.auditWorkspaceCustomerId;
  const logs = config.appLogsWorkspaceCustomerId;
  const requestStats =
    'AppRequests | summarize requests = count(), failed = countif(Success == false),' +
    ' p95DurationMs = percentile(DurationMs, 95)';

  try {
    const [perDay, totals, topEvents, topSearches, window, last24h] = await Promise.all([
      monitor.queryLogs(events,
        'DemiEvents_CL | summarize events = count(), visitors = dcount(AnonId)' +
        ' by day = bin(TimeGenerated, 1d) | order by day asc', timespan),
      // dcount over the whole window, which is not the sum of the daily counts.
      monitor.queryLogs(events,
        'DemiEvents_CL | summarize events = count(), visitors = dcount(AnonId)', timespan),
      monitor.queryLogs(events,
        'DemiEvents_CL | summarize c = count() by EventName | top 10 by c desc', timespan),
      monitor.queryLogs(events,
        'DemiEvents_CL | where isnotempty(SearchTerm) | summarize c = count() by SearchTerm' +
        ' | top 10 by c desc', timespan),
      monitor.queryLogs(logs, requestStats, timespan),
      monitor.queryLogs(logs, requestStats, 'PT24H')
    ]);

    const total = totals[0] || {};
    return res.json({
      success: true,
      days,
      totals: { events: total.events || 0, visitors: total.visitors || 0 },
      perDay: perDay.map((row) => ({ day: row.day, events: row.events, visitors: row.visitors })),
      topEvents: topEvents.map((row) => ({ name: row.EventName, count: row.c })),
      topSearches: topSearches.map((row) => ({ term: row.SearchTerm, count: row.c })),
      requests: { window: window[0] || null, last24h: last24h[0] || null }
    });
  } catch (err) {
    return serverError(res, err, 'GET /admin/analytics');
  }
}

/** GET /admin/cost — month-to-date spend by resource and by service, against the budget. */
async function getCost(req, res) {
  if (!config.costScope) return notConfigured(res);

  if (costCache && Date.now() - costCache.at < COST_TTL_MS) return res.json(costCache.body);

  try {
    const [rows, budget] = await Promise.all([
      monitor.queryCost(config.costScope),
      // Neither a missing budget name nor a failed budget read is a reason to withhold the
      // spend figures — the budget is context beside them, not the answer.
      config.budgetName
        ? monitor.getBudget(config.costScope, config.budgetName).catch((err) => {
          logger.warn('GET /admin/cost: budget read failed', { error: err.message });
          return null;
        })
        : null
    ]);

    const byResource = new Map();
    const byService = new Map();
    let total = 0;
    let currency = (budget && budget.currency) || '';

    for (const row of rows) {
      const cost = row.Cost || 0;
      total += cost;
      currency = currency || row.Currency || '';
      byResource.set(row.ResourceId, (byResource.get(row.ResourceId) || 0) + cost);
      byService.set(row.ServiceName, (byService.get(row.ServiceName) || 0) + cost);
    }

    const descending = (a, b) => b.cost - a.cost;
    const body = {
      success: true,
      asOf: new Date().toISOString(),
      currency,
      total,
      byResource: [...byResource].map(([resourceId, cost]) => ({ resourceId, cost })).sort(descending),
      byService: [...byService].map(([service, cost]) => ({ service, cost })).sort(descending),
      budget
    };
    costCache = { at: Date.now(), body };
    return res.json(body);
  } catch (err) {
    return serverError(res, err, 'GET /admin/cost');
  }
}

module.exports = {
  getAudit,
  getAnalytics,
  getCost,
  // Test seam only.
  _resetCostCache: () => { costCache = null; }
};
