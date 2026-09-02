'use strict';

const { fromGateway } = require('../helpers/auth');

/**
 * `1.2.3.4:5678` → `1.2.3.4`, `[2001:db8::1]:8080` → `2001:db8::1`.
 *
 * A bare IPv6 address carries colons of its own, so a port is only stripped from a plain `:digits`
 * tail on something that is not already bracketed.
 */
function stripPort(value) {
  return /^\[.*\]:\d+$/.test(value)
    ? value.replace(/^\[(.*)\]:\d+$/, '$1')
    : value.replace(/^([^:]+):\d+$/, '$1');
}

/**
 * The one definition of "who is this caller", shared by the request log, the audit trail and the
 * bulk-download quota.
 */
function callerIp(req) {
  const headers = (req && req.headers) || {};

  // Behind APIM the last forwarded hop is APIM ITSELF, so every public caller resolves to one
  // address — which would make the per-requester bulk quota a single shared bucket. The gateway
  // policy asserts the address it saw in X-Client-Ip (azure/modules/apim.bicep), and the gateway
  // secret is the whole reason that header can be believed.
  if (fromGateway(req)) {
    const asserted = stripPort(String(headers['x-client-ip'] || '').trim());
    if (asserted) return asserted;
  }

  const forwarded = String(headers['x-forwarded-for'] || '');
  // The LAST entry, never the first: everything before it is caller-supplied, and App Service
  // appends the real `<client-ip>:<port>` after whatever the client sent. Taking the first hop
  // would let any caller mint their own quota key by sending one.
  const last = stripPort(forwarded.split(',').pop().trim());

  return last || (req.socket && req.socket.remoteAddress) || '127.0.0.1';
}

module.exports = { callerIp };
