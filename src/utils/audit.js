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
const { callerIp } = require('./caller-ip');
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

/**
 * Who did this, from the verified token only — never a header or a query param.
 *
 * Four caller shapes reach this, and telling them apart is the whole job (see helpers/auth.js):
 *
 *   Keycloak bearer  -> `sub` (stable UUID) + preferred_username. A person.
 *   Registry API key -> `keyId` + preferred_username. A named machine consumer.
 *   ADMIN_API_KEY    -> preferred_username 'internal-service', nothing else. Break-glass, a
 *                       SHARED credential, so the action is attributable to a credential and not
 *                       to a human. Recorded as what it is rather than dressed up.
 *   none             -> anonymous.
 *
 * This used to be `keyId || azp ? 'service' : 'user'`, which was wrong in both directions: the
 * break-glass key has neither and was logged as a person, while a real human signing in through
 * eagle-admin-console DOES carry `azp` and was logged as a service. Both were visible in the first
 * staging audit rows.
 *
 * `id` is the stable identifier and `name` is the human-readable one. Both are recorded, because
 * `sub` alone means every trace needs a Keycloak lookup to answer "who is this", and
 * preferred_username alone is not stable across a rename.
 */
function actorFor(req) {
  const user = (req && req.user) || null;
  if (!user) return { id: '', name: '', type: 'anonymous' };

  const name = user.preferred_username || '';

  // A registry key: its own principal, with its own roles, expiry and revocation.
  if (user.keyId) return { id: user.keyId, name, type: 'api-key' };

  // A Keycloak SERVICE ACCOUNT — client_credentials, the service-to-service path Track and
  // ENGAGE-style callers use. These carry a `sub` like any token, so checking `sub` first would
  // file a shared client secret as a person and keep it that way for seven years. Keycloak names
  // the backing user after the client (`service-account-<clientId>`) and adds a `clientId` claim,
  // so either is enough to tell them apart. Checked BEFORE the human branch for that reason.
  if (user.clientId || name.startsWith('service-account-')) {
    return {
      id: user.sub || user.clientId || name,
      name: name || `service-account-${user.clientId}`,
      type: 'service'
    };
  }

  // Break-glass ADMIN_API_KEY: a shared credential, attributable to a credential and not a person.
  // Requires the ABSENCE of `sub`, so a real Keycloak principal that happens to be named
  // 'internal-service' cannot be laundered into this bucket and have its identity discarded.
  if (!user.sub && name === 'internal-service') return { id: name, name, type: 'break-glass' };

  // A person.
  if (user.sub) return { id: user.sub, name, type: 'user' };

  // Authenticated but unclassifiable. Says so, rather than borrowing the 'user' label or the
  // 'anonymous' id and producing a row that claims a signed-in caller while naming nobody.
  return { id: name, name, type: name ? 'user' : 'unknown' };
}

function hashWithDailySalt(value) {
  return crypto.createHmac('sha256', currentSalt()).update(value).digest('hex').slice(0, 32);
}

function anonId(req) {
  const agent = (req && req.headers && req.headers['user-agent']) || '';
  const ip = req ? callerIp(req) : '';
  return hashWithDailySalt(`${ip}|${agent}`);
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

  // `.catch` on both call sites, not decoration: batches() calls JSON.stringify outside
  // sendWithRetry's try, so a row whose Detail cannot be stringified rejects flush() with nothing
  // attached — an unhandled rejection, which terminates the process under Node's default. This
  // module's contract is that it never takes a request down with it; that has to hold here too.
  if (buffer.length >= config.auditMaxBatch) {
    flush().catch((err) => logger.error(`[Audit] flush failed: ${err.message}`));
    return;
  }

  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flush().catch((err) => logger.error(`[Audit] flush failed: ${err.message}`));
    }, config.auditFlushMs);
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
  // Wrapped because rolesFor() and callerIp() run synchronously inside each controller's own try:
  // a throw here would surface as a 500 AFTER the mutation had already been applied, which is the
  // precise failure this module's header says is unacceptable. Recording the action must never be
  // the reason the action reports failure.
  try {
  const actor = actorFor(req);

  enqueue(AUDIT_STREAM, {
    TimeGenerated: new Date().toISOString(),
    // Client-generated so a retried batch is identifiable as the same event rather than a second
    // one. Nothing deduplicates on ingest; a reader dedupes with `arg_min(TimeGenerated, *) by
    // EventId` if duplicates ever show up.
    EventId: crypto.randomUUID(),
    Action: event.action,
    Outcome: event.outcome || 'success',
    // `sub` is the stable Keycloak identifier and survives a rename; ActorName is what a human
    // reads without a Keycloak lookup. Both, because either alone makes a trace worse - see
    // actorFor().
    ActorId: actor.id || 'anonymous',
    ActorName: actor.name,
    ActorType: actor.type,
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
  } catch (err) {
    logger.error(`[Audit] could not record ${event && event.action}: ${err.message}`);
  }
}

/**
 * Record a usage event. Deliberately carries no durable identity — see anonId above.
 *
 * @param {object} req    Express request.
 * @param {object} event  { eventName, projectId, documentId, searchTerm, resultCount, detail }
 */
function analyticsEvent(req, event) {
  const headers = (req && req.headers) || {};
  // The availability web test searches every 5 minutes from 5 probe locations — 1,440 synthetic
  // searches a day, which would read as usage. Caller-supplied and so spoofable: this suppresses a
  // usage COUNTER only. auditEvent's trail is untouched and no access decision reads it.
  if (headers['x-synthetic-probe']) return;
  // Same guard, same reason — see auditEvent.
  try {
  const actor = actorFor(req);

  enqueue(EVENTS_STREAM, {
    TimeGenerated: new Date().toISOString(),
    EventName: event.eventName,
    // Anonymous ONLY while the caller is anonymous. A signed-in user's activity is attributable -
    // staff searching the corpus is exactly the thing an investigator needs to be able to trace,
    // and pretending otherwise would make this table useless for the question it will be asked.
    // Public traffic still carries nothing but the rotating hash below.
    ActorId: actor.id,
    ActorName: actor.name,
    ActorType: actor.type,
    // Kept for everyone, signed-in included: it is the join key for counting distinct callers, and
    // for anonymous traffic it is the ONLY identifier - salted daily so it stops being linkable on
    // its own.
    AnonId: anonId(req),
    // Hashed under the SAME rotating salt as AnonId, and that is load-bearing. Stored raw, this is
    // caller-supplied and stable for as long as the client chooses to reuse it — so joining on it
    // would re-link one person's searches straight across the salt rotation, which is exactly the
    // linkage the rotation exists to break. Hashing keeps within-day session stitching and drops
    // the cross-day trail, which is the whole reason this table needs no deletion path.
    SessionId: headers['x-session-id'] ? hashWithDailySalt(headers['x-session-id']) : '',
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
  } catch (err) {
    logger.error(`[Audit] could not record ${event && event.eventName}: ${err.message}`);
  }
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

/**
 * What a dropped row may say in the application log.
 *
 * The DCR transform is the masking boundary for the happy path and is deliberately impossible to
 * bypass from the app. This is the one path that goes around it, so it re-applies the same idea by
 * hand rather than trusting the destination.
 *
 * Audit: keep the record — who did what to which thing is the entire point, and losing it is the
 * failure this fallback exists to prevent. Drop SourceIp, which the transform would have masked.
 * Analytics: keep nothing identifying. A usage row is only meaningful in aggregate, so an
 * individual one is not worth recovering, and SearchTerm is caller-typed free text.
 */
function redactForLog(stream, row) {
  if (stream === AUDIT_STREAM) {
    const { SourceIp: _dropped, ...rest } = row;
    return rest;
  }
  return {
    TimeGenerated: row.TimeGenerated,
    EventName: row.EventName,
    ProjectId: row.ProjectId,
    Env: row.Env
  };
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
      // Success used to be silent, which made "delivered fine" and "this code never ran"
      // indistinguishable from the outside — the exact ambiguity that cost an afternoon on the
      // first staging deploy.
      //
      // DEBUG, not info, and the distinction is a cost one. This fires per batch per stream per
      // flush: with a 1s interval that is a ≥2 lines/sec floor under sustained load, measured at up
      // to ~50 MB/day, around 10% of the non-prod dailyQuotaGb — spent entirely on a message
      // saying nothing went wrong. Failures still log at `error`, which is the line worth paying
      // for. Raise LOG_LEVEL to debug when you need to prove delivery.
      logger.debug(`[Audit] flushed ${batch.length} row(s) to ${stream}`);
      return;
    } catch (err) {
      if (attempt === 2) {
        // Last resort: the rows are about to be lost and the application log is the only place
        // left to recover them from. But the fallback lands in `demi-logs-<env>`, which sets
        // enableLogAccessUsingOnlyResourcePermissions — deliberately the WIDER read grant — and
        // nothing masks it on the way in. Dumping the raw batch would route unmasked SourceIp and
        // raw SearchTerm around the DCR transform that exists to be unbypassable, and it would do
        // so precisely when the pipeline is under stress.
        //
        // So the two streams are treated differently, by what is worth recovering:
        // audit rows are reconstructable and keep everything but the IP; analytics rows are
        // aggregate by nature, so only their shape survives.
        logger.error(
          `[Audit] dropped ${batch.length} row(s) for ${stream} after 3 attempts: ${err.message} :: ` +
          JSON.stringify(batch.map((row) => redactForLog(stream, row)))
        );
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
