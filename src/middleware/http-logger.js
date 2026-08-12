'use strict';

const { logger } = require('../utils/logger');
const { callerIp } = require('./rate-limiter');

module.exports = (req, res, next) => {
  const start = process.hrtime();

  // Capture completion event of response to log metrics
  res.on('finish', () => {
    const diff = process.hrtime(start);
    const timeMs = ((diff[0] * 1e9 + diff[1]) / 1e6).toFixed(2);
    const { method, originalUrl } = req;
    // Same resolver the rate limiter keys on, so the log and the limit can never disagree about
    // who a caller is. It used to log the raw X-Forwarded-For, which is caller-supplied ahead of
    // the entry App Service appends — an attacker-chosen string in the audit trail.
    const ip = callerIp(req);
    const { statusCode } = res;
    const contentLength = res.get('Content-Length') || 0;

    // Caller identity. This middleware runs BEFORE any auth middleware, but the finish handler
    // fires after, so req.user is populated by the time this closure reads it. Without this a
    // request log could not answer "which consumer did that?" — the question that matters the
    // moment more than one service holds a credential.
    //
    // keyId is the PUBLIC half of a registry key and is safe to log; the secret never appears
    // anywhere. Anonymous requests log as 'anonymous' rather than being left blank, so an absent
    // identity is visibly absent rather than looking like a logging bug.
    const principal = (req.user && req.user.preferred_username) || 'anonymous';
    const credential = req.user && req.user.keyId
      ? ` key=${req.user.keyId}`
      : (req.user && req.user.azp ? ` client=${req.user.azp}` : '');

    const message = `${method} ${originalUrl} ${statusCode} - ${contentLength} B - ${timeMs}ms ` +
      `(IP: ${ip}, as: ${principal}${credential})`;

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
  });

  next();
};
