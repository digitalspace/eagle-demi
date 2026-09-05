'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { callerIp } = require('../../src/utils/caller-ip');
const config = require('../../src/config');

const GATEWAY_SECRET = 'test-gateway-secret';

/** The rproxy egress address, as TRUSTED_PROXY_IPS would name it. */
const RPROXY = '142.34.64.10';

/** The value eagle-edge's rule set stamps, as EDGE_SECRET would name it. */
const EDGE_SECRET = 'test-edge-secret';

/** An egress address of the Front Door fleet: what APIM sees, never a browser. */
const AFD_EGRESS = '147.243.0.9';

function withConfig(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = config[key];
    config[key] = overrides[key];
  }
  try { return fn(); } finally { Object.assign(config, previous); }
}

function req(headers, socket) {
  return { headers, socket };
}

/** A request the gateway secret proves came through APIM. */
function viaGateway(headers) {
  return req({ 'x-gateway-secret': GATEWAY_SECRET, ...headers });
}

test('callerIp', async (t) => {
  await t.test('takes the LAST hop, not the attacker-forgeable first one', () => {
    // A client can send any value as the first entry; only what App Service appends is trustworthy.
    const forged = req({ 'x-forwarded-for': '203.0.113.9, 10.0.0.4, 142.34.7.9' });
    assert.strictEqual(callerIp(forged), '142.34.7.9');
  });

  await t.test('strips the `:port` App Service appends to the real client IP', () => {
    const withPort = req({ 'x-forwarded-for': '203.0.113.9, 142.34.7.9:54321' });
    assert.strictEqual(callerIp(withPort), '142.34.7.9');
  });

  await t.test('single-entry header, no comma', () => {
    const single = req({ 'x-forwarded-for': '142.34.7.9:443' });
    assert.strictEqual(callerIp(single), '142.34.7.9');
  });

  await t.test('missing header falls back to the socket address', () => {
    const noHeader = req({}, { remoteAddress: '10.1.2.3' });
    assert.strictEqual(callerIp(noHeader), '10.1.2.3');
  });

  await t.test('missing header and no socket falls back to loopback', () => {
    const nothing = req({}, undefined);
    assert.strictEqual(callerIp(nothing), '127.0.0.1');
  });

  await t.test('bracketed IPv6 with a port keeps the address and drops the port', () => {
    const v6WithPort = req({ 'x-forwarded-for': '203.0.113.9, [2001:db8::1]:8080' });
    assert.strictEqual(callerIp(v6WithPort), '2001:db8::1');
  });

  await t.test('bare IPv6 without a port is left whole, not mistaken for a port suffix', () => {
    const v6Bare = req({ 'x-forwarded-for': '2001:db8::1' });
    assert.strictEqual(callerIp(v6Bare), '2001:db8::1');
  });
});

test('callerIp behind APIM', async (t) => {
  t.beforeEach(() => { process.env.APIM_GATEWAY_SECRET = GATEWAY_SECRET; });
  t.afterEach(() => { delete process.env.APIM_GATEWAY_SECRET; });

  await t.test('prefers the address APIM asserts over the forwarded chain', () => {
    // The last forwarded hop is APIM itself, so without this every public caller shares one
    // address — and the per-requester bulk quota becomes a single global bucket.
    const behindApim = viaGateway({
      'x-client-ip': '142.34.7.9',
      'x-forwarded-for': '142.34.7.9, 20.151.0.5:41234'
    });
    assert.strictEqual(callerIp(behindApim), '142.34.7.9');
  });

  await t.test('strips a port APIM included', () => {
    assert.strictEqual(callerIp(viaGateway({ 'x-client-ip': '142.34.7.9:51000' })), '142.34.7.9');
  });

  await t.test('falls back to the forwarded chain when APIM sent no address', () => {
    // The policy that sets the header may not be deployed yet. The old answer is wrong-but-safe;
    // an empty caller id would key every quota row on ''.
    const noAsserted = viaGateway({ 'x-forwarded-for': '142.34.7.9, 20.151.0.5' });
    assert.strictEqual(callerIp(noAsserted), '20.151.0.5');
  });

  await t.test('a client-supplied X-Client-Ip without the gateway secret is ignored', () => {
    // The header is attacker input on the public host: believing it would let any caller mint a
    // fresh quota key per request.
    const spoofed = req({ 'x-client-ip': '9.9.9.9', 'x-forwarded-for': '142.34.7.9' });
    assert.strictEqual(callerIp(spoofed), '142.34.7.9');
  });

  await t.test('a wrong gateway secret does not unlock the asserted header', () => {
    const spoofed = req({
      'x-gateway-secret': 'not-the-secret', 'x-client-ip': '9.9.9.9', 'x-forwarded-for': '142.34.7.9'
    });
    assert.strictEqual(callerIp(spoofed), '142.34.7.9');
  });
});

test('callerIp behind our own rproxy', async (t) => {
  t.beforeEach(() => { process.env.APIM_GATEWAY_SECRET = GATEWAY_SECRET; });
  t.afterEach(() => { delete process.env.APIM_GATEWAY_SECRET; });

  await t.test('takes the rightmost hop that is not ours', () => {
    // Every eagle-public visitor arrives through the rproxy, so keying on what APIM saw would put
    // all of them in one anonymous quota bucket. The chain APIM hands us is
    // `<browser>, <nginx egress>`: nginx passes the router's header through untouched and APIM
    // appends its peer.
    const throughRproxy = viaGateway({
      'x-client-ip': RPROXY,
      'x-forwarded-for': '198.51.100.7, 142.34.64.10'
    });
    assert.strictEqual(withConfig({ trustedProxyIps: [RPROXY] }, () => callerIp(throughRproxy)), '198.51.100.7');
  });

  await t.test('a forged prefix cannot become the quota key', () => {
    // THE reason this walks from the right. Everything left of the real client is whatever the
    // caller chose to send, so taking the first hop would let one browser mint a key per request.
    const forged = viaGateway({
      'x-client-ip': RPROXY,
      'x-forwarded-for': '9.9.9.9, 1.2.3.4, 142.34.64.10'
    });
    assert.strictEqual(withConfig({ trustedProxyIps: [RPROXY] }, () => callerIp(forged)), '1.2.3.4');
  });

  await t.test('a CIDR entry matches the in-cluster router hop', () => {
    const throughRouter = viaGateway({
      'x-client-ip': RPROXY,
      'x-forwarded-for': '198.51.100.7, 10.97.4.31, 142.34.64.10'
    });
    assert.strictEqual(
      withConfig({ trustedProxyIps: [RPROXY, '10.0.0.0/8'] }, () => callerIp(throughRouter)), '198.51.100.7');
  });

  await t.test('strips a port off the browser hop', () => {
    const withPort = viaGateway({
      'x-client-ip': RPROXY, 'x-forwarded-for': '198.51.100.7:52344, 142.34.64.10'
    });
    assert.strictEqual(withConfig({ trustedProxyIps: [RPROXY] }, () => callerIp(withPort)), '198.51.100.7');
  });

  await t.test('a chain of nothing but our own hops falls back to the asserted address', () => {
    const allOurs = viaGateway({ 'x-client-ip': RPROXY, 'x-forwarded-for': '10.97.4.31, 142.34.64.10' });
    assert.strictEqual(
      withConfig({ trustedProxyIps: [RPROXY, '10.0.0.0/8'] }, () => callerIp(allOurs)), RPROXY);
  });

  await t.test('an untrusted asserted address is still the answer', () => {
    // A direct caller: nothing of ours in front of them, so their own address is the quota key and
    // the forwarded chain they sent is theirs to forge.
    const direct = viaGateway({
      'x-client-ip': '203.0.113.5', 'x-forwarded-for': '198.51.100.7, 20.151.0.5'
    });
    assert.strictEqual(withConfig({ trustedProxyIps: [RPROXY] }, () => callerIp(direct)), '203.0.113.5');
  });

  await t.test('a trusted proxy with no forwarded chain keeps the asserted address', () => {
    const noChain = viaGateway({ 'x-client-ip': RPROXY });
    assert.strictEqual(withConfig({ trustedProxyIps: [RPROXY] }, () => callerIp(noChain)), RPROXY);
  });

  await t.test('the chain is not walked without the gateway secret', () => {
    // Without the secret the whole chain is attacker input: naming a trusted proxy in X-Client-Ip
    // would otherwise let any caller pick which hop becomes their quota key.
    const spoofed = req({ 'x-client-ip': RPROXY, 'x-forwarded-for': '198.51.100.7, 142.34.7.9' });
    assert.strictEqual(withConfig({ trustedProxyIps: [RPROXY] }, () => callerIp(spoofed)), '142.34.7.9');
  });

  await t.test('an empty trusted list leaves the APIM behaviour untouched', () => {
    const throughRproxy = viaGateway({
      'x-client-ip': RPROXY, 'x-forwarded-for': '198.51.100.7, 142.34.64.10'
    });
    assert.strictEqual(withConfig({ trustedProxyIps: [] }, () => callerIp(throughRproxy)), RPROXY);
  });
});

test('callerIp behind Front Door', async (t) => {
  t.beforeEach(() => { process.env.APIM_GATEWAY_SECRET = GATEWAY_SECRET; });
  t.afterEach(() => { delete process.env.APIM_GATEWAY_SECRET; });

  /** What eagle-edge's rule set stamps: the shared secret, plus the peer Front Door accepted. */
  function viaEdge(extra) {
    return viaGateway({
      'x-edge-secret': EDGE_SECRET,
      'x-azure-socketip': '198.51.100.7',
      'x-client-ip': AFD_EGRESS,
      'x-forwarded-for': `198.51.100.7, ${AFD_EGRESS}`,
      ...extra
    });
  }

  await t.test('the edge secret makes X-Azure-SocketIP the caller', () => {
    // Front Door terminates the connection, so APIM asserts an AFD egress address for every
    // visitor — which is one shared anonymous bulk quota for all of them.
    assert.strictEqual(
      withConfig({ edgeSecret: EDGE_SECRET }, () => callerIp(viaEdge())), '198.51.100.7');
  });

  await t.test('a wrong edge secret is ignored', () => {
    // Anyone reaching APIM can send the header; only the value eagle-edge stamps unlocks it.
    const forged = viaEdge({ 'x-edge-secret': 'not-the-edge-secret' });
    assert.strictEqual(withConfig({ edgeSecret: EDGE_SECRET }, () => callerIp(forged)), AFD_EGRESS);
  });

  await t.test('a missing edge secret is ignored', () => {
    const bare = viaEdge({ 'x-edge-secret': undefined });
    assert.strictEqual(withConfig({ edgeSecret: EDGE_SECRET }, () => callerIp(bare)), AFD_EGRESS);
  });

  await t.test('an empty EDGE_SECRET leaves the APIM behaviour untouched', () => {
    // The off switch. Without it an empty config would match an empty header from any caller.
    assert.strictEqual(withConfig({ edgeSecret: '' }, () => callerIp(viaEdge())), AFD_EGRESS);
  });

  await t.test('an empty EDGE_SECRET does not match an absent header', () => {
    // The dangerous half of the off switch, and the one a length comparison cannot catch: two
    // empty strings ARE equal, so without the explicit empty guard every caller sending no header
    // at all would be believed and pick its own quota key.
    const bothEmpty = viaEdge({ 'x-edge-secret': undefined, 'x-azure-socketip': '9.9.9.9' });
    assert.strictEqual(withConfig({ edgeSecret: '' }, () => callerIp(bothEmpty)), AFD_EGRESS);
  });

  await t.test('an unresolved Key Vault reference is not a secret', () => {
    const ref = '@Microsoft.KeyVault(SecretUri=https://demi-kv-test.vault.azure.net/secrets/edge-secret)';
    const spoofed = viaEdge({ 'x-edge-secret': ref });
    assert.strictEqual(withConfig({ edgeSecret: ref }, () => callerIp(spoofed)), AFD_EGRESS);
  });

  await t.test('a garbage X-Azure-SocketIP falls back to the forwarded chain', () => {
    // An unusable value must not become the quota key: every caller sending it would share one row.
    for (const garbage of ['not-an-ip', ':', '::::', '1.2.3.4.5', '']) {
      const req_ = viaEdge({ 'x-azure-socketip': garbage });
      assert.strictEqual(
        withConfig({ edgeSecret: EDGE_SECRET }, () => callerIp(req_)), AFD_EGRESS, garbage);
    }
  });

  await t.test('an IPv4-mapped IPv6 socket address is normalized', () => {
    const mapped = viaEdge({ 'x-azure-socketip': '::ffff:198.51.100.7' });
    assert.strictEqual(
      withConfig({ edgeSecret: EDGE_SECRET }, () => callerIp(mapped)), '198.51.100.7');
  });

  await t.test('a bracketed IPv6 socket address is accepted', () => {
    const v6 = viaEdge({ 'x-azure-socketip': '[2001:db8::1]' });
    assert.strictEqual(withConfig({ edgeSecret: EDGE_SECRET }, () => callerIp(v6)), '2001:db8::1');
  });

  await t.test('X-Azure-ClientIP is never consulted, secret or no secret', () => {
    // Front Door derives ClientIP from the caller's own X-Forwarded-For, so a browser picks it.
    const forged = viaEdge({ 'x-azure-socketip': undefined, 'x-azure-clientip': '9.9.9.9' });
    assert.strictEqual(withConfig({ edgeSecret: EDGE_SECRET }, () => callerIp(forged)), AFD_EGRESS);
  });

  await t.test('a socket IP that is our own rproxy is walked past, not keyed on', () => {
    // The prod public path is browser → rproxy → Front Door → APIM, so Front Door's socket peer is
    // the rproxy egress and is the SAME for every visitor. Keying on it collapses the whole
    // anonymous bulk quota onto one row — the exact bug the edge secret exists to avoid.
    const throughRproxy = viaEdge({
      'x-azure-socketip': '142.34.194.121',
      'x-forwarded-for': '198.51.100.7, 142.34.194.121'
    });
    assert.strictEqual(
      withConfig({ edgeSecret: EDGE_SECRET, trustedProxyIps: ['142.34.194.121'] },
        () => callerIp(throughRproxy)), '198.51.100.7');
  });

  await t.test('a socket IP that is not ours is the caller itself', () => {
    // The direct path, with no rproxy in front: Front Door accepted the browser's own connection.
    const direct = viaEdge({
      'x-azure-socketip': '198.51.100.7',
      'x-forwarded-for': `198.51.100.7, ${AFD_EGRESS}`
    });
    assert.strictEqual(
      withConfig({ edgeSecret: EDGE_SECRET, trustedProxyIps: ['142.34.194.121'] },
        () => callerIp(direct)), '198.51.100.7');
  });

  await t.test('the edge secret stands on its own, without the gateway secret', () => {
    // AFD reaches the app through APIM either way, and the two secrets prove different hops.
    const noGateway = req({
      'x-edge-secret': EDGE_SECRET,
      'x-azure-socketip': '198.51.100.7',
      'x-forwarded-for': '142.34.7.9'
    });
    assert.strictEqual(
      withConfig({ edgeSecret: EDGE_SECRET }, () => callerIp(noGateway)), '198.51.100.7');
  });
});
