'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { callerIp } = require('../../src/utils/caller-ip');

function req(headers, socket) {
  return { headers, socket };
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
