'use strict';

const net = require('node:net');
const { fromGateway, matchesConfiguredKey } = require('../helpers/auth');
const config = require('../config');
const { acceptedValues } = require('./rotating-secret');

/**
 * `1.2.3.4:5678` → `1.2.3.4`, `[2001:db8::1]:8080` → `2001:db8::1`. A bare IPv6 address keeps its
 * colons: only a bracketed address or one with no other colon loses a `:digits` tail.
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

/**
 * An address to key a quota on, or `''`. Brackets and `::ffff:` are dropped so one browser never
 * gets two quota rows.
 */
function normalizeIp(value) {
  const bare = value.replace(/^\[(.*)\]$/, '$1');
  const mapped = /^::ffff:(.+)$/i.exec(bare);
  const ip = mapped && net.isIP(mapped[1]) === 4 ? mapped[1] : bare;
  return net.isIP(ip) ? ip : '';
}

/** Is this request provably stamped by the eagle-edge Front Door rule set? No accepted value = off. */
function fromEdge(headers) {
  const accepted = acceptedValues('EDGE_SECRET');
  if (accepted.length === 0) return false;

  return matchesConfiguredKey(headers['x-edge-secret'] || '', accepted);
}

/** A hop we run: a plain address, or a range for the in-cluster router hop (`10.0.0.0/8`). */
function isTrustedProxy(ip) {
  return config.trustedProxyIps.some(
    entry => (entry.includes('/') ? inCidr(ip, entry) : entry === ip));
}

/**
 * The caller behind `asserted`. When `asserted` is our own proxy, walk X-Forwarded-For leftwards to
 * the first hop not ours; `anchored` starts at the asserted hop, since hops right of it are ours.
 */
function behindProxy(asserted, headers, { anchored = false } = {}) {
  if (!isTrustedProxy(asserted)) return asserted;

  const hops = String(headers['x-forwarded-for'] || '')
    .split(',').map(hop => stripPort(hop.trim())).filter(Boolean);

  let start = hops.length - 1;
  if (anchored) {
    // Rightmost occurrence: a caller can prepend our egress address, and only the entry the real
    // hop appended is at or right of that forgery.
    start = hops.lastIndexOf(asserted);
  }

  for (let i = start; i >= 0; i--) {
    if (!isTrustedProxy(hops[i])) return hops[i];
  }
  return asserted;
}

/**
 * The one definition of "who is this caller", shared by the request log, the audit trail and the
 * bulk-download quota.
 */
function callerIp(req) {
  const headers = (req && req.headers) || {};

  // Behind Front Door, trust X-Azure-SocketIP, never X-Azure-ClientIP (any browser can set it).
  // ponytail: a shared header secret, rotated through utils/rotating-secret.js; Private Link from Front Door to APIM would drop the header trust entirely.
  if (fromEdge(headers)) {
    const socketIp = normalizeIp(stripPort(String(headers['x-azure-socketip'] || '').trim()));
    if (socketIp) return behindProxy(socketIp, headers, { anchored: true });
  }

  // Behind APIM the last forwarded hop is APIM itself. Its policy asserts X-Client-Ip, believed only
  // because fromGateway() proves the gateway secret.
  if (fromGateway(req)) {
    const asserted = stripPort(String(headers['x-client-ip'] || '').trim());
    if (asserted) return behindProxy(asserted, headers);
  }

  const forwarded = String(headers['x-forwarded-for'] || '');
  // The last entry, never the first: everything before it is caller-supplied, so the first would
  // let any caller mint their own quota key.
  const last = stripPort(forwarded.split(',').pop().trim());

  return last || (req.socket && req.socket.remoteAddress) || '127.0.0.1';
}

module.exports = { callerIp, fromEdge };
