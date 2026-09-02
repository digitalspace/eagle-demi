'use strict';

const { logger } = require('../utils/logger');
const { callerIp } = require('../utils/caller-ip');

/**
 * A bulk-download job id is a bearer capability — whoever holds it can fetch the zip — so it is
 * masked out of the access log. The route is the grouping anybody wants anyway.
 */
function maskIds(url) {
  return String(url).replace(/\/bulk-downloads\/[^/?]+/, '/bulk-downloads/<id>');
}

/**
 * The per-request access log, called by the dispatcher once the response is complete.
 *
 * Not a `res.on('finish')` wrapper any more: there is no ServerResponse under the Functions host,
 * so the dispatcher's `finally` is the one place that can see a finished response.
 */
function logRequest(req, res, durationMs) {
  const timeMs = Number(durationMs).toFixed(2);
  const { method } = req;
  const originalUrl = maskIds(req.originalUrl);
  // Same resolver the audit trail keys on, so the two can never disagree about who a caller is.
  const ip = callerIp(req);
  const { statusCode } = res;
  const contentLength = res.get('Content-Length') || 0;

  // Caller identity. Guards run before this, so req.user is populated by the time it reads.
  //
  // keyId is the PUBLIC half of a registry key and is safe to log; the secret never appears
  // anywhere. Anonymous requests log as 'anonymous' rather than being left blank, so an absent
  // identity is visibly absent rather than looking like a logging bug.
  const principal = (req.user && req.user.preferred_username) || 'anonymous';
  const credential = req.user && req.user.keyId
    ? ` key=${req.user.keyId}`
    : (req.user && req.user.azp ? ` client=${req.user.azp}` : '');

  // `%` is escaped to `%25` because winston scans the message for printf tokens (/%[scdjifoO%]/)
  // and, when it finds one, treats the meta object below as splat arguments instead of merging it
  // into the record — so `GET /api/search?q=50%off` would silently log with NO structured fields.
  // The URL is caller-supplied, which makes that an audit hole a caller can trigger on purpose.
  const message = (`${method} ${originalUrl} ${statusCode} - ${contentLength} B - ${timeMs}ms ` +
    `(IP: ${ip}, as: ${principal}${credential})`).replace(/%/g, '%25');

  // Structured fields alongside the human-readable line. The winston OpenTelemetry
  // instrumentation copies everything except `message` and `level` into log attributes, which
  // surface as `AppTraces.Properties` — so these become queryable columns in KQL rather than
  // something a dashboard has to parse back out of a formatted string.
  //
  // `path` is deliberately the URL WITHOUT its query string: grouping on the full URL scatters
  // every search across as many buckets as there were search terms, which makes the one query
  // anybody actually wants — requests per route — impossible to write.
  const meta = {
    evt: 'request',
    method,
    path: String(originalUrl).split('?')[0],
    status: statusCode,
    durationMs: Number(timeMs),
    bytes: Number(contentLength),
    ip,
    principal
  };
  if (req.user && req.user.keyId) meta.keyId = req.user.keyId;
  if (req.user && req.user.azp) meta.client = req.user.azp;

  // `evt` is set on every branch, so failed requests land in the same panel as successful ones.
  // A usage report that silently dropped failures would overstate how well the API is working.
  if (statusCode >= 500) {
    logger.error(message, meta);
  } else if (statusCode >= 400) {
    logger.warn(message, meta);
  } else {
    logger.info(message, meta);
  }
}

module.exports = { logRequest };
