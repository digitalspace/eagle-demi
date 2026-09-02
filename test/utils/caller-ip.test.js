'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { callerIp } = require('../../src/utils/caller-ip');

const GATEWAY_SECRET = 'test-gateway-secret';

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
