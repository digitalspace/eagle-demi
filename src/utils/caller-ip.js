'use strict';

const net = require('node:net');
const { fromGateway, matchesConfiguredKey } = require('../helpers/auth');
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

/**
 * An address we can key a quota on, or `''`.
 *
 * `[2001:db8::1]` → `2001:db8::1` and `::ffff:1.2.3.4` → `1.2.3.4`, so the same browser never gets
 * two quota rows depending on which form the hop wrote.
 */
function normalizeIp(value) {
  const bare = value.replace(/^\[(.*)\]$/, '$1');
  const mapped = /^::ffff:(.+)$/i.exec(bare);
  const ip = mapped && net.isIP(mapped[1]) === 4 ? mapped[1] : bare;
  return net.isIP(ip) ? ip : '';
}

/**
 * Is this request provably stamped by the eagle-edge Front Door rule set?
 *
 * Empty config is the off switch, and an unresolved Key Vault reference arrives as the literal
 * `@Microsoft.KeyVault(...)` string, which is public in this repository — same rule as the gateway
 * secret in helpers/auth.js.
 */
function fromEdge(headers) {
  const secret = config.edgeSecret;
  if (!secret || secret.startsWith('@Microsoft.KeyVault')) return false;

  return matchesConfiguredKey(headers['x-edge-secret'] || '', [secret]);
}

/** A hop we run: a plain address, or a range for the in-cluster router hop (`10.0.0.0/8`). */
function isTrustedProxy(ip) {
  return config.trustedProxyIps.some(
    entry => (entry.includes('/') ? inCidr(ip, entry) : entry === ip));
}

/**
 * The caller behind `asserted` — an address some hop we believe says it saw the request from.
 *
 * Where that address is a proxy WE run, every eagle-public visitor reaches us through it and the
 * asserted address is the same for all of them, so the anonymous quota would be one shared bucket.
 * The chain is then `[whatever the caller prepended,] <browser>, <our egress>` — so walk LEFTWARDS
 * and take the first hop that is not ours. Anything further left is caller-supplied and never
 * reached. Not one of ours, or nothing but ours in the chain: the asserted address is the answer.
 *
 * `anchored` starts that walk at the asserted hop's own position rather than at the end of the
 * chain. Front Door needs it: by the time DEMI reads the header the chain is
 * `<browser>, <rproxy>, <AFD egress>`, because Front Door appended its socket peer and APIM then
 * appended Front Door. Everything RIGHT of the hop that named `asserted` was written by those
 * later hops and is never the browser — an unanchored walk stops on the AFD egress and hands every
 * visitor the same key again.
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

  // Front Door terminates the connection one hop outside APIM, so the address APIM asserts is an
  // AFD egress shared by every visitor. X-Azure-SocketIP is the peer Front Door itself accepted
  // the connection from; X-Azure-ClientIP is derived from the caller's own X-Forwarded-For and any
  // browser can pick it, so it is never read here. Checked ahead of the gateway branch because
  // this is a different hop's proof — AFD reaches us through APIM either way.
  // ponytail: the trust is only as good as the secret's rotation; Private Link from Front Door to APIM would drop the header trust entirely.
  if (fromEdge(headers)) {
    // Front Door's own socket peer is the OpenShift rproxy on the public path
    // (browser → rproxy → Front Door → APIM), so this is not automatically the browser either —
    // walk on past it, anchored at the hop Front Door saw.
    const socketIp = normalizeIp(stripPort(String(headers['x-azure-socketip'] || '').trim()));
    if (socketIp) return behindProxy(socketIp, headers, { anchored: true });
  }

  // Behind APIM the last forwarded hop is APIM ITSELF, so every public caller resolves to one
  // address — which would make the per-requester bulk quota a single shared bucket. The gateway
  // policy asserts the address it saw in X-Client-Ip (azure/modules/apim.bicep), and the gateway
  // secret is the whole reason that header can be believed.
  if (fromGateway(req)) {
    const asserted = stripPort(String(headers['x-client-ip'] || '').trim());
    if (asserted) return behindProxy(asserted, headers);
  }

  const forwarded = String(headers['x-forwarded-for'] || '');
  // The LAST entry, never the first: everything before it is caller-supplied, and App Service
  // appends the real `<client-ip>:<port>` after whatever the client sent. Taking the first hop
  // would let any caller mint their own quota key by sending one.
  const last = stripPort(forwarded.split(',').pop().trim());

  return last || (req.socket && req.socket.remoteAddress) || '127.0.0.1';
}

module.exports = { callerIp };
