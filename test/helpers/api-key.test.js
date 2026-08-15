'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { generateKey, parseKey, verify, defaultExpiry, sha256 } = require('../../src/helpers/api-key');

// A credential check that only ever gets valid input proves nothing. Every case below is paired:
// the accept path AND the specific reject path it must not confuse with success.

test('generateKey', async (t) => {
  await t.test('mints a parseable key whose plaintext is never the stored value', () => {
    const { keyId, plaintext, hash } = generateKey('dev');
    const parsed = parseKey(plaintext);

    assert.ok(parsed, 'minted key must parse');
    assert.strictEqual(parsed.keyId, keyId);
    assert.strictEqual(parsed.env, 'dev');
    assert.notStrictEqual(hash, parsed.secret, 'the secret must not be stored verbatim');
    assert.strictEqual(hash, sha256(parsed.secret));
  });

  await t.test('two keys never collide', () => {
    const a = generateKey('dev');
    const b = generateKey('dev');
    assert.notStrictEqual(a.keyId, b.keyId);
    assert.notStrictEqual(a.plaintext, b.plaintext);
  });

  await t.test('the environment tag rides along so a dev key is visibly not a prod key', () => {
    assert.strictEqual(parseKey(generateKey('prod').plaintext).env, 'prod');
  });
});

test('parseKey', async (t) => {
  await t.test('accepts a secret containing underscores', () => {
    // base64url's alphabet includes '_', so real secrets contain them routinely. A fixed
    // four-part split rejected those keys — and only for the fraction of randomly generated
    // secrets that happened to contain one, which is exactly the kind of intermittent auth
    // failure that gets blamed on the network. Deterministic on purpose: the round-trip test
    // above catches this only by luck.
    const parsed = parseKey('demi_dev_abc123_aa_bb-cc_dd');
    assert.ok(parsed);
    assert.strictEqual(parsed.keyId, 'abc123');
    assert.strictEqual(parsed.secret, 'aa_bb-cc_dd');
  });

  await t.test('round-trips every generated key, underscores or not', () => {
    for (let i = 0; i < 200; i++) {
      const { keyId, plaintext } = generateKey('dev');
      const parsed = parseKey(plaintext);
      assert.ok(parsed, `generated key must parse: ${plaintext}`);
      assert.strictEqual(parsed.keyId, keyId);
    }
  });

  await t.test('rejects anything that is not one of ours', () => {
    // This is what decides whether the registry is consulted at all — a false positive here
    // would send the break-glass key down the registry path and lock it out.
    for (const bad of ['', 'not-a-key', 'demi_dev_onlythree', 'x_dev_abc_secret',
      'demi__abc_secret', 'demi_dev__secret', 'demi_dev_abc_', null, undefined, 42, {}]) {
      assert.strictEqual(parseKey(bad), null, `${JSON.stringify(bad)} must not parse`);
    }
  });
});

test('verify', async (t) => {
  const { plaintext, hash } = generateKey('dev');
  const secret = parseKey(plaintext).secret;
  const live = { hash, revokedAt: null, expiresAt: defaultExpiry() };

  await t.test('accepts the right secret', () => {
    assert.strictEqual(verify(live, secret), true);
  });

  await t.test('rejects a wrong secret', () => {
    assert.strictEqual(verify(live, parseKey(generateKey('dev').plaintext).secret), false);
  });

  await t.test('rejects a revoked key even with the right secret', () => {
    assert.strictEqual(verify({ ...live, revokedAt: new Date().toISOString() }, secret), false);
  });

  await t.test('rejects an expired key even with the right secret', () => {
    const expired = { ...live, expiresAt: new Date(Date.now() - 1000).toISOString() };
    assert.strictEqual(verify(expired, secret), false);
  });

  await t.test('expiry is evaluated against the injected clock, not wall time', () => {
    const future = Date.now() + 200 * 24 * 60 * 60 * 1000;
    assert.strictEqual(verify(live, secret, future), false, 'must expire once the clock passes it');
    assert.strictEqual(verify(live, secret, Date.now()), true, 'and be live before that');
  });

  await t.test('an unparseable expiry is not "never expires"', () => {
    for (const bad of ['banana', {}, '2026-13-45']) {
      assert.strictEqual(verify({ ...live, expiresAt: bad }, secret), false,
        `expiresAt ${JSON.stringify(bad)} must not verify`);
    }
    assert.strictEqual(verify({ ...live, expiresAt: null }, secret), true,
      'no expiry at all still means no expiry');
  });

  await t.test('fails closed on a malformed or missing record', () => {
    for (const bad of [null, undefined, {}, { hash: null }, { hash: 123 }, { hash: 'short' }]) {
      assert.strictEqual(verify(bad, secret), false, `${JSON.stringify(bad)} must not verify`);
    }
  });
});

test('defaultExpiry is 90 days, matching the landing zone maximum', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  assert.strictEqual(defaultExpiry(now), '2026-04-01T00:00:00.000Z');
});
