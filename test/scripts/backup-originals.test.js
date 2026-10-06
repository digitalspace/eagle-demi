'use strict';

process.env.NODE_ENV = 'test';
// Set before config loads: the log redaction test checks this value never reaches a log line.
process.env.SOURCE_MINIO_ACCESS_KEY = 'FAKEACCESSKEYFORTEST';
process.env.SOURCE_MINIO_SECRET_KEY = 'fake-source-secret-for-test';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');

// Script first: once the logger loads, its exception handler turns a failed require into a pass.
const { parseArgs, run } = require('../../src/scripts/backup-originals');
const { logger } = require('../../src/utils/logger');

const BUCKET = 'zdspnb';
const ACCOUNT = 'eaglebaktestabc';
const NOW = new Date('2026-10-05T12:00:00Z');
const md5 = buf => crypto.createHash('md5').update(buf).digest('hex');
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Object-store double. Each object is `{ body, etag?, second?, statSize? }`; `second` is what a
 * second GET returns, so a source that changes between reads is visible, and `statSize` is a stat
 * that disagrees with the bytes served. `failGet` throws on the GET.
 */
function fakeSource(objects, { failGet = {}, failStatOnce = {} } = {}) {
  const state = { gets: [] };
  const reads = {};
  return {
    state,
    async *listObjects() {
      for (const [name, o] of Object.entries(objects)) {
        yield { name, size: o.body.length, etag: `"${o.etag || md5(o.body)}"` };
      }
    },
    async statObject(bucket, key) {
      if (failStatOnce[key]) { const err = failStatOnce[key]; delete failStatOnce[key]; throw err; }
      const o = objects[key];
      if (!o) throw Object.assign(new Error('Not Found'), { code: 'NotFound' });
      return { size: o.statSize ?? o.body.length, etag: o.etag || md5(o.body), metaData: { 'content-type': 'application/pdf' } };
    },
    async getObject(bucket, key) {
      state.gets.push(key);
      if (failGet[key]) throw failGet[key];
      reads[key] = (reads[key] || 0) + 1;
      const o = objects[key];
      const body = reads[key] > 1 && o.second ? o.second : o.body;
      // Uneven chunks, so blocks are cut across chunk boundaries.
      return Readable.from([body.subarray(0, 3), body.subarray(3)]);
    }
  };
}

/**
 * Blob storage double. Stage checks the per-block MD5 and commit honours `ifNoneMatch: '*'` the
 * way Azure does, so a missing condition shows up as an overwritten body, not a missed call.
 */
function fakeAzure() {
  const containers = {};
  const writes = [];
  const get = name => {
    if (!containers[name]) containers[name] = { blobs: new Map(), staged: new Map(), commits: [] };
    return containers[name];
  };
  const containerFor = (cname) => {
    const c = get(cname);
    return {
      async exists() { return !c.absent; },
      async *listBlobsFlat() {
        for (const [name, b] of c.blobs) {
          yield {
            name, metadata: b.metadata,
            properties: { contentLength: b.body.length, contentMD5: b.contentMD5, accessTier: b.tier }
          };
        }
      },
      getBlockBlobClient(name) {
        return {
          url: `https://${ACCOUNT}.blob.core.windows.net/${cname}/${name}`,
          async exists() {
            if (c.existsFails && c.existsFails[name]) throw c.existsFails[name];
            if (c.existsLiesOnce === name) { c.existsLiesOnce = null; return false; }
            return c.blobs.has(name);
          },
          async stageBlock(id, body, length, opts) {
            writes.push(['stage', cname, name]);
            if (md5(body) !== Buffer.from(opts.transactionalContentMD5).toString('hex') || length !== body.length) {
              throw Object.assign(new Error('Md5Mismatch'), { statusCode: 400 });
            }
            if (!c.staged.has(name)) c.staged.set(name, new Map());
            c.staged.get(name).set(id, Buffer.from(body));
          },
          async commitBlockList(ids, opts) {
            writes.push(['commit', cname, name]);
            if (c.blobs.has(name) && opts.conditions && opts.conditions.ifNoneMatch === '*') {
              throw Object.assign(new Error('BlobAlreadyExists'), { statusCode: 409 });
            }
            const blocks = c.staged.get(name);
            c.blobs.set(name, {
              body: Buffer.concat(ids.map(id => blocks.get(id))),
              tier: opts.tier, contentMD5: opts.blobHTTPHeaders.blobContentMD5,
              contentType: opts.blobHTTPHeaders.blobContentType, metadata: opts.metadata
            });
            c.staged.delete(name);
            c.commits.push(name);
          },
          async upload(body, length, opts) {
            writes.push(['upload', cname, name]);
            if (c.blobs.has(name) && opts.conditions.ifNoneMatch === '*') throw Object.assign(new Error('exists'), { statusCode: 409 });
            c.blobs.set(name, { body, tier: 'Cool', metadata: {} });
          },
          async beginCopyFromURL(url, opts) {
            writes.push(['copy', cname, name]);
            // Like Azure out of Archive: copy success at once, the wait only in archiveStatus.
            c.blobs.set(name, {
              body: null, copyStatus: 'success', accessTier: 'Archive', archiveStatus: 'rehydrate-pending-to-cool',
              from: url, tier: opts.tier, priority: opts.rehydratePriority
            });
          },
          async getProperties() {
            const b = c.blobs.get(name);
            // Like Azure on HEAD: no body, so an empty message; the code is only in a header.
            if (!b) {
              throw Object.assign(new Error(''), {
                name: 'RestError', statusCode: 404, response: { headers: { get: () => 'BlobNotFound' } }
              });
            }
            return { copyStatus: b.copyStatus, accessTier: b.accessTier, archiveStatus: b.archiveStatus };
          },
          async download() {
            const b = c.blobs.get(name);
            if (b.accessTier === 'Archive') throw Object.assign(new Error('This operation is not permitted on an archived blob.'), { statusCode: 409 });
            return { readableStreamBody: Readable.from([b.body]) };
          },
          async delete() {
            writes.push(['delete', cname, name]);
            c.blobs.delete(name);
          }
        };
      }
    };
  };
  return { containerFor, writes, originals: get('originals'), manifests: get('manifests'), restore: get('restore') };
}

function quietLogs(t) {
  const lines = [];
  for (const level of ['info', 'warn', 'error']) {
    t.mock.method(logger, level, (...args) => { lines.push(JSON.stringify(args)); });
  }
  return lines;
}

/** Writes the bucket listing and Cosmos rows files a run reads, and returns argv builders. */
function setup(t, objects, rows = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-originals-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bucketList = path.join(dir, 'bucket.jsonl');
  const rowsFile = path.join(dir, 'rows.jsonl');
  fs.writeFileSync(bucketList, Object.entries(objects)
    .map(([key, o]) => JSON.stringify({ key, size: o.body.length, etag: o.etag || md5(o.body) })).join('\n'));
  fs.writeFileSync(rowsFile, rows.map(r => JSON.stringify(r)).join('\n'));
  const logs = quietLogs(t);
  return {
    dir, bucketList, rowsFile, logs,
    copyArgs: (...extra) => ['copy', '--bucket', BUCKET, '--account', ACCOUNT,
      '--bucket-list', bucketList, '--rows', rowsFile, ...extra],
    verifyArgs: (...extra) => ['verify', '--env', 'test', '--account', ACCOUNT,
      '--bucket-list', bucketList, '--rows', rowsFile, ...extra]
  };
}

function deps(source, azure) {
  return { source, containerFor: azure.containerFor, sleep: async () => {}, now: () => NOW, blockSize: 4 };
}

const PDF = Buffer.from('%PDF-1.7 original bytes');
const OTHER = Buffer.from('%PDF-1.7 other document');

test('copy commits each object to Archive, create-only, with Content-MD5 and all metadata', async (t) => {
  const s = setup(t, { 'p1/a.pdf': { body: PDF } }, [{ id: 'doc1', s3Key: 'p1/a.pdf' }, { id: 'doc2', s3Key: 'p1/a.pdf' }]);
  const azure = fakeAzure();
  const result = await run(s.copyArgs('--live'), deps(fakeSource({ 'p1/a.pdf': { body: PDF } }), azure));

  const blob = azure.originals.blobs.get('p1/a.pdf');
  assert.strictEqual(result.exitCode, 0);
  assert.ok(blob.body.equals(PDF), 'blob bytes equal the source across several blocks');
  assert.strictEqual(blob.tier, 'Archive');
  assert.strictEqual(Buffer.from(blob.contentMD5).toString('hex'), md5(PDF));
  assert.strictEqual(blob.contentType, 'application/pdf');
  assert.deepStrictEqual(blob.metadata, {
    sourcebucket: BUCKET, sourceetag: md5(PDF), md5: md5(PDF), sha256: sha256(PDF),
    size: String(PDF.length), documentids: 'doc1,doc2', copiedat: NOW.toISOString()
  });
});

test('copy stages blocks but never commits when the MD5 does not match the source ETag', async (t) => {
  const objects = { 'p1/a.pdf': { body: PDF, etag: md5(OTHER) } };
  const s = setup(t, objects);
  const azure = fakeAzure();
  const result = await run(s.copyArgs('--live'), deps(fakeSource(objects), azure));

  assert.ok(azure.writes.some(([op]) => op === 'stage'), 'blocks were staged');
  assert.strictEqual(azure.originals.blobs.has('p1/a.pdf'), false);
  assert.strictEqual(result.summary.mismatch, 1);
  assert.strictEqual(result.exitCode, 1);
});

test('copy leaves a blob that already exists untouched', async (t) => {
  const s = setup(t, { 'p1/a.pdf': { body: PDF } });
  const azure = fakeAzure();
  azure.originals.blobs.set('p1/a.pdf', { body: OTHER, tier: 'Archive', metadata: {} });
  const result = await run(s.copyArgs('--live'), deps(fakeSource({ 'p1/a.pdf': { body: PDF } }), azure));

  assert.ok(azure.originals.blobs.get('p1/a.pdf').body.equals(OTHER));
  assert.strictEqual(result.summary.present, 1);
});

test('copy never overwrites a blob that appears between the exists check and the commit', async (t) => {
  const s = setup(t, { 'p1/a.pdf': { body: PDF } });
  const azure = fakeAzure();
  azure.originals.blobs.set('p1/a.pdf', { body: OTHER, tier: 'Archive', metadata: {} });
  azure.originals.existsLiesOnce = 'p1/a.pdf';
  const result = await run(s.copyArgs('--live'), deps(fakeSource({ 'p1/a.pdf': { body: PDF } }), azure));

  assert.ok(azure.originals.blobs.get('p1/a.pdf').body.equals(OTHER), 'the create-only commit was refused');
  assert.strictEqual(result.summary.present, 1);
});

test('copy commits a multipart object only when a second read has the same sha256', async (t) => {
  const objects = { 'p1/big.pdf': { body: PDF, etag: 'd41d8cd98f00b204e9800998ecf8427e-2' } };
  const s = setup(t, objects);
  const azure = fakeAzure();
  const result = await run(s.copyArgs('--live'), deps(fakeSource(objects), azure));

  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(azure.originals.blobs.get('p1/big.pdf').metadata.sha256, sha256(PDF));
});

test('copy never commits a multipart object whose second read differs', async (t) => {
  const tampered = Buffer.from('%PDF-1.7 changed  bytes');
  const objects = { 'p1/big.pdf': { body: PDF, etag: 'd41d8cd98f00b204e9800998ecf8427e-2', second: tampered } };
  const s = setup(t, objects);
  const azure = fakeAzure();
  const result = await run(s.copyArgs('--live'), deps(fakeSource(objects), azure));

  assert.strictEqual(azure.originals.blobs.has('p1/big.pdf'), false);
  assert.strictEqual(result.summary.mismatch, 1);
});

test('copy never commits when the bytes read differ in size from the source stat', async (t) => {
  const objects = { 'p1/big.pdf': { body: PDF, etag: `${md5(PDF)}-2`, statSize: PDF.length + 1 } };
  const s = setup(t, objects);
  const azure = fakeAzure();
  const result = await run(s.copyArgs('--live'), deps(fakeSource(objects), azure));

  assert.strictEqual(azure.originals.blobs.has('p1/big.pdf'), false);
  assert.strictEqual(result.summary.mismatch, 1);
});

test('copy counts a key the source does not hold as missing, not failed', async (t) => {
  const s = setup(t, {}, [{ id: 'doc9', s3Key: 'p9/gone.pdf' }]);
  const result = await run(s.copyArgs('--live'), deps(fakeSource({}), fakeAzure()));

  assert.strictEqual(result.summary.missingInSource, 1);
  assert.strictEqual(result.exitCode, 0);
});

test('a live copy refuses to start when the archive container does not exist', async (t) => {
  const objects = { 'p1/a.pdf': { body: PDF } };
  const s = setup(t, objects);
  const azure = fakeAzure();
  azure.originals.absent = true;

  await assert.rejects(run(s.copyArgs('--live'), deps(fakeSource(objects), azure)), /does not exist|not found/);
  assert.deepStrictEqual(azure.writes, []);
});

test('a rerun after a killed run commits each blob exactly once', async (t) => {
  const objects = { 'p1/a.pdf': { body: PDF }, 'p1/b.pdf': { body: OTHER } };
  const s = setup(t, objects);
  const azure = fakeAzure();
  const killed = fakeSource(objects, { failGet: { 'p1/b.pdf': new Error('socket hang up') } });
  await run(s.copyArgs('--live', '--concurrency', '1'), deps(killed, azure));
  const source = fakeSource(objects);
  const rerun = await run(s.copyArgs('--live'), deps(source, azure));

  assert.deepStrictEqual(azure.originals.commits.sort(), ['p1/a.pdf', 'p1/b.pdf']);
  assert.deepStrictEqual(source.state.gets, ['p1/b.pdf'], 'the blob already backed up is not read again');
  assert.strictEqual(rerun.summary.present, 1);
  assert.strictEqual(rerun.exitCode, 0);
});

test('copy backs off and retries when the source says SlowDown', async (t) => {
  const objects = { 'p1/a.pdf': { body: PDF } };
  const s = setup(t, objects);
  const azure = fakeAzure();
  const source = fakeSource(objects, { failStatOnce: { 'p1/a.pdf': Object.assign(new Error('SlowDown'), { code: 'SlowDown' }) } });
  const result = await run(s.copyArgs('--live'), deps(source, azure));

  assert.strictEqual(result.summary.copied, 1);
  assert.strictEqual(result.exitCode, 0);
});

test('a dry run of copy, verify and drill writes nothing', async (t) => {
  const objects = { 'p1/a.pdf': { body: PDF } };
  const s = setup(t, objects, [{ id: 'doc1', s3Key: 'p1/a.pdf' }]);
  const azure = fakeAzure();
  const drillList = path.join(s.dir, 'drill.jsonl');
  const copied = await run(s.copyArgs(), deps(fakeSource(objects), azure));
  azure.originals.blobs.set('p1/b.pdf', { body: OTHER, tier: 'Archive', metadata: { sha256: sha256(OTHER) } });
  await run(s.verifyArgs(), deps(fakeSource(objects), azure));
  await run(['drill', '--account', ACCOUNT, '--drill-list', drillList], deps(fakeSource(objects), azure));

  assert.strictEqual(copied.summary.planned, 1);
  assert.deepStrictEqual(azure.writes, []);
  assert.strictEqual(fs.existsSync(drillList), false);
});

test('no URL or credential reaches the log output', async (t) => {
  const objects = { 'p1/a.pdf': { body: PDF } };
  const s = setup(t, objects);
  const leak = new Error('GET https://nrs.objectstore.gov.bc.ca/zdspnb/p1/a.pdf?X-Amz-Signature=deadbeef ' +
    'failed for fake-source-secret-for-test X-Amz-Credential=FAKEACCESSKEYFORTEST/20261005');
  const source = fakeSource(objects, { failGet: { 'p1/a.pdf': leak } });
  await run(s.copyArgs('--live'), deps(source, fakeAzure()));

  const out = s.logs.join('\n');
  assert.match(out, /p1\/a\.pdf/, 'the failure was logged');
  assert.doesNotMatch(out, /https?:\/\//);
  assert.doesNotMatch(out, /deadbeef|fake-source-secret-for-test|FAKEACCESSKEYFORTEST/);
});

function writeListing(s, rows) {
  fs.writeFileSync(s.bucketList, rows.map(([key, size, etag]) => JSON.stringify({ key, size, etag })).join('\n'));
}

/** A clean live copy of one multipart object. */
async function multipartBackedUp(t) {
  const objects = { 'p1/big.pdf': { body: PDF, etag: `${md5(PDF)}-2` } };
  const s = setup(t, objects);
  const azure = fakeAzure();
  await run(s.copyArgs('--live'), deps(fakeSource(objects), azure));
  return { s, azure };
}

/** A clean live copy of two objects, for verify to reconcile. */
async function backedUp(t, rows = [{ id: 'doc1', s3Key: 'p1/a.pdf' }, { id: 'doc2', s3Key: 'p1/b.pdf' }]) {
  const objects = { 'p1/a.pdf': { body: PDF }, 'p1/b.pdf': { body: OTHER } };
  const s = setup(t, objects, rows);
  const azure = fakeAzure();
  await run(s.copyArgs('--live'), deps(fakeSource(objects), azure));
  return { s, azure, objects };
}

test('verify exits 0 and writes the manifest and summary when every key is backed up', async (t) => {
  const { s, azure, objects } = await backedUp(t);
  const result = await run(s.verifyArgs('--live'), deps(fakeSource(objects), azure));

  const names = [...azure.manifests.blobs.keys()];
  const manifest = azure.manifests.blobs.get('test/2026-10-05T12-00-00-000Z/objects.jsonl.gz').body;
  const summary = JSON.parse(azure.manifests.blobs.get('test/2026-10-05T12-00-00-000Z/summary.json').body);
  const lines = zlib.gunzipSync(manifest).toString().trim().split('\n').map(l => JSON.parse(l));
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(names.length, 2);
  assert.strictEqual(summary.manifest.sha256, sha256(manifest));
  assert.deepStrictEqual(lines.map(l => [l.key, l.sha256, l.status]),
    [['p1/a.pdf', sha256(PDF), 'ok'], ['p1/b.pdf', sha256(OTHER), 'ok']]);
});

test('verify never replaces a manifest that already exists', async (t) => {
  const { s, azure, objects } = await backedUp(t);
  const name = 'test/2026-10-05T12-00-00-000Z/objects.jsonl.gz';
  azure.manifests.blobs.set(name, { body: Buffer.from('earlier run'), metadata: {} });

  await assert.rejects(run(s.verifyArgs('--live'), deps(fakeSource(objects), azure)), /exists/);
  assert.strictEqual(azure.manifests.blobs.get(name).body.toString(), 'earlier run');
});

test('verify exits 1 when one bucket key has no blob', async (t) => {
  const { s, azure, objects } = await backedUp(t);
  azure.originals.blobs.delete('p1/b.pdf');
  const result = await run(s.verifyArgs(), deps(fakeSource(objects), azure));

  assert.strictEqual(result.exitCode, 1);
  assert.ok(result.summary.gapKeys.includes('p1/b.pdf: missing'));
  assert.strictEqual(result.summary.gapsByReason.count, 1);
});

test('verify exits 1 when a blob size differs from the bucket listing', async (t) => {
  const { s, azure, objects } = await backedUp(t);
  fs.writeFileSync(s.bucketList, [
    JSON.stringify({ key: 'p1/a.pdf', size: PDF.length + 1, etag: md5(PDF) }),
    JSON.stringify({ key: 'p1/b.pdf', size: OTHER.length, etag: md5(OTHER) })
  ].join('\n'));
  const result = await run(s.verifyArgs(), deps(fakeSource(objects), azure));

  assert.strictEqual(result.exitCode, 1);
  assert.ok(result.summary.gapKeys.includes('p1/a.pdf: size-mismatch'));
  assert.strictEqual(result.summary.gapsByReason.bytes, 1);
});

test('verify exits 1 when a blob is not in the Archive tier', async (t) => {
  const { s, azure, objects } = await backedUp(t);
  azure.originals.blobs.get('p1/a.pdf').tier = 'Cool';
  const result = await run(s.verifyArgs(), deps(fakeSource(objects), azure));

  assert.strictEqual(result.exitCode, 1);
  assert.deepStrictEqual(result.summary.gapKeys, ['p1/a.pdf: not-archive']);
});

test('verify exits 1 when a blob MD5 differs from the single-part source ETag', async (t) => {
  const { s, azure, objects } = await backedUp(t);
  writeListing(s, [['p1/a.pdf', PDF.length, md5(OTHER)], ['p1/b.pdf', OTHER.length, md5(OTHER)]]);
  const result = await run(s.verifyArgs(), deps(fakeSource(objects), azure));

  assert.strictEqual(result.exitCode, 1);
  assert.deepStrictEqual(result.summary.gapKeys, ['p1/a.pdf: md5-mismatch']);
});

test('verify passes a multipart blob whose recorded source ETag equals the listing', async (t) => {
  const { s, azure } = await multipartBackedUp(t);
  const result = await run(s.verifyArgs(), deps(fakeSource({}), azure));

  assert.strictEqual(result.exitCode, 0);
});

test('verify exits 1 when a multipart blob was copied from a different source ETag', async (t) => {
  const { s, azure } = await multipartBackedUp(t);
  writeListing(s, [['p1/big.pdf', PDF.length, `${md5(OTHER)}-2`]]);
  const result = await run(s.verifyArgs(), deps(fakeSource({}), azure));

  assert.strictEqual(result.exitCode, 1);
  assert.deepStrictEqual(result.summary.gapKeys, ['p1/big.pdf: md5-mismatch']);
});

test('verify exits 1 when the stored Content-MD5 differs from the md5 metadata', async (t) => {
  const { s, azure, objects } = await backedUp(t);
  azure.originals.blobs.get('p1/a.pdf').contentMD5 = Buffer.from(md5(OTHER), 'hex');
  const result = await run(s.verifyArgs(), deps(fakeSource(objects), azure));

  assert.strictEqual(result.exitCode, 1);
  assert.deepStrictEqual(result.summary.gapKeys, ['p1/a.pdf: content-md5']);
});

test('verify exits 1 when a blob has no sha256 metadata', async (t) => {
  const { s, azure, objects } = await backedUp(t);
  delete azure.originals.blobs.get('p1/a.pdf').metadata.sha256;
  const result = await run(s.verifyArgs(), deps(fakeSource(objects), azure));

  assert.strictEqual(result.exitCode, 1);
  assert.deepStrictEqual(result.summary.gapKeys, ['p1/a.pdf: no-sha256']);
});

test('verify exits 1 when a blob is not in the bucket listing', async (t) => {
  const { s, azure, objects } = await backedUp(t);
  azure.originals.blobs.set('p1/x.pdf', { ...azure.originals.blobs.get('p1/a.pdf') });
  const result = await run(s.verifyArgs(), deps(fakeSource(objects), azure));

  assert.strictEqual(result.exitCode, 1);
  assert.deepStrictEqual(result.summary.gapKeys, ['p1/x.pdf: not-in-bucket']);
  assert.strictEqual(result.summary.gapsByReason.count, 1);
});

test('verify exits 1 when Cosmos holds a key that has no blob and is not listed as missing', async (t) => {
  const rows = [{ id: 'doc1', s3Key: 'p1/a.pdf' }, { id: 'doc2', s3Key: 'p1/b.pdf' }, { id: 'doc3', s3Key: 'p9/gone.pdf' }];
  const { s, azure, objects } = await backedUp(t, rows);
  const result = await run(s.verifyArgs(), deps(fakeSource(objects), azure));

  assert.strictEqual(result.exitCode, 1);
  assert.strictEqual(result.summary.cosmos.keys, 3);
  assert.strictEqual(result.summary.cosmos.backed, 2);
});

test('verify does not accept a bucket key as missing from the source', async (t) => {
  const { s, azure, objects } = await backedUp(t);
  const missing = path.join(s.dir, 'missing.txt');
  fs.writeFileSync(missing, 'p1/b.pdf\n');
  azure.originals.blobs.delete('p1/b.pdf');
  const result = await run(s.verifyArgs('--bucket-missing', missing), deps(fakeSource(objects), azure));

  assert.ok(result.summary.gapKeys.includes('p1/b.pdf: cosmos-unbacked'));
  assert.deepStrictEqual(result.summary.missingInSource, []);
});

test('verify accepts a Cosmos key the copy listed as missing from the source', async (t) => {
  const rows = [{ id: 'doc1', s3Key: 'p1/a.pdf' }, { id: 'doc2', s3Key: 'p1/b.pdf' }, { id: 'doc3', s3Key: 'p9/gone.pdf' }];
  const { s, azure, objects } = await backedUp(t, rows);
  const missing = path.join(s.dir, 'missing.txt');
  await run(s.copyArgs('--live', '--missing-out', missing), deps(fakeSource(objects), azure));
  const result = await run(s.verifyArgs('--bucket-missing', missing), deps(fakeSource(objects), azure));

  assert.strictEqual(result.exitCode, 0);
  assert.deepStrictEqual(result.summary.missingInSource, ['p9/gone.pdf']);
});

/** A drill started on one sample, with the restored copy handed back for the test to settle. */
async function drillStarted(t) {
  const { s, azure, objects } = await backedUp(t);
  const drillList = path.join(s.dir, 'drill.jsonl');
  const drill = ['drill', '--account', ACCOUNT, '--drill-list', drillList, '--sample', '1', '--live'];
  await run(drill, { ...deps(fakeSource(objects), azure), random: () => 0 });
  const [restored] = [...azure.restore.blobs.values()];
  const original = azure.originals.blobs.get(restored.from.split('/originals/')[1]).body;
  const check = () => run([...drill, '--check'], deps(fakeSource(objects), azure));
  return { azure, restored, original, check };
}

/** The restored copy once rehydration has finished: archiveStatus cleared, tier online. */
const rehydrated = body => ({ archiveStatus: undefined, accessTier: 'Cool', body });

test('drill restores a sample at Cool and passes once each sha256 matches', async (t) => {
  const { azure, restored, original, check } = await drillStarted(t);
  const pending = await check();
  Object.assign(restored, rehydrated(original));
  const done = await check();

  assert.strictEqual(restored.tier, 'Cool');
  assert.strictEqual(restored.priority, 'Standard');
  assert.strictEqual(pending.exitCode, 2);
  assert.strictEqual(done.summary.matched, 1);
  assert.strictEqual(done.exitCode, 0);
  assert.strictEqual(azure.restore.blobs.size, 0, 'the restored copy is deleted after the check');
});

test('drill check fails a restored copy whose sha256 differs from the metadata', async (t) => {
  const { restored, original, check } = await drillStarted(t);
  Object.assign(restored, rehydrated(Buffer.concat([original, Buffer.from('x')])));
  const result = await check();

  assert.strictEqual(result.summary.mismatch, 1);
  assert.strictEqual(result.exitCode, 1);
});

test('drill check fails a copy that did not succeed, even when its bytes would match', async (t) => {
  const { restored, original, check } = await drillStarted(t);
  Object.assign(restored, { ...rehydrated(original), copyStatus: 'aborted' });
  const result = await check();

  assert.strictEqual(result.summary.matched, 0);
  assert.strictEqual(result.exitCode, 1);
});

test('drill check counts a copy as pending while it is still rehydrating, though the copy reports success', async (t) => {
  const { restored, check } = await drillStarted(t);
  const result = await check();

  assert.strictEqual(restored.copyStatus, 'success');
  assert.deepStrictEqual([result.summary.pending, result.summary.failed, result.exitCode], [1, 0, 2]);
});

test('drill check fails a copy left in the Archive tier with no rehydration under way', async (t) => {
  const { restored, original, check } = await drillStarted(t);
  Object.assign(restored, { archiveStatus: undefined, body: original });
  const result = await check();

  assert.deepStrictEqual([result.summary.matched, result.exitCode], [0, 1]);
  // Refused from its properties, never by attempting a download Azure would refuse.
  assert.match(result.summary.failures[0], /tier Archive, archiveStatus none/);
});

test('drill check names the status and error code when a restored copy is gone', async (t) => {
  const { azure, check } = await drillStarted(t);
  azure.restore.blobs.clear();
  const result = await check();

  assert.strictEqual(result.exitCode, 1);
  assert.match(result.summary.failures[0], /: 404 BlobNotFound$/);
});

test('copy names the status and error code when the exists check fails with no message', async (t) => {
  const objects = { 'p1/a.pdf': { body: PDF } };
  const s = setup(t, objects);
  const azure = fakeAzure();
  // A HEAD response has no body, so Azure's RestError carries an empty message.
  azure.originals.existsFails = {
    'p1/a.pdf': {
      name: 'RestError', message: '', statusCode: 403,
      response: { headers: { get: () => 'AuthorizationPermissionMismatch' } }
    }
  };
  const result = await run(s.copyArgs('--live'), deps(fakeSource(objects), azure));

  assert.strictEqual(result.exitCode, 1);
  assert.match(result.summary.failures[0], /^p1\/a\.pdf: 403 AuthorizationPermissionMismatch$/);
});

test('list-bucket writes key, size and unquoted ETag, and counts multipart ETags', async (t) => {
  const s = setup(t, {});
  const out = path.join(s.dir, 'listing.jsonl');
  const objects = { 'p1/a.pdf': { body: PDF }, 'p1/big.pdf': { body: OTHER, etag: `${md5(OTHER)}-3` } };
  const result = await run(['list-bucket', '--bucket', BUCKET, '--out', out], { source: fakeSource(objects) });

  const rows = fs.readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual(rows[0], { key: 'p1/a.pdf', size: PDF.length, etag: md5(PDF) });
  assert.strictEqual(result.summary.multipart, 1);
});

test('export-rows writes every row of every partition with its key, size and read level', async (t) => {
  const s = setup(t, {});
  const out = path.join(s.dir, 'rows-out.jsonl');
  const docs = [
    { id: 'a', projectId: '1', s3Key: '1/a.pdf', fileSize: 10, read: ['public'] },
    { id: 'b', projectId: '2', s3Key: '', fileSize: null, read: [] }
  ];
  await run(['export-rows', '--out', out], {
    documents: { async listDistinctProjectIds() { return ['1', '2']; } },
    readRows: async (access, projectId) => docs.filter(d => d.projectId === projectId)
  });

  const rows = fs.readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual(rows, [
    { id: 'a', s3Key: '1/a.pdf', fileSize: 10, read: ['public'] },
    { id: 'b', s3Key: '', fileSize: null, read: [] }
  ]);
});

const RESTIC = 'DO_NOT_DELETE_restic_backup/';

/** A bucket with one document object and one object under the restic prefix, copied with that prefix excluded. */
async function filteredBackup(t, rows = [{ id: 'doc1', s3Key: 'p1/a.pdf' }]) {
  const objects = { 'p1/a.pdf': { body: PDF }, [`${RESTIC}data/x`]: { body: OTHER } };
  const s = setup(t, objects, rows);
  const azure = fakeAzure();
  const d = deps(fakeSource(objects), azure);
  await run(s.copyArgs('--live', '--exclude-prefix', RESTIC), d);
  return { s, azure, d };
}

test('list-bucket leaves out keys under each excluded prefix and reports their totals', async (t) => {
  const s = setup(t, {});
  const out = path.join(s.dir, 'listing.jsonl');
  const objects = { 'p1/a.pdf': { body: PDF }, [`${RESTIC}data/x`]: { body: OTHER }, 'z/y': { body: PDF } };
  const result = await run(['list-bucket', '--bucket', BUCKET, '--out', out,
    '--exclude-prefix', RESTIC, '--exclude-prefix', 'z/'], { source: fakeSource(objects) });

  const keys = fs.readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l).key);
  assert.deepStrictEqual(keys, ['p1/a.pdf']);
  assert.deepStrictEqual(result.summary.excluded, { objects: 2, bytes: OTHER.length + PDF.length });
  assert.match(s.logs.join('\n'), /excluded=.*DO_NOT_DELETE_restic_backup/);
});

test('copy and verify with the same exclusion skip the prefix and verify clean, recording what was left out', async (t) => {
  const { s, azure, d } = await filteredBackup(t);
  const result = await run(s.verifyArgs('--live', '--exclude-prefix', RESTIC), d);
  const summary = JSON.parse(azure.manifests.blobs.get('test/2026-10-05T12-00-00-000Z/summary.json').body);

  assert.deepStrictEqual([...azure.originals.blobs.keys()], ['p1/a.pdf']);
  assert.strictEqual(result.exitCode, 0);
  assert.deepStrictEqual(summary.bucket, { objects: 1, bytes: PDF.length });
  assert.deepStrictEqual(summary.excluded, {
    prefixes: [RESTIC], bucket: { objects: 1, bytes: OTHER.length }, blobs: { objects: 0, bytes: 0 }
  });
});

test('verify without the exclusion still counts the excluded objects as missing', async (t) => {
  const { s, d } = await filteredBackup(t);
  const result = await run(s.verifyArgs(), d);

  assert.strictEqual(result.exitCode, 1);
  assert.ok(result.summary.gapKeys.includes(`${RESTIC}data/x: missing`));
});

test('verify with an exclusion still fails on a document key under the excluded prefix', async (t) => {
  const { s, d } = await filteredBackup(t, [{ id: 'doc1', s3Key: 'p1/a.pdf' }, { id: 'doc9', s3Key: `${RESTIC}data/x` }]);
  const result = await run(s.verifyArgs('--exclude-prefix', RESTIC), d);

  assert.strictEqual(result.exitCode, 1);
  assert.ok(result.summary.gapKeys.includes(`${RESTIC}data/x: cosmos-unbacked`));
});

test('parseArgs refuses an unknown subcommand and an account name that is not one', () => {
  assert.throws(() => parseArgs(['backup']), /first argument/);
  assert.throws(() => parseArgs(['drill', '--account', 'evil.example.com/x', '--drill-list', 'd']), /storage account/);
  assert.throws(() => parseArgs(['list-bucket', '--bucket', 'b', '--out', 'o', '--exclude-prefix']), /needs a prefix/);
});
