'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../../src/config');
const minio = require('../../src/storage/minio');
const { parseArgs, loadKeys, copyOne, mapLimit } = require('../../src/scripts/copy-blobs-to-azure');

function mockBlob(existingSize) {
  const state = { uploads: 0, uploaded: null, size: existingSize };
  return {
    state,
    client: {
      async getProperties() {
        if (state.size === null) {
          const err = new Error('BlobNotFound');
          err.statusCode = 404;
          throw err;
        }
        return { contentLength: state.size };
      },
      async uploadData(buf) {
        state.uploads++;
        state.uploaded = buf;
        state.size = buf.length;
      }
    }
  };
}

function mockContainer(blob) {
  return { getBlockBlobClient: () => blob.client };
}

test('parseArgs — writes require an explicit flag', async (t) => {
  await t.test('defaults to a dry run', () => {
    const args = parseArgs(['--keys-file', 'k.txt']);
    assert.strictEqual(args.live, false, 'a 200 GB copy must not start by accident');
    assert.strictEqual(args.concurrency, 8);
    assert.strictEqual(args.limit, Infinity);
  });

  await t.test('--live opts in; --limit bounds a costed trial', () => {
    const args = parseArgs(['--keys-file', 'k.txt', '--live', '--limit', '100', '--concurrency', '4']);
    assert.strictEqual(args.live, true);
    assert.strictEqual(args.limit, 100);
    assert.strictEqual(args.concurrency, 4);
  });
});

test('loadKeys', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demi-keys-'));
  const file = path.join(dir, 'keys.txt');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  await t.test('trims, drops blanks and collapses duplicates', () => {
    fs.writeFileSync(file, 'etl/a.pdf\n  etl/b.pdf  \n\netl/a.pdf\n');
    assert.deepStrictEqual(loadKeys(file, Infinity), ['etl/a.pdf', 'etl/b.pdf']);
  });

  await t.test('respects the limit', () => {
    fs.writeFileSync(file, 'a\nb\nc\n');
    assert.deepStrictEqual(loadKeys(file, 2), ['a', 'b']);
  });
});

test('copyOne', async (t) => {
  const originalPrefix = config.minioKeyPrefix;
  t.beforeEach(() => { config.minioKeyPrefix = 'ozwdez'; });
  t.afterEach(() => { config.minioKeyPrefix = originalPrefix; t.mock.restoreAll(); });

  const stubSource = (t2, body) => {
    const Minio = require('minio');
    let readKey;
    t2.mock.method(Minio.Client.prototype, 'getObject', async (bucket, key) => {
      readKey = key;
      return (async function* () { yield Buffer.from(body); })();
    });
    return () => readKey;
  };

  await t.test('a dry run reads the source but writes nothing', async (t2) => {
    stubSource(t2, '%PDF-1.5');
    const blob = mockBlob(null);

    const result = await copyOne(mockContainer(blob), 'etl/a.pdf', false);

    assert.strictEqual(result.status, 'copied');
    assert.strictEqual(result.bytes, 8, 'reports what it would transfer');
    assert.strictEqual(blob.state.uploads, 0, 'dry run must not upload');
  });

  await t.test('a live run uploads and verifies the written size', async (t2) => {
    stubSource(t2, '%PDF-1.5');
    const blob = mockBlob(null);

    const result = await copyOne(mockContainer(blob), 'etl/a.pdf', true);

    assert.strictEqual(result.status, 'copied');
    assert.strictEqual(blob.state.uploads, 1);
    assert.strictEqual(blob.state.uploaded.toString(), '%PDF-1.5');
  });

  await t.test('an already-copied key of matching size is skipped', async (t2) => {
    // What makes the copy resumable: 200 GB will not complete in one pass, so a rerun must not
    // retransfer everything.
    stubSource(t2, '%PDF-1.5');
    const blob = mockBlob(8);

    const result = await copyOne(mockContainer(blob), 'etl/a.pdf', true);
    assert.strictEqual(result.status, 'skipped');
    assert.strictEqual(blob.state.uploads, 0);
  });

  await t.test('a truncated destination blob is recopied, not accepted', async (t2) => {
    stubSource(t2, '%PDF-1.5');
    const blob = mockBlob(3); // an interrupted upload left 3 of 8 bytes

    const result = await copyOne(mockContainer(blob), 'etl/a.pdf', true);
    assert.strictEqual(result.status, 'copied');
    assert.strictEqual(blob.state.uploads, 1);
  });

  await t.test('a short write throws rather than reporting success', async (t2) => {
    stubSource(t2, '%PDF-1.5');
    const blob = mockBlob(null);
    // Simulate the upload silently persisting fewer bytes than were sent.
    blob.client.uploadData = async () => { blob.state.size = 3; };

    await assert.rejects(
      () => copyOne(mockContainer(blob), 'etl/a.pdf', true),
      /size mismatch after upload/
    );
  });

  await t.test('a non-404 destination error is not swallowed as "absent"', async (t2) => {
    // Treating a 403 as "blob not found" would recopy the entire corpus on every run.
    stubSource(t2, 'x');
    const blob = mockBlob(null);
    blob.client.getProperties = async () => {
      const err = new Error('AuthorizationPermissionMismatch');
      err.statusCode = 403;
      throw err;
    };

    await assert.rejects(() => copyOne(mockContainer(blob), 'etl/a.pdf', true), /Authorization/);
  });

  await t.test('the source key is read through the environment prefix', async (t2) => {
    const readKey = stubSource(t2, 'x');
    await copyOne(mockContainer(mockBlob(null)), 'etl/a.pdf', false);
    assert.strictEqual(readKey(), 'ozwdez/etl/a.pdf');
  });

  await t.test('the destination key carries NO prefix', async (t2) => {
    // Per-environment containers replace the prefix scheme; carrying it over would nest dev's
    // copy under a directory named after the prod bucket for no reason.
    stubSource(t2, 'x');
    let destKey;
    const blob = mockBlob(null);
    const container = { getBlockBlobClient: (k) => { destKey = k; return blob.client; } };

    await copyOne(container, 'etl/a.pdf', true);
    assert.strictEqual(destKey, 'etl/a.pdf');
  });
});

test('the script has no code path that writes to the source', () => {
  // The standing instruction is "we do not want to accidentally delete prod documents". The
  // source backend's write operation is not imported, so no edit to this script can reach it
  // without also changing the imports — which this test then fails.
  const src = fs.readFileSync(
    require.resolve('../../src/scripts/copy-blobs-to-azure'), 'utf8');
  // Comments stripped: the file documents what it refuses to call, and matching that prose
  // would fail the check for saying the right thing.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  assert.ok(!/putFile|fPutObject|removeObject|makeBucket|deleteObject/.test(code),
    'a mutating source operation appeared in the copy script');
  assert.ok(/getBuffer: readFromMinio/.test(code),
    'the source must be imported by its read operation only, not as a whole module');
  assert.strictEqual(typeof minio.putFile, 'function',
    'sanity: the write op exists on the backend and is simply not imported here');
});

test('mapLimit', async (t) => {
  await t.test('runs every item, bounded by concurrency', async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const seen = [];
    let inFlight = 0, peak = 0;

    await mapLimit(items, 5, async (item) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(r => setImmediate(r));
      seen.push(item);
      inFlight--;
    });

    assert.strictEqual(seen.length, 50);
    assert.deepStrictEqual(seen.slice().sort((a, b) => a - b), items);
    assert.ok(peak <= 5, `peak concurrency ${peak} exceeded the limit`);
  });

  await t.test('handles an empty list without hanging', async () => {
    await mapLimit([], 8, async () => assert.fail('should not be called'));
  });

  await t.test('a rejecting worker propagates', async () => {
    // Per-key failures are caught by the caller; a worker that throws anyway must not be
    // silently absorbed into a "done" summary.
    await assert.rejects(() => mapLimit([1], 1, async () => { throw new Error('boom'); }), /boom/);
  });
});
