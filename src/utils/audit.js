'use strict';

/**
 * Audit trail (EagleAudit_CL, fallback DemiAudit_CL) and usage counters (DemiEvents_CL), each sent
 * through a Direct DCR. Never fails a request: rows buffer in memory and flush on a timer.
 */

const crypto = require('crypto');
const config = require('../config');
const { logger } = require('./logger');
const { callerIp } = require('./caller-ip');
const { rolesFor } = require('../helpers/access-sql');
const azureCredential = require('./azure-credential');

// Which audit table this environment writes to is a deployment fact, not a code one — see
// config.auditStream. The events stream is not: nothing else ever holds DemiEvents_CL.
const AUDIT_STREAM = config.auditStream;
const EVENTS_STREAM = 'Custom-DemiEvents_CL';

// This app's name in EagleAudit_CL, which holds every EPIC app's rows. Ignored by DemiAudit_CL,
// whose stream declaration has no such column, so the fallback destination is unaffected.
const SOURCE_APP = 'eagle-demi';

// Buffered rows, keyed by stream. Flushed together, one HTTP call per stream.
const buffers = new Map([
  [AUDIT_STREAM, []],
  [EVENTS_STREAM, []]
]);

let flushTimer = null;
const warnedStreams = new Set();

// Swapped by _setTransport in tests.
let sendBatch = postToIngestionApi;
let getToken = fetchIngestionToken;

/** The DCR a stream is sent to. Both empty turns that stream off. */
function destinationFor(stream) {
  return stream === EVENTS_STREAM
    ? { endpoint: config.eventsDcrEndpoint, immutableId: config.eventsDcrImmutableId }
    : { endpoint: config.auditDcrEndpoint, immutableId: config.auditDcrImmutableId };
}

function enabled(stream) {
  const { endpoint, immutableId } = destinationFor(stream);
  return Boolean(endpoint && immutableId);
}

/**
 * Salt behind AnonId, rotated every UTC day so DemiEvents_CL never stores an id that outlives a day.
 * ponytail: in-memory salt, so a restart mid-day over-counts dcount(AnonId); persist it if exact.
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
 * Who did this, from the verified token only, never a header or query param. Records a stable id
 * and a readable name: `sub` alone needs a Keycloak lookup, a username alone breaks on rename.
 */
function actorFor(req) {
  const user = (req && req.user) || null;
  if (!user) return { id: '', name: '', type: 'anonymous' };

  const name = user.preferred_username || '';

  // A registry key: its own principal, with its own roles, expiry and revocation.
  if (user.keyId) return { id: user.keyId, name, type: 'api-key' };

  // Keycloak service account (client_credentials). It also carries `sub`, so it is checked
  // before the person branch, or a shared client secret would be filed as a person.
  if (user.clientId || name.startsWith('service-account-')) {
    return {
      id: user.sub || user.clientId || name,
      name: name || `service-account-${user.clientId}`,
      type: 'service'
    };
  }

  // Break-glass ADMIN_API_KEY: a shared credential, not a person. Requires no `sub`, so a real
  // Keycloak user named 'internal-service' cannot be filed here.
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
  if (!enabled(stream)) {
    if (!warnedStreams.has(stream)) {
      warnedStreams.add(stream);
      logger.warn(`[Audit] no data collection rule configured for ${stream}; those rows are being discarded.`);
    }
    return;
  }

  const buffer = buffers.get(stream);
  buffer.push(row);

  // batches() stringifies outside sendWithRetry's try, so flush() can reject; left unhandled,
  // that rejection would end the process.
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
  // Runs inside each controller's try: a throw here would report a 500 after the write landed.
  try {
  const actor = actorFor(req);

  enqueue(AUDIT_STREAM, {
    TimeGenerated: new Date().toISOString(),
    // Client-generated so a retried batch keeps its id. Nothing dedupes on ingest; readers
    // dedupe by EventId.
    EventId: crypto.randomUUID(),
    // Which app acted. EagleAudit_CL carries every EPIC app's rows, so a reader that does not
    // filter on this is reading somebody else's trail — GET /admin/audit filters on it.
    SourceApp: SOURCE_APP,
    Action: event.action,
    Outcome: event.outcome || 'success',
    // Stable id and readable name, see actorFor().
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
  // The availability web test sends this on every probe. Spoofable, so it only skips this usage
  // counter; audit rows and access checks never read it.
  if (headers['x-synthetic-probe']) return;
  // Same guard, same reason — see auditEvent.
  try {
  const actor = actorFor(req);

  enqueue(EVENTS_STREAM, {
    TimeGenerated: new Date().toISOString(),
    EventName: event.eventName,
    // Anonymous only while the caller is: staff activity must stay traceable. Public traffic
    // carries only the rotating AnonId hash.
    ActorId: actor.id,
    ActorName: actor.name,
    ActorType: actor.type,
    // Join key for distinct callers, and the only id for anonymous traffic; salted daily so it
    // cannot be linked across days.
    AnonId: anonId(req),
    // Hashed under the same daily salt as AnonId: a raw caller-chosen id would re-link one
    // person's searches across salt rotations.
    SessionId: headers['x-session-id'] ? hashWithDailySalt(headers['x-session-id']) : '',
    ProjectId: event.projectId ? String(event.projectId) : '',
    DocumentId: event.documentId ? String(event.documentId) : '',
    // Caller-typed free text: the one field here with real disclosure risk.
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
 * Split rows into batches under the count and byte limits. The ingestion API rejects a body over
 * 1 MB, and one row with a large `Detail` can be tens of KB.
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
 * What a dropped row may say in the app log, the one path around the DCR masking transform.
 * Audit rows keep all but SourceIp; analytics rows keep only their shape.
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
  return azureCredential.getToken('https://monitor.azure.com/.default');
}

async function postToIngestionApi(stream, rows) {
  const token = await getToken();
  if (!token) throw new Error('no token for https://monitor.azure.com');

  const { endpoint, immutableId } = destinationFor(stream);
  const url = `${endpoint}/dataCollectionRules/${immutableId}` +
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
      // Debug, not info: a success line per batch costs about 10% of the non-prod daily log
      // quota. Set LOG_LEVEL=debug to prove delivery.
      logger.debug(`[Audit] flushed ${batch.length} row(s) to ${stream}`);
      return;
    } catch (err) {
      if (attempt === 2) {
        // Last resort before the rows are lost. demi-logs-<env> has a wider read grant and no
        // masking, so rows are redacted first (see redactForLog).
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
  SOURCE_APP,
  // Test seams only.
  _setTransport: (send, token) => { sendBatch = send; getToken = token || (async () => 'test-token'); },
  _resetTransport: () => { sendBatch = postToIngestionApi; getToken = fetchIngestionToken; },
  _batches: batches,
  _destinationFor: destinationFor
};
