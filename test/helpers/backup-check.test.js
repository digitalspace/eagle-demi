'use strict';

/**
 * The backup gate — `helpers/backup-check`. Anything that rewrites a stored original asks it first,
 * so every path that cannot prove the backup must answer not ok.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

// Before the logger: its handleExceptions would swallow a load failure here and the file would pass.
const { assertBackedUp } = require('../../src/helpers/backup-check');
const config = require('../../src/config');
const { logger } = require('../../src/utils/logger');

const KEY = 'project/doc/report.pdf';
const BYTES = Buffer.from('original document bytes');
const MD5 = crypto.createHash('md5').update(BYTES).digest();
const LIVE = { size: BYTES.length, etag: `"${MD5.toString('hex')}"` };
const MULTIPART_ETAG = 'a1b2c3d4e5f60718293a4b5c6d7e8f90-3';

/** Properties as @azure/storage-blob returns them for the archived blob the copy job writes. */
function archived(overrides = {}) {
  return {
    contentLength: BYTES.length,
    contentMD5: new Uint8Array(MD5),
    accessTier: 'Archive',
    metadata: { sourceetag: LIVE.etag, size: String(BYTES.length) },
    ...overrides
  };
}

/**
 * A container client whose blobs answer getProperties only. Any other member, such as download,
 * fails the test: an archived blob has no readable content and the gate must never ask for it.
 */
function fakeContainer(getProperties) {
  const names = [];
  return {
    names,
    getBlobClient(name) {
      names.push(name);
      return new Proxy({}, {
        get(_, prop) {
          if (prop === 'getProperties') return getProperties;
          if (prop === 'then') return undefined;
          assert.fail(`backup content requested through ${String(prop)}`);
        }
      });
    }
  };
}

const configured = (containerClient) => ({ account: 'eaglebaktest', container: 'originals', containerClient });

function restError(statusCode, code, message) {
  return Object.assign(new Error(message), { name: 'RestError', statusCode, details: { errorCode: code } });
}

test('an archived blob matching size and MD5 is ok, read through properties only', async () => {
  const fake = fakeContainer(async () => archived());
  const result = await assertBackedUp(KEY, LIVE, configured(fake));
  assert.deepStrictEqual(result, { ok: true });
  assert.deepStrictEqual(fake.names, [KEY]);
});

test('unconfigured by default: the empty BACKUP_ACCOUNT refuses without calling Azure', async () => {
  assert.strictEqual(config.backupAccount, '');
  const result = await assertBackedUp(KEY, LIVE);
  assert.strictEqual(result.reason, 'backup-unconfigured');
});

test('an empty container setting is unconfigured too', async () => {
  const fake = fakeContainer(async () => archived());
  const result = await assertBackedUp(KEY, LIVE, { ...configured(fake), container: '' });
  assert.strictEqual(result.reason, 'backup-unconfigured');
  assert.deepStrictEqual(fake.names, []);
});

test('a blob that is not there is no-backup', async () => {
  const fake = fakeContainer(async () => { throw restError(404, 'BlobNotFound', ''); });
  const result = await assertBackedUp(KEY, LIVE, configured(fake));
  assert.strictEqual(result.reason, 'no-backup');
});

test('a transport error is not ok, and is logged without the URL query or credential', async (t) => {
  const errors = [];
  t.mock.method(logger, 'error', (message, meta) => { errors.push({ message, meta }); });
  const err = restError(undefined, undefined,
    'connect ETIMEDOUT https://eaglebaktest.blob.core.windows.net/originals/x?sv=2024&sig=SECRETSIG');
  err.code = 'ETIMEDOUT';
  err.request = { headers: { authorization: 'Bearer SECRETTOKEN' } };
  const fake = fakeContainer(async () => { throw err; });

  const result = await assertBackedUp(KEY, LIVE, configured(fake));

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'no-backup');
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].meta.code, 'ETIMEDOUT');
  const logged = JSON.stringify(errors[0]);
  assert.ok(!logged.includes('SECRETSIG'), logged);
  assert.ok(!logged.includes('SECRETTOKEN'), logged);
});

test('a missing container is a fault, logged and not ok', async (t) => {
  const errors = [];
  t.mock.method(logger, 'error', (message, meta) => { errors.push(meta); });
  const fake = fakeContainer(async () => { throw restError(404, 'ContainerNotFound', ''); });
  const result = await assertBackedUp(KEY, LIVE, configured(fake));
  assert.strictEqual(result.reason, 'no-backup');
  assert.strictEqual(errors[0].code, 'ContainerNotFound');
});

test('a size difference is size-mismatch', async () => {
  const fake = fakeContainer(async () => archived({ contentLength: BYTES.length + 1 }));
  const result = await assertBackedUp(KEY, LIVE, configured(fake));
  assert.strictEqual(result.reason, 'size-mismatch');
});

test('a live object whose MD5 differs from the stored Content-MD5 is md5-mismatch', async () => {
  const fake = fakeContainer(async () => archived());
  const changed = { ...LIVE, etag: crypto.createHash('md5').update('other bytes').digest('hex') };
  const result = await assertBackedUp(KEY, changed, configured(fake));
  assert.strictEqual(result.reason, 'md5-mismatch');
});

test('a blob with no stored Content-MD5 is md5-mismatch', async () => {
  const fake = fakeContainer(async () => archived({ contentMD5: undefined }));
  const result = await assertBackedUp(KEY, LIVE, configured(fake));
  assert.strictEqual(result.reason, 'md5-mismatch');
});

test('a matching blob outside the Archive tier is not-archive', async () => {
  const fake = fakeContainer(async () => archived({ accessTier: 'Cool' }));
  const result = await assertBackedUp(KEY, LIVE, configured(fake));
  assert.strictEqual(result.reason, 'not-archive');
});

test('multipart ETag equal to the recorded source ETag is ok', async () => {
  const fake = fakeContainer(async () => archived({
    contentMD5: new Uint8Array(16), metadata: { sourceetag: `"${MULTIPART_ETAG}"` }
  }));
  const result = await assertBackedUp(KEY, { size: BYTES.length, etag: `"${MULTIPART_ETAG}"` }, configured(fake));
  assert.deepStrictEqual(result, { ok: true });
});

test('multipart ETag different from the recorded source ETag is md5-mismatch, even at equal size', async () => {
  const fake = fakeContainer(async () => archived({ metadata: { sourceetag: MULTIPART_ETAG } }));
  const rewritten = { size: BYTES.length, etag: 'ffffffffffffffffffffffffffffffff-3' };
  const result = await assertBackedUp(KEY, rewritten, configured(fake));
  assert.strictEqual(result.reason, 'md5-mismatch');
});

test('multipart ETag with no recorded source ETag is md5-mismatch', async () => {
  const fake = fakeContainer(async () => archived({ metadata: {} }));
  const result = await assertBackedUp(KEY, { size: BYTES.length, etag: MULTIPART_ETAG }, configured(fake));
  assert.strictEqual(result.reason, 'md5-mismatch');
});

test('a stat without size or etag is a caller fault, not a pass', async () => {
  const fake = fakeContainer(async () => archived());
  await assert.rejects(assertBackedUp(KEY, { size: BYTES.length }, configured(fake)), TypeError);
});
