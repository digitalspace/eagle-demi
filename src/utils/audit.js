'use strict';

/**
 * audit.js — the append-only record of what happened, and the usage counters beside it.
 *
 * Two destinations, one writer. Both are custom tables in the `demi-audit-<env>` Log Analytics
 * workspace, reached through the Logs Ingestion API of a Direct data collection rule. See
 * `azure/modules/audit-logs.bicep` for why they are separate tables and why that workspace is
 * separate from the one application logs go to.
 *
 *   auditEvent()     -> DemiAudit_CL   privileged actions. Identity-bearing, kept 7 years.
 *   analyticsEvent() -> DemiEvents_CL  usage counters. No durable identity, kept 13 months.
 *
 * THIS MODULE MUST NEVER FAIL A REQUEST. Every entry point returns synchronously after appending
 * to an in-memory buffer; the network call happens on a timer. A failed flush is logged and
 * dropped, never thrown, and never awaited by a caller. An audit sink that can 500 a request is a
 * bigger outage than a missing audit row.
 *
 * With no AUDIT_DCR_ENDPOINT configured the whole module is inert — that is local development,
 * the test suite, and any environment where the DCR has not been deployed yet.
 */

const crypto = require('crypto');
const config = require('../config');
const { logger } = require('./logger');
const { callerIp } = require('../middleware/rate-limiter');
const { rolesFor } = require('../helpers/access-sql');

const AUDIT_STREAM = 'Custom-DemiAudit_CL';
const EVENTS_STREAM = 'Custom-DemiEvents_CL';

// Buffered rows, keyed by stream. Flushed together, one HTTP call per stream.
const buffers = new Map([
  [AUDIT_STREAM, []],
  [EVENTS_STREAM, []]
]);

let flushTimer = null;
let credential = null;
let warnedDisabled = false;

// Injection seam for the tests. Real code never passes anything here; `test/audit.test.js`
// substitutes a stub so the buffering and batching logic can be exercised with no Azure and no
// managed identity. Kept to two functions rather than a transport abstraction — there is exactly
// one real implementation and there is not going to be a second.
let sendBatch = postToIngestionApi;
let getToken = fetchIngestionToken;

function enabled() {
  return Boolean(config.auditDcrEndpoint && config.auditDcrImmutableId);
}

/**
 * Salt behind AnonId, rotated every UTC day.
 *
 * This is what lets DemiEvents_CL count distinct users without storing an identifier that
 * outlives the day it was minted — which in turn is why no deletion path is needed for a table
 * whose plan has no cheap targeted delete.
 *
 * ponytail: the salt lives in process memory, so a restart mints a new one mid-day and
 * dcount(AnonId) over-counts for that day. Persist it (app setting, Key Vault) only if the
 * distinct-user number ever has to be exact rather than indicative.
 */
let salt = crypto.randomBytes(32);
let saltDay = '';

function currentSalt() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== saltDay) {
    salt = crypto.randomBytes(32);
    saltDay = today;
  }
  return salt;
}

function anonId(req) {
  const agent = (req && req.headers && req.headers['user-agent']) || '';
  const ip = req ? callerIp(req) : '';
  return crypto.createHmac('sha256', currentSalt()).update(`${ip}|${agent}`).digest('hex').slice(0, 32);
}

/**
 * Append a row and make sure a flush is coming. Never throws.
 */
function enqueue(stream, row) {
  if (!enabled()) {
    if (!warnedDisabled) {
      warnedDisabled = true;
      logger.warn('[Audit] AUDIT_DCR_ENDPOINT is not set; audit and analytics events are being discarded.');
    }
    return;
  }

  const buffer = buffers.get(stream);
  buffer.push(row);

  if (buffer.length >= config.auditMaxBatch) {
    void flush();
    return;
  }

  if (!flushTimer) {
    flushTimer = setTimeout(() => { void flush(); }, config.auditFlushMs);
    // Do not hold the process open for a pending audit flush. A shutdown path that wants the
    // buffer drained calls flush() itself.
    if (flushTimer.unref) flushTimer.unref();
  }
}

/**
 * Record a privileged action.
 *
 * @param {object} req    Express request. Supplies actor, roles, IP and correlation id.
 * @param {object} event  { action, outcome, targetType, targetId, projectId, detail }
 */
function auditEvent(req, event) {
  const user = (req && req.user) || null;

  enqueue(AUDIT_STREAM, {
    TimeGenerated: new Date().toISOString(),
    // Client-generated so a retried batch is identifiable as the same event rather than a second
    // one. Nothing deduplicates on ingest; a reader dedupes with `arg_min(TimeGenerated, *) by
    // EventId` if duplicates ever show up.
    EventId: crypto.randomUUID(),
    Action: event.action,
    Outcome: event.outcome || 'success',
    // `sub` is the stable Keycloak identifier; preferred_username is what a human recognises. An
    // API key authenticates as its own principal and carries neither, so keyId stands in.
    ActorId: (user && (user.sub || user.preferred_username || user.keyId)) || 'anonymous',
    ActorType: user ? (user.keyId || user.azp ? 'service' : 'user') : 'anonymous',
    // rolesFor() drops `project:*` roles, which is right here: this column records the PRIVILEGE
    // the caller acted with, and the project dimension is already in ProjectId.
    ActorRoles: req ? rolesFor(req).join(',') : '',
    // Masked to two octets by the DCR transform, not here — see audit-logs.bicep. Sending the
    // full value and masking at ingest keeps the boundary in one place.
    SourceIp: req ? callerIp(req) : '',
    TargetType: event.targetType || '',
    TargetId: event.targetId ? String(event.targetId) : '',
    ProjectId: event.projectId ? String(event.projectId) : '',
    CorrelationId: (req && req.id) || '',
    Env: config.environmentName,
    Detail: event.detail || {}
  });
}

/**
 * Record a usage event. Deliberately carries no durable identity — see anonId above.
 *
 * @param {object} req    Express request.
 * @param {object} event  { eventName, projectId, documentId, searchTerm, resultCount, detail }
 */
function analyticsEvent(req, event) {
  const headers = (req && req.headers) || {};

  enqueue(EVENTS_STREAM, {
    TimeGenerated: new Date().toISOString(),
    EventName: event.eventName,
    AnonId: anonId(req),
    SessionId: headers['x-session-id'] || '',
    ProjectId: event.projectId ? String(event.projectId) : '',
    DocumentId: event.documentId ? String(event.documentId) : '',
    // Free text a caller typed. The single field here with real disclosure risk, and the single
    // field the analytics are actually for. Flagged in the plan for privacy review rather than
    // quietly dropped.
    SearchTerm: event.searchTerm || '',
    ResultCount: Number.isFinite(event.resultCount) ? event.resultCount : 0,
    DeviceType: /mobile|android|iphone/i.test(headers['user-agent'] || '') ? 'mobile' : 'desktop',
    Country: headers['x-client-country'] || '',
    Referrer: headers.referer || headers.referrer || '',
    Env: config.environmentName,
    Detail: event.detail || {}
  });
}

/**
 * Split a row array into batches under both the count and byte ceilings.
 *
 * The byte ceiling is the one that matters: the ingestion API rejects a body over 1 MB, and a
 * single audit row carrying a large `Detail` diff can be tens of kilobytes.
 */
function batches(rows, maxCount, maxBytes) {
  const out = [];
  let current = [];
  let bytes = 2; // the enclosing []

  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (current.length > 0 && (current.length >= maxCount || bytes + size > maxBytes)) {
      out.push(current);
      current = [];
      bytes = 2;
    }
    current.push(row);
    bytes += size;
  }

  if (current.length > 0) out.push(current);
  return out;
}

async function fetchIngestionToken() {
  if (!credential) {
    // Required lazily, matching src/db/cosmos-nosql.js: importing this module must not pull in
    // @azure/identity in environments that never publish.
    const { DefaultAzureCredential } = require('@azure/identity');
    credential = new DefaultAzureCredential(
      process.env.AZURE_CLIENT_ID
        ? { managedIdentityClientId: process.env.AZURE_CLIENT_ID }
        : undefined
    );
  }
  // The credential caches and refreshes internally, so this is not a network call per flush.
  const token = await credential.getToken('https://monitor.azure.com/.default');
  return token && token.token;
}

async function postToIngestionApi(stream, rows) {
  const token = await getToken();
  if (!token) throw new Error('no token for https://monitor.azure.com');

  const url = `${config.auditDcrEndpoint}/dataCollectionRules/${config.auditDcrImmutableId}` +
    `/streams/${stream}?api-version=2023-01-01`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(rows)
  });

  if (!res.ok) {
    throw new Error(`${res.status} ${await res.text()}`);
  }
}

/**
 * Drain both buffers. Safe to call at any time; awaited only by tests and a shutdown path.
 */
async function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  for (const [stream, buffer] of buffers) {
    if (buffer.length === 0) continue;

    // Taken before the await so rows arriving mid-flush land in the next batch rather than being
    // sent twice or dropped.
    const rows = buffer.splice(0, buffer.length);

    for (const batch of batches(rows, config.auditMaxBatch, config.auditMaxBatchBytes)) {
      await sendWithRetry(stream, batch);
    }
  }
}

async function sendWithRetry(stream, batch) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await sendBatch(stream, batch);
      return;
    } catch (err) {
      if (attempt === 2) {
        // Last resort, and the reason this is `error` and carries the whole payload: the rows are
        // about to be lost, and the application log is the only place left to recover them from.
        logger.error(`[Audit] dropped ${batch.length} row(s) for ${stream} after 3 attempts: ${err.message} :: ${JSON.stringify(batch)}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

module.exports = {
  auditEvent,
  analyticsEvent,
  flush,
  AUDIT_STREAM,
  EVENTS_STREAM,
  // Test seams only.
  _setTransport: (send, token) => { sendBatch = send; getToken = token || (async () => 'test-token'); },
  _resetTransport: () => { sendBatch = postToIngestionApi; getToken = fetchIngestionToken; },
  _batches: batches
};
