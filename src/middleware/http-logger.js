'use strict';

const { logger } = require('../utils/logger');
const { callerIp } = require('../utils/caller-ip');

// A bulk-download job id is a bearer capability and a suggest query a per-keystroke prefix, so this
// request line omits both; the Functions host's own request telemetry is not covered here.
function maskIds(url) {
  const masked = String(url).replace(/\/bulk-downloads\/[^/?]+/, '/bulk-downloads/<id>');
  return /^(?:\/api)?\/suggest[/]*(\?|$)/.test(masked) ? masked.split('?')[0] : masked;
}

// Called by the dispatcher once the response is complete;
// there is no ServerResponse under the Functions host.
function logRequest(req, res, durationMs) {
  const timeMs = Number(durationMs).toFixed(2);
  const { method } = req;
  const originalUrl = maskIds(req.originalUrl);
  // Same resolver the audit trail keys on, so the two can never disagree about who a caller is.
  const ip = callerIp(req);
  const { statusCode } = res;
  // A HEAD's Content-Length is the size of the file it describes; nothing was sent.
  const contentLength = method === 'HEAD' ? 0 : (res.get('Content-Length') || 0);

  // keyId is the public half of a registry key;
  // anonymous logs as 'anonymous' so an absent user is visible.
  const principal = (req.user && req.user.preferred_username) || 'anonymous';
  const credential = req.user && req.user.keyId
    ? ` key=${req.user.keyId}`
    : (req.user && req.user.azp ? ` client=${req.user.azp}` : '');

  // winston treats % printf tokens as splat markers and drops the meta object, so escape %.
  const message = (`${method} ${originalUrl} ${statusCode} - ${contentLength} B - ${timeMs}ms ` +
    `(IP: ${ip}, as: ${principal}${credential})`).replace(/%/g, '%25');

  // OTel winston instrumentation copies these into AppTraces.Properties as KQL columns.
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

module.exports = { logRequest, maskIds };
