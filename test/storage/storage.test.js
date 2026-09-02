'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../../src/config');

// ── Backend selection ────────────────────────────────────────────────────────
// The lesson this asserts: a mode switch must be EXPLICIT and must fail loudly. Inferring the
// data layer from whichever config happened to be set (COSMOS_ENDPOINT) silently routed live
// traffic through the wrong implementation. A storage switch decides where document bytes are
// read from and written to, so the same rule applies with higher stakes.

test('backend selection', async (t) => {
  const load = (backend) => {
    const key = require.resolve('../../src/storage');
    delete require.cache[key];
    const prev = config.storageBackend;
    config.storageBackend = backend;
    try {
      return require('../../src/storage');
    } finally {
      config.storageBackend = prev;
      delete require.cache[key];
    }
  };

  await t.test('defaults to minio', () => {
    assert.strictEqual(config.storageBackend, 'minio');
  });

  await t.test('an unknown backend throws at load rather than falling back', () => {
    assert.throws(() => load('s3'), /unknown STORAGE_BACKEND "s3"/);
    assert.throws(() => load(''), /unknown STORAGE_BACKEND/);
    assert.throws(() => load(undefined), /unknown STORAGE_BACKEND/);
  });

  await t.test('both backends load and expose the same operations', () => {
    // Parity is the property: STORAGE_BACKEND is meant to be a config flip, and a method one
    // backend has and the other does not turns that flip into a runtime crash on one path.
    for (const name of ['minio', 'azureBlob']) {
      const backend = require(`../../src/storage/${name}`);
      for (const op of ['getBuffer', 'getObjectStream', 'getDownloadUrl', 'putFile',
        'putObjectStream', 'removeObject', 'describe']) {
        assert.strictEqual(typeof backend[op], 'function', `${name}.${op}`);
      }
    }
    // The facade forwards everything the app uses; the copy script talks to a backend directly
    // and needs getBuffer/describe, which is why those two stay off this list.
    for (const op of ['getDownloadUrl', 'putFile', 'getObjectStream', 'putObjectStream',
      'removeObject']) {
      assert.strictEqual(typeof load('minio')[op], 'function', `facade.${op}`);
    }
  });

  await t.test('describe() exposes no secret', () => {
    const described = JSON.stringify(require('../../src/storage/minio').describe());
    // Only meaningful when a secret is configured: includes('') is true of every string, and
    // the NUL sentinel that used to paper over that made the assertion unfalsifiable.
    if (config.minioSecret) assert.ok(!described.includes(config.minioSecret));
    assert.ok(!/secret|accessKey|password/i.test(described));
  });
});

// ── MinIO backend ────────────────────────────────────────────────────────────
// The key prefix must be applied by the BACKEND, not by call sites. extract.js read `s3Key`
// raw, so every extraction in dev fetched a key that 404s, while the download endpoint applied
// the prefix correctly. Same bug, two outcomes, because there was no single owner.

test('minio backend applies the key prefix to every operation', async (t) => {
  const minio = require('../../src/storage/minio');
  const original = config.minioKeyPrefix;
  t.beforeEach(() => { config.minioKeyPrefix = 'ozwdez'; });
  t.afterEach(() => { config.minioKeyPrefix = original; t.mock.restoreAll(); });

  const Minio = require('minio');

  await t.test('getBuffer reads the prefixed key', async () => {
    let seen;
    t.mock.method(Minio.Client.prototype, 'getObject', async (bucket, key) => {
      seen = key;
      return (async function* () { yield Buffer.from('%PDF-1.5'); })();
    });

    const buf = await minio.getBuffer('etl/site-c/abc.pdf');
    assert.strictEqual(seen, 'ozwdez/etl/site-c/abc.pdf');
    assert.strictEqual(buf.toString(), '%PDF-1.5');
  });

  await t.test('getDownloadUrl presigns the prefixed key with an expiry', async () => {
    let seenKey, seenExpiry;
    t.mock.method(Minio.Client.prototype, 'presignedGetObject', async (b, key, expiry) => {
      seenKey = key; seenExpiry = expiry;
      return 'https://example.invalid/signed';
    });

    await minio.getDownloadUrl('etl/site-c/abc.pdf', { expirySeconds: 300 });
    assert.strictEqual(seenKey, 'ozwdez/etl/site-c/abc.pdf');
    assert.strictEqual(seenExpiry, 300);
  });

  await t.test('a download URL is never issued without an expiry', async () => {
    let seenExpiry;
    t.mock.method(Minio.Client.prototype, 'presignedGetObject', async (b, k, expiry) => {
      seenExpiry = expiry;
      return 'https://example.invalid/signed';
    });

    await minio.getDownloadUrl('etl/abc.pdf');
    assert.ok(seenExpiry > 0 && seenExpiry <= 3600, `default expiry ${seenExpiry} unreasonable`);
  });

  await t.test('a download URL for a named file forces an attachment', async () => {
    // Safari ignores `download` on a cross-origin <a>, so a zip whose URL does not say
    // attachment renders in the tab instead of downloading.
    let seenHeaders;
    t.mock.method(Minio.Client.prototype, 'presignedGetObject', async (b, k, e, headers) => {
      seenHeaders = headers;
      return 'https://example.invalid/signed';
    });

    await minio.getDownloadUrl('zips/abc.zip', { fileName: 'epic-documents-1.zip' });
    assert.strictEqual(
      seenHeaders['response-content-disposition'],
      "attachment; filename=\"epic-documents-1.zip\"; filename*=UTF-8''epic-documents-1.zip"
    );
  });

  await t.test('an unsized upload is multiparted in 64 MiB pieces, not 528 MiB ones', async () => {
    let client;
    t.mock.method(Minio.Client.prototype, 'putObject', async function () { client = this; });

    await minio.putObjectStream(
      'zips/abc.zip', require('stream').Readable.from(['x']), 'application/zip');

    // An upload with no size is treated as a 5 TB object, and without an explicit partSize the
    // SDK then climbs from 64 MiB in 16 MiB steps until 10,000 parts cover it — 528 MiB, each
    // one BUFFERED. host.json's one-zip-per-instance memory budget is written against 64 MiB.
    assert.strictEqual(client.calculatePartSize(client.maxObjectSize), 64 * 1024 * 1024);
  });

  await t.test('getObjectStream reads the prefixed key without draining it', async () => {
    let seen;
    const source = (async function* () { yield Buffer.from('%PDF-1.5'); })();
    t.mock.method(Minio.Client.prototype, 'getObject', async (b, key) => {
      seen = key;
      return source;
    });

    const stream = await minio.getObjectStream('etl/site-c/abc.pdf');
    assert.strictEqual(seen, 'ozwdez/etl/site-c/abc.pdf');
    assert.strictEqual(stream, source, 'the stream was consumed instead of handed back');
  });

  await t.test('putObjectStream omits the size, so the SDK multiparts the stream', async () => {
    // A zip is written while it is still being built: passing a byte count would mean knowing
    // the length up front, and passing a wrong one truncates the object.
    let seenKey, seenSize, seenMeta;
    t.mock.method(Minio.Client.prototype, 'putObject', async (b, key, stream, size, meta) => {
      seenKey = key; seenSize = size; seenMeta = meta;
      return {};
    });

    const stored = await minio.putObjectStream(
      'zips/abc.zip', require('stream').Readable.from(['x']), 'application/zip');
    assert.strictEqual(seenKey, 'ozwdez/zips/abc.zip');
    assert.strictEqual(seenSize, undefined);
    assert.strictEqual(seenMeta['Content-Type'], 'application/zip');
    assert.strictEqual(stored, 'ozwdez/zips/abc.zip');
  });

  await t.test('removeObject deletes the prefixed key', async () => {
    let seen;
    t.mock.method(Minio.Client.prototype, 'removeObject', async (b, key) => { seen = key; });

    await minio.removeObject('zips/abc.zip');
    assert.strictEqual(seen, 'ozwdez/zips/abc.zip');
  });

  await t.test('removeObject treats an already-deleted key as done', async () => {
    // The sweeper re-runs over rows a retry may have half-cleared; a 404 there is not a failure.
    t.mock.method(Minio.Client.prototype, 'removeObject', async () => {
      const err = new Error('The specified key does not exist.');
      err.code = 'NoSuchKey';
      throw err;
    });

    await minio.removeObject('zips/gone.zip');
  });

  await t.test('removeObject still reports a failure that is not a missing key', async () => {
    t.mock.method(Minio.Client.prototype, 'removeObject', async () => {
      const err = new Error('Access Denied');
      err.code = 'AccessDenied';
      throw err;
    });

    await assert.rejects(minio.removeObject('zips/abc.zip'), /Access Denied/,
      'swallowing this would report a permission problem as a completed sweep');
  });

  await t.test('putFile stores under the prefixed key and returns it', async () => {
    let seen;
    t.mock.method(Minio.Client.prototype, 'bucketExists', async () => true);
    t.mock.method(Minio.Client.prototype, 'fPutObject', async (b, key) => { seen = key; });

    const stored = await minio.putFile('12345/abc.pdf', '/tmp/x.pdf', 'application/pdf');
    assert.strictEqual(seen, 'ozwdez/12345/abc.pdf');
    assert.strictEqual(stored, 'ozwdez/12345/abc.pdf');
  });

  await t.test('a missing bucket is created before the first upload', async () => {
    let made = false;
    t.mock.method(Minio.Client.prototype, 'bucketExists', async () => false);
    t.mock.method(Minio.Client.prototype, 'makeBucket', async () => { made = true; });
    t.mock.method(Minio.Client.prototype, 'fPutObject', async () => {});

    await minio.putFile('12345/abc.pdf', '/tmp/x.pdf');
    assert.ok(made);
  });

  await t.test('with no prefix configured (prod) the key is untouched', async () => {
    config.minioKeyPrefix = '';
    let seen;
    t.mock.method(Minio.Client.prototype, 'getObject', async (b, key) => {
      seen = key;
      return (async function* () { yield Buffer.alloc(0); })();
    });

    await minio.getBuffer('etl/site-c/abc.pdf');
    assert.strictEqual(seen, 'etl/site-c/abc.pdf');
  });
});

// ── Azure Blob backend ───────────────────────────────────────────────────────

test('azure blob backend', async (t) => {
  const azure = require('../../src/storage/azureBlob');
  const { BlobServiceClient, BlockBlobClient } = require('@azure/storage-blob');

  const prev = {
    account: config.azureStorageAccount,
    container: config.azureStorageContainer
  };

  // A structurally valid delegation key. `value` must be base64 — the SAS signature is a real
  // HMAC over it, so this exercises the actual signing path offline.
  //
  // signedStartsOn/signedExpiresOn must be Date objects, not the ISO strings the REST API
  // returns: the generated mapper types them as String, but generateBlobSASQueryParameters
  // calls toISOString() on them. BlobServiceClient.getUserDelegationKey bridges the two with
  // `new Date(...)`, so anything that builds a delegation key by hand must do the same.
  const fakeKey = {
    signedObjectId: '00000000-0000-0000-0000-000000000001',
    signedTenantId: '00000000-0000-0000-0000-000000000002',
    signedStartsOn: new Date('2026-07-30T00:00:00Z'),
    signedExpiresOn: new Date('2026-07-30T01:00:00Z'),
    signedService: 'b',
    signedVersion: '2024-11-04',
    value: Buffer.from('not-a-real-key').toString('base64')
  };

  t.beforeEach(() => {
    config.azureStorageAccount = 'demidocsdev';
    config.azureStorageContainer = 'documents-dev';
    azure._resetCache();
  });
  t.afterEach(() => {
    config.azureStorageAccount = prev.account;
    config.azureStorageContainer = prev.container;
    azure._resetCache();
    t.mock.restoreAll();
  });

  await t.test('missing configuration throws a named error, not a vague failure', async () => {
    config.azureStorageAccount = '';
    await assert.rejects(() => azure.getBuffer('a.pdf'), /AZURE_STORAGE_ACCOUNT is required/);

    azure._resetCache();
    config.azureStorageAccount = 'demidocsdev';
    config.azureStorageContainer = '';
    await assert.rejects(() => azure.getBuffer('a.pdf'), /AZURE_STORAGE_CONTAINER is required/);
  });

  await t.test('an empty key is rejected rather than addressing the container', async () => {
    await assert.rejects(() => azure.getBuffer(''), /blob name is required/);
    await assert.rejects(() => azure.putFile('', '/tmp/x'), /blob name is required/);
  });

  await t.test('the recorded key is the blob name verbatim — no prefix', async () => {
    // Per-environment containers replace the nested-prefix scheme, which is the actual safety
    // improvement: dev cannot address prod's objects at all, however its config is edited.
    config.minioKeyPrefix = 'ozwdez';
    let seen;
    t.mock.method(BlockBlobClient.prototype, 'downloadToBuffer', async function () {
      seen = this.name;
      return Buffer.from('%PDF-1.5');
    });

    await azure.getBuffer('etl/site-c/abc.pdf');
    assert.strictEqual(seen, 'etl/site-c/abc.pdf');
    config.minioKeyPrefix = '';
  });

  await t.test('a download URL is a read-only, time-limited https SAS', async () => {
    t.mock.method(BlobServiceClient.prototype, 'getUserDelegationKey', async () => fakeKey);

    const now = Date.parse('2026-07-30T12:00:00Z');
    const url = await azure.getDownloadUrl('etl/abc.pdf', { expirySeconds: 300, now });
    const parsed = new URL(url);

    assert.strictEqual(parsed.protocol, 'https:');
    assert.strictEqual(parsed.pathname, '/documents-dev/etl/abc.pdf');
    assert.strictEqual(parsed.searchParams.get('sp'), 'r',
      'a leaked link with write or delete rights would mean document loss');
    assert.strictEqual(parsed.searchParams.get('spr'), 'https');
    assert.ok(parsed.searchParams.get('sig'), 'unsigned URL');
    assert.strictEqual(parsed.searchParams.get('se'), '2026-07-30T12:05:00Z');
    // skc* parameters are only present on a user delegation SAS, never on a key-signed one.
    assert.ok(parsed.searchParams.get('skoid'), 'not signed with a user delegation key');
  });

  await t.test('the filename is carried as a content-disposition override', async () => {
    t.mock.method(BlobServiceClient.prototype, 'getUserDelegationKey', async () => fakeKey);

    const url = await azure.getDownloadUrl('etl/abc.pdf', {
      fileName: 'Site C Report.pdf', now: Date.parse('2026-07-30T12:00:00Z')
    });
    assert.strictEqual(new URL(url).searchParams.get('rscd'),
      "attachment; filename=\"Site C Report.pdf\"; filename*=UTF-8''Site%20C%20Report.pdf",
      'both backends sign the same header — one that differs is a bug only one environment shows');
  });

  await t.test('the delegation key is cached, then refetched after it expires', async () => {
    // Without caching, every download adds a round trip; cached too long, it produces SAS URLs
    // that fail authentication rather than an obvious error.
    let fetches = 0;
    t.mock.method(BlobServiceClient.prototype, 'getUserDelegationKey', async () => {
      fetches++;
      return fakeKey;
    });

    const t0 = Date.parse('2026-07-30T12:00:00Z');
    await azure.getDelegationKey(t0);
    await azure.getDelegationKey(t0 + 1000);
    assert.strictEqual(fetches, 1, 'second call served from cache');

    await azure.getDelegationKey(t0 + azure.DELEGATION_KEY_TTL_MS + 1);
    assert.strictEqual(fetches, 2, 'expired key refetched');
  });

  await t.test('the delegation key is requested with backdated validity for clock skew', async () => {
    let startsOn, expiresOn;
    t.mock.method(BlobServiceClient.prototype, 'getUserDelegationKey', async (s, e) => {
      startsOn = s; expiresOn = e;
      return fakeKey;
    });

    const now = Date.parse('2026-07-30T12:00:00Z');
    await azure.getDelegationKey(now);
    assert.ok(startsOn.getTime() < now, 'a key valid from exactly now loses to clock skew');
    assert.ok(expiresOn.getTime() > now + azure.DELEGATION_KEY_TTL_MS);
  });

  await t.test('putFile uploads under the key and sets the content type', async () => {
    let seenName, seenPath, seenOpts;
    t.mock.method(BlockBlobClient.prototype, 'uploadFile', async function (p, opts) {
      seenName = this.name; seenPath = p; seenOpts = opts;
    });

    const stored = await azure.putFile('12345/abc.pdf', '/tmp/x.pdf', 'application/pdf');
    assert.strictEqual(seenName, '12345/abc.pdf');
    assert.strictEqual(seenPath, '/tmp/x.pdf');
    assert.strictEqual(seenOpts.blobHTTPHeaders.blobContentType, 'application/pdf');
    assert.strictEqual(stored, '12345/abc.pdf');
  });

  await t.test('putObjectStream uploads in bounded blocks, not one buffer', async () => {
    // The whole point of the streaming pair: a multi-GB zip must never be held in memory. Block
    // size and concurrency are positional, so a swap here is a silent memory blow-up on the day
    // STORAGE_BACKEND flips.
    let seenName, seenBlock, seenConcurrency, seenOpts;
    t.mock.method(BlockBlobClient.prototype, 'uploadStream',
      async function (s, block, concurrency, opts) {
        seenName = this.name; seenBlock = block; seenConcurrency = concurrency; seenOpts = opts;
      });

    const stored = await azure.putObjectStream(
      'zips/abc.zip', require('stream').Readable.from(['x']), 'application/zip');
    assert.strictEqual(seenName, 'zips/abc.zip');
    assert.strictEqual(seenBlock, 4 * 1024 * 1024);
    assert.strictEqual(seenConcurrency, 5);
    assert.strictEqual(seenOpts.blobHTTPHeaders.blobContentType, 'application/zip');
    assert.strictEqual(stored, 'zips/abc.zip');
  });

  await t.test('getObjectStream hands back the response body, not the response', async () => {
    const body = require('stream').Readable.from(['%PDF-1.5']);
    t.mock.method(BlockBlobClient.prototype, 'download', async () => ({ readableStreamBody: body }));

    assert.strictEqual(await azure.getObjectStream('etl/abc.pdf'), body);
  });

  await t.test('the container is NEVER created on demand', async () => {
    // Auto-creating would turn a configuration typo into a working-but-empty store. A user
    // delegation SAS also requires the container to already exist.
    t.mock.method(BlockBlobClient.prototype, 'uploadFile', async () => {});
    const src = require('fs').readFileSync(
      require.resolve('../../src/storage/azureBlob'), 'utf8');
    assert.ok(!/createIfNotExists|\.create\(/.test(src));
  });
});
