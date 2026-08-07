'use strict';

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

/**
 * Per-caller request limit.
 *
 * This replaced a hand-rolled limiter that had never limited anything in Azure. It keyed on
 * `req.headers['x-forwarded-for']` whole, and App Service APPENDS `<client-ip>:<port>` to that
 * header — the port changes with the TCP connection, so nearly every request produced a new key and
 * the 300/minute ceiling was never reached. Measured against dev on 2026-08-07: 320 requests inside
 * one window all answered 200. Reproduced deterministically in the test beside this file, where the
 * old shape survives 400 requests and the fixed one stops at 300.
 *
 * Two things were wrong and either alone still breaks it:
 *
 *  1. **Take the LAST comma-separated entry.** Everything before it is caller-supplied — a client
 *     can send its own `X-Forwarded-For` and App Service appends the real address after it. Keying
 *     on the whole string, or on the first entry, lets a caller mint a fresh bucket per request just
 *     by varying a header.
 *  2. **Strip the port.** That is the part that made the limit unreachable even for a caller not
 *     trying to evade it.
 *
 * `ipKeyGenerator` is the library's own helper: it normalises IPv6 to a /64 so a caller with a
 * routed prefix cannot mint a bucket per address.
 */

/** The one definition of "who is this caller", shared with the request logger. */
function callerIp(req) {
  const forwarded = String((req.headers && req.headers['x-forwarded-for']) || '');
  const last = forwarded.split(',').pop().trim();
  // IPv4 arrives as `1.2.3.4:5678`; bare IPv6 contains colons of its own, so only strip a port when
  // the tail is a plain `:digits` on something that is not already bracketed.
  const withoutPort = /^\[.*\]:\d+$/.test(last)
    ? last.replace(/^\[(.*)\]:\d+$/, '$1')
    : last.replace(/^([^:]+):\d+$/, '$1');

  return withoutPort || (req.socket && req.socket.remoteAddress) || '127.0.0.1';
}

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 300;

const limiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: MAX_REQUESTS,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // In-memory on purpose. demi-api-dev is a single-worker B1, so there is one process and nothing
  // to share; a Redis store would be a second service to run for no gain.
  keyGenerator: (req) => ipKeyGenerator(callerIp(req)),
  // Several suites make more than 300 requests against a mounted app.
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many requests. Please slow down.' }
});

module.exports = limiter;
module.exports.callerIp = callerIp;
module.exports.MAX_REQUESTS = MAX_REQUESTS;
module.exports.WINDOW_MS = WINDOW_MS;
