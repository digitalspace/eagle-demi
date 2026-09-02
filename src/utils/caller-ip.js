'use strict';

const { fromGateway } = require('../helpers/auth');
const config = require('../config');

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

/** IPv4 dotted quad → number, or null for anything else (an IPv6 hop never matches a CIDR here). */
function ipToLong(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = value * 256 + Number(part);
  }
  return value;
}

/** IPv4 only, which is what an OpenShift pod network and an Azure egress both are. */
function inCidr(ip, cidr) {
  const [base, width] = cidr.split('/');
  const bits = Number(width);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const address = ipToLong(ip);
  const network = ipToLong(base);
  if (address === null || network === null) return false;
  const mask = (-1 << (32 - bits)) >>> 0;
  return ((address & mask) >>> 0) === ((network & mask) >>> 0);
}

/** A hop we run: a plain address, or a range for the in-cluster router hop (`10.0.0.0/8`). */
function isTrustedProxy(ip) {
  return config.trustedProxyIps.some(
    entry => (entry.includes('/') ? inCidr(ip, entry) : entry === ip));
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
    // Further back when the address APIM saw is a proxy WE run: every eagle-public visitor reaches
    // us through the OpenShift rproxy, so the asserted address is the same for all of them and the
    // anonymous quota would be one shared bucket. The chain is then
    // `[whatever the caller prepended,] <browser>, <nginx egress>` — so walk from the RIGHT and take
    // the first hop that is not ours. Anything left of it is caller-supplied and never reached.
    if (asserted && isTrustedProxy(asserted)) {
      const hops = String(headers['x-forwarded-for'] || '')
        .split(',').map(hop => stripPort(hop.trim())).filter(Boolean);
      for (let i = hops.length - 1; i >= 0; i--) {
        if (!isTrustedProxy(hops[i])) return hops[i];
      }
    }
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
