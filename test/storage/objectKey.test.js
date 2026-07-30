'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../../src/config');
const { resolveObjectKey } = require('../../src/storage/objectKey');

// Documents record the key eagle-api assigned against the PROD bucket (`etl/<slug>/<file>`).
// Non-prod buckets were populated by copying prod into a sub-prefix named after the prod
// bucket, so the same object sits one level deeper. Measured in dev: bucket `asnpnn` holds
// 92,472 objects under `ozwdez/`, and `etl/` does not exist at the root. Every download 404'd
// because of that one missing segment.

test('resolveObjectKey', async (t) => {
  const original = config.minioKeyPrefix;
  t.afterEach(() => { config.minioKeyPrefix = original; });

  await t.test('returns the key unchanged when no prefix is configured (prod)', () => {
    config.minioKeyPrefix = '';
    assert.strictEqual(
      resolveObjectKey('etl/site-c-clean-energy/abc.pdf'),
      'etl/site-c-clean-energy/abc.pdf'
    );
  });

  await t.test('prepends the configured prefix (dev)', () => {
    config.minioKeyPrefix = 'ozwdez';
    assert.strictEqual(
      resolveObjectKey('etl/site-c-clean-energy/abc.pdf'),
      'ozwdez/etl/site-c-clean-energy/abc.pdf'
    );
  });

  await t.test('is idempotent — a key already prefixed does not gain a second one', () => {
    // Without this, a re-seed writing normalised keys would make every object unfetchable.
    config.minioKeyPrefix = 'ozwdez';
    assert.strictEqual(
      resolveObjectKey('ozwdez/etl/abc.pdf'),
      'ozwdez/etl/abc.pdf'
    );
  });

  await t.test('tolerates stray slashes in the prefix and the key', () => {
    config.minioKeyPrefix = '/ozwdez/';
    assert.strictEqual(resolveObjectKey('/etl/abc.pdf'), 'ozwdez/etl/abc.pdf');
  });

  await t.test('passes through empty input rather than producing a bare prefix', () => {
    config.minioKeyPrefix = 'ozwdez';
    assert.strictEqual(resolveObjectKey(''), '');
    assert.strictEqual(resolveObjectKey(null), null);
    assert.strictEqual(resolveObjectKey(undefined), undefined);
  });

  await t.test('does not treat a similarly-named prefix as already applied', () => {
    config.minioKeyPrefix = 'ozwdez';
    // 'ozwdez-backup/...' merely starts with the same characters; it is a different location.
    assert.strictEqual(
      resolveObjectKey('ozwdez-backup/etl/abc.pdf'),
      'ozwdez/ozwdez-backup/etl/abc.pdf'
    );
  });
});
