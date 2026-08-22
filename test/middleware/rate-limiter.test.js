'use strict';

/**
 * The defect this replaced: the limiter keyed on the whole `X-Forwarded-For` header. App Service
 * APPENDS `<client-ip>:<port>` to it, and the port changes per TCP connection, so nearly every
 * request produced a new key and the 300/minute ceiling was never reached. Measured against dev on
 * 2026-08-07: 320 requests inside one window all answered 200.
 *
 * These tests run against the resolver rather than the middleware, because the key is the whole
 * bug — a limiter that counts correctly against the wrong key is still not a limiter.
 */

process.env.NODE_ENV = 'testing-rate-limiter';

const test = require('node:test');
const assert = require('node:assert');

const { callerIp } = require('../../src/middleware/rate-limiter');

function req(xff, remoteAddress) {
  return { headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress } };
}

test('the rotating port App Service appends does not change the key', () => {
  // This is the one that made the old limiter inert. Same caller, three connections.
  const keys = new Set([
    callerIp(req('207.81.62.129:40001')),
    callerIp(req('207.81.62.129:52318')),
    callerIp(req('207.81.62.129:61004'))
  ]);
  assert.deepStrictEqual([...keys], ['207.81.62.129'], 'one caller must be one key');
});

test('a forged leading entry cannot mint a fresh bucket', () => {
  // A client may send its own X-Forwarded-For; App Service appends the real address AFTER it.
  // Keying on the whole string, or on the first entry, hands out a new bucket per request.
  const forged = [
    callerIp(req('203.0.113.7, 207.81.62.129:40001')),
    callerIp(req('198.51.100.99, 207.81.62.129:40002')),
    callerIp(req('this-is-not-an-ip, 207.81.62.129:40003'))
  ];
  assert.deepStrictEqual(forged, ['207.81.62.129', '207.81.62.129', '207.81.62.129']);
});

test('IPv6 survives with its own colons intact', () => {
  // Bare IPv6 is full of colons; only a bracketed `[addr]:port` carries a port to strip.
  assert.strictEqual(callerIp(req('2001:db8::1')), '2001:db8::1');
  assert.strictEqual(callerIp(req('[2001:db8::1]:443')), '2001:db8::1');
});

test('it falls back rather than keying everything together as undefined', () => {
  assert.strictEqual(callerIp(req(undefined, '10.0.0.4')), '10.0.0.4');
  assert.strictEqual(callerIp(req('')), '127.0.0.1');
  assert.strictEqual(callerIp({ headers: {} }), '127.0.0.1');
});

test('the old whole-header key is what the fix removes', () => {
  // Guard against a well-meaning revert: if these two ever produce the same key again, the
  // limiter is back to counting connections instead of callers.
  const oldKey = (xff) => xff;
  assert.notStrictEqual(
    oldKey('207.81.62.129:40001'),
    oldKey('207.81.62.129:40002'),
    'the old key really did vary per connection'
  );
  assert.strictEqual(
    callerIp(req('207.81.62.129:40001')),
    callerIp(req('207.81.62.129:40002')),
    'the new key does not'
  );
});

/**
 * RATE_LIMIT_MAX_REQUESTS is read once, at require time, so each case below re-requires the module
 * with its cache entry busted. Guarding the parse and not just the happy path is the point: an
 * unset limit is not a lenient limit, it is no limit at all, and a typo'd app setting must not be
 * how this app loses its ceiling.
 */
function maxRequestsWith(value) {
  const modulePath = require.resolve('../../src/middleware/rate-limiter');
  delete require.cache[modulePath];
  if (value === undefined) {
    delete process.env.RATE_LIMIT_MAX_REQUESTS;
  } else {
    process.env.RATE_LIMIT_MAX_REQUESTS = value;
  }
  try {
    return require(modulePath).MAX_REQUESTS;
  } finally {
    delete require.cache[modulePath];
    delete process.env.RATE_LIMIT_MAX_REQUESTS;
  }
}

test('an unusable RATE_LIMIT_MAX_REQUESTS falls back to 300 instead of removing the ceiling', () => {
  assert.strictEqual(maxRequestsWith(undefined), 300, 'unset means the default, not unlimited');
  for (const bad of ['', '   ', 'abc', '0', '-5', '300.5']) {
    assert.strictEqual(maxRequestsWith(bad), 300, `${JSON.stringify(bad)} must not move the ceiling`);
  }
});

test('a usable RATE_LIMIT_MAX_REQUESTS raises the ceiling', () => {
  // The reason the setting exists: behind a proxy that sets no X-Forwarded-For this is one global
  // bucket, and 300/minute is 5 r/s for every caller combined.
  assert.strictEqual(maxRequestsWith('2000'), 2000);
});
