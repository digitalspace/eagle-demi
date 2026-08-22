'use strict';

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

/**
 * Per-caller request limit.
 *
 * This replaced a hand-rolled limiter that had never limited anything in Azure. It keyed on
 * `req.headers['x-forwarded-for']` whole, and App Service APPENDS `<client-ip>:<port>` to that
 * header — the port changes with the TCP connection, so nearly every request produced a new key and
 * the 300/minute ceiling was never reached. Measured against dev on 2026-08-07: 320 requests inside
 * one window all answered 200. The test beside this file covers the key derivation, not the
 * ceiling — nothing there issues 400 requests, so the 320-request measurement above is the only
 * evidence for the behaviour and it is not reproduced automatically.
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

/**
 * The ceiling is env-driven because it does not mean the same thing on every path into this app.
 *
 * Direct callers to demi-api-<env>.azurewebsites.net are limited per-caller, which is what the
 * whole `callerIp` fix above is about: App Service appends `<connecting-ip>:<port>`, the last
 * entry is the real client, one caller is one bucket.
 *
 * Put a reverse proxy in front and that inverts. eao-nginx sets NO `proxy_set_header
 * X-Forwarded-For` anywhere in conf.d/server.conf.tmpl (its only mention of the header is a
 * commented-out `real_ip_header`), so nothing carries the browser's address across the hop; App
 * Service then appends rproxy's own egress address, `callerIp` takes the LAST entry, and every
 * request through that proxy keys to the same string. Not per-caller — ONE GLOBAL BUCKET. 300/min
 * is 5 r/s for the entire public site, while rproxy itself admits 10 r/s per IP on the search zone
 * (`limit_req zone=api_search rate=10r/s`, burst 20). A single client search-as-you-type can
 * outrun the global ceiling on its own and 429 everyone else.
 *
 * So on a proxied path this stops being a per-caller limit and becomes a global circuit breaker,
 * and the number should be raised to suit that job — the real per-IP control there is rproxy's
 * `limit_req`, which keys on `$binary_remote_addr` and is not fooled by any of this. The default
 * stays 300 because it is right for the direct path, which is the only one live today. It is NOT
 * right for the proxied one: eao-nginx now carries `location = /demi-search/search` proxying to
 * demi-api-test, so the moment that release ships and SEARCH_API_PATH points at it, every visitor
 * to test shares this single bucket. Raise RATE_LIMIT_MAX_REQUESTS in the same change that turns
 * that path on — see the eagle-search fold in TODO.md.
 *
 * RATE_LIMIT_MAX_REQUESTS has a home in `azure/modules/api-web-app.bicep` and is therefore safe to
 * change there. It must NOT be set by hand: that module's appSettings is a whole-collection PUT,
 * so a hand-set value the template does not declare is deleted by the next infra deploy, silently,
 * and the ceiling snaps back to the default.
 *
 * Parsed strictly: a blank, non-numeric, fractional or non-positive value falls back to the
 * default. An unset limit is not a lenient limit, it is no limit at all, and a typo'd app setting
 * must not be the way this app loses its ceiling.
 */
const DEFAULT_MAX_REQUESTS = 300;
const configuredMax = Number(process.env.RATE_LIMIT_MAX_REQUESTS);
const MAX_REQUESTS =
  Number.isInteger(configuredMax) && configuredMax > 0 ? configuredMax : DEFAULT_MAX_REQUESTS;

const limiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: MAX_REQUESTS,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // In-memory on purpose. The API runs a single worker on B1, so there is one process and nothing
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
