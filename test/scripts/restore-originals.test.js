'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');

// Script first: once the logger loads, its exception handler turns a failed require into a pass.
const { parseArgs, run } = require('../../src/scripts/restore-originals');
const { logger } = require('../../src/utils/logger');

const ACCOUNT = 'eaglebaktestabc';
const NOW = new Date('2026-10-05T12:00:00Z');
const SIGNATURE = 'fakesignaturefortest';
const md5 = buf => crypto.createHash('md5').update(buf).digest('hex');
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

const ORIGINAL = Buffer.from('%PDF-1.7 original bytes');
const TITLED = Buffer.concat([ORIGINAL, Buffer.from(' plus a title increment')]);
const OTHER = Buffer.from('%PDF-1.7 another original');
const OTHER_TITLED = Buffer.concat([OTHER, Buffer.from(' titled')]);

/** Object store double. `put` honours If-Match and Content-MD5 the way the store does. */
function fakeStore(objects, { onUploadUrl, readBack = {} } = {}) {
  const store = new Map(Object.entries(objects).map(([k, body]) => [k, { body, etag: md5(body) }]));
  const puts = [];
  return {
    store, puts,
    storage: {
      async statObject(key) {
        const o = store.get(key);
        return o ? { size: o.body.length, etag: `"${o.etag}"`, contentType: 'application/pdf' } : null;
      },
      async getUploadUrl(key, opts) {
        if (onUploadUrl) onUploadUrl(store, key);
        return `https://nrs.example/zdspnb/${key}?X-Amz-Signature=${SIGNATURE}&md5=${encodeURIComponent(opts.contentMd5)}`;
      },
      async getObjectStream(key) {
        return Readable.from([readBack[key] || store.get(key).body]);
      }
    },
    async put(url, file, headers) {
      const key = decodeURIComponent(new URL(url).pathname.replace('/zdspnb/', ''));
      const body = fs.readFileSync(file);
      puts.push({ key, headers });
      const o = store.get(key);
      // Like the store: no If-Match means an unconditional write.
      if ('If-Match' in headers && (!o || headers['If-Match'] !== `"${o.etag}"`)) return 412;
      if (Buffer.from(headers['Content-MD5'], 'base64').toString('hex') !== md5(body)) return 400;
      store.set(key, { body, etag: md5(body) });
      return 200;
    }
  };
}

/** Archive double: `originals` holds the backups; a copy into `restore` stays archived until finished. */
function fakeAzure(originals) {
  const restore = new Map();
  const copies = [];
  const containerFor = (cname) => ({
    getBlockBlobClient(name) {
      return {
        url: `https://${ACCOUNT}.blob.core.windows.net/${cname}/${name}`,
        async getProperties() {
          const b = restore.get(name);
          if (!b) throw Object.assign(new Error('BlobNotFound'), { statusCode: 404 });
          return { copyStatus: b.copyStatus, accessTier: b.accessTier, archiveStatus: b.archiveStatus, contentType: 'application/pdf' };
        },
        async beginCopyFromURL(url, opts) {
          copies.push({ name, url, ...opts });
          const source = decodeURIComponent(url.split('/originals/')[1]);
          // Like Azure out of Archive: copy success at once, the wait only in archiveStatus.
          restore.set(name, {
            copyStatus: 'success', accessTier: 'Archive', archiveStatus: 'rehydrate-pending-to-cool', body: originals[source]
          });
        },
        async download() {
          const b = restore.get(name);
          if (b.accessTier === 'Archive') throw Object.assign(new Error('This operation is not permitted on an archived blob.'), { statusCode: 409 });
          return { readableStreamBody: Readable.from([b.body]) };
        }
      };
    }
  });
  const finish = () => { for (const b of restore.values()) Object.assign(b, { archiveStatus: undefined, accessTier: 'Cool' }); };
  return { containerFor, restore, copies, finish };
}

/** Cosmos double: `patch` is refused with 412 unless the caller read the current `_etag`. */
function fakeDocs(rows) {
  const stored = new Map(rows.map(r => [r.id, { _etag: 'e1', ...structuredClone(r) }]));
  const patches = [];
  return {
    stored, patches,
    documents: {
      async listDistinctProjectIds() { return [...new Set(rows.map(r => r.projectId))]; },
      async readForWrite(id) { return stored.has(id) ? structuredClone(stored.get(id)) : null; }
    },
    async readRows(access, projectId) {
      return [...stored.values()].filter(r => String(r.projectId) === projectId).map(r => structuredClone(r));
    },
    async patch(doc, ops) {
      const row = stored.get(doc.id);
      if (row._etag !== doc._etag) throw Object.assign(new Error('Precondition failed'), { code: 412 });
      for (const op of ops) row.pdfTitle[op.path.split('/')[2]] = op.value;
      row._etag = `${row._etag}+`;
      patches.push(doc.id);
    }
  };
}

function titledRecord(key, original, titled) {
  return {
    sourceKey: key, status: 'titled', reason: null, title: 'Public name', at: '2026-10-01T00:00:00Z',
    titledLength: titled.length, titledSha256: sha256(titled),
    originalLength: original.length, originalSha256: sha256(original), originalEtag: md5(original)
  };
}

function manifestLine(key, body, extra = {}) {
  return { key, size: body.length, etag: md5(body), md5: md5(body), sha256: sha256(body), documentIds: [], status: 'ok', ...extra };
}

/**
 * Two titled files (`p1/a.pdf`, `p2/b.pdf`) and one never-titled file (`p1/c.pdf`) that still
 * matches its backup. `bucket`, `archive`, `rows` and `manifest` override the defaults.
 */
function setup(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-originals-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bucket = opts.bucket || { 'p1/a.pdf': TITLED, 'p2/b.pdf': OTHER_TITLED, 'p1/c.pdf': OTHER };
  const archive = opts.archive || { 'p1/a.pdf': ORIGINAL, 'p2/b.pdf': OTHER, 'p1/c.pdf': OTHER };
  const rows = opts.rows || [
    { id: 'a', projectId: 'p1', s3Key: 'p1/a.pdf', pdfTitle: titledRecord('p1/a.pdf', ORIGINAL, TITLED) },
    { id: 'b', projectId: 'p2', s3Key: 'p2/b.pdf', pdfTitle: titledRecord('p2/b.pdf', OTHER, OTHER_TITLED) },
    { id: 'c', projectId: 'p1', s3Key: 'p1/c.pdf' }
  ];
  const manifest = path.join(dir, 'objects.jsonl.gz');
  const lines = opts.manifest || Object.entries(archive).map(([k, body]) => manifestLine(k, body));
  fs.writeFileSync(manifest, zlib.gzipSync(lines.map(l => JSON.stringify(l)).join('\n') + '\n'));

  const logs = [];
  for (const level of ['info', 'warn', 'error']) {
    t.mock.method(logger, level, (...args) => { logs.push(JSON.stringify(args)); });
  }
  const store = fakeStore(bucket, opts.store);
  const azure = fakeAzure(archive);
  const docs = fakeDocs(rows);
  const deps = {
    storage: store.storage, put: store.put, containerFor: azure.containerFor,
    documents: docs.documents, readRows: docs.readRows, patch: docs.patch, now: () => NOW
  };
  const go = (mode, ...extra) => run([mode, '--manifest', manifest, ...(mode === 'plan' ? [] : ['--account', ACCOUNT]), ...extra], deps);
  return { dir, store, azure, docs, logs, go };
}

/** Rehydrate the selection and let every copy land, so apply finds the rows ready. */
async function rehydrated(s, ...selection) {
  await s.go('rehydrate', ...selection, '--live');
  s.azure.finish();
}

test('plan --all-changed lists only the keys whose object differs from its backup, read-only', async (t) => {
  const s = setup(t);
  const out = path.join(s.dir, 'ids.txt');
  const result = await s.go('plan', '--all-changed', '--out', out);
  assert.strictEqual(result.exitCode, 0);
  assert.deepStrictEqual(fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).sort(), ['a', 'b']);
  assert.strictEqual(result.summary.unchanged, 1);
  assert.deepStrictEqual([s.store.puts.length, s.azure.copies.length, s.docs.patches.length], [0, 0, 0]);
});

test('plan --project selects only the documents of that project', async (t) => {
  const s = setup(t);
  const out = path.join(s.dir, 'ids.txt');
  const result = await s.go('plan', '--project', 'p2', '--out', out);
  assert.strictEqual(fs.readFileSync(out, 'utf8'), 'b\n');
  assert.strictEqual(result.summary.selectedDocs, 1);
});

test('plan --ids reads the named documents and fails on an id that does not exist', async (t) => {
  const s = setup(t);
  const ids = path.join(s.dir, 'in.txt');
  fs.writeFileSync(ids, 'a\nnope\n');
  const result = await s.go('plan', '--ids', ids);
  assert.strictEqual(result.summary.restore, 1);
  assert.strictEqual(result.summary.notFound, 1);
  assert.strictEqual(result.exitCode, 1);
});

test('plan refuses a key the manifest does not hold as a verified backup', async (t) => {
  const s = setup(t, { manifest: [manifestLine('p1/a.pdf', ORIGINAL, { status: 'md5-mismatch' })] });
  const result = await s.go('plan', '--id', 'a');
  assert.strictEqual(result.summary.refused, 1);
  assert.strictEqual(result.exitCode, 1);
});

test('apply leaves an object that already matches its backup unwritten', async (t) => {
  const s = setup(t);
  const result = await s.go('apply', '--id', 'c', '--live', '--confirm', '0');
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.summary.unchanged, 1);
  assert.strictEqual(s.store.puts.length, 0);
});

test('rehydrate starts one Cool, standard-priority copy per changed key and none on a rerun', async (t) => {
  const s = setup(t);
  await s.go('rehydrate', '--all-changed', '--live');
  const again = await s.go('rehydrate', '--all-changed', '--live');
  s.azure.finish();
  const third = await s.go('rehydrate', '--all-changed', '--live');
  assert.deepStrictEqual(s.azure.copies.map(c => [c.name, c.tier, c.rehydratePriority]).sort(), [
    ['originals/p1/a.pdf', 'Cool', 'Standard'], ['originals/p2/b.pdf', 'Cool', 'Standard']
  ]);
  assert.strictEqual(again.summary.pending, 2);
  assert.strictEqual(third.summary.ready, 2);
});

test('status counts rows not started, pending and ready', async (t) => {
  const s = setup(t);
  await s.go('rehydrate', '--id', 'a', '--live');
  const result = await s.go('status', '--all-changed');
  assert.deepStrictEqual([result.summary.pending, result.summary.absent], [1, 1]);
  assert.strictEqual(result.exitCode, 2);
});

test('apply waits on a copy that reports success but is still rehydrating', async (t) => {
  const s = setup(t);
  await s.go('rehydrate', '--id', 'a', '--live');
  const result = await s.go('apply', '--id', 'a', '--live', '--confirm', '0');
  assert.deepStrictEqual([result.summary.pending, result.exitCode], [1, 2]);
  assert.strictEqual(s.store.puts.length, 0);
});

test('apply writes the backup back under If-Match and Content-MD5, then marks the record restored', async (t) => {
  const s = setup(t);
  await rehydrated(s, '--id', 'a');
  const result = await s.go('apply', '--id', 'a', '--live', '--confirm', '1');

  assert.strictEqual(result.exitCode, 0);
  assert.ok(s.store.store.get('p1/a.pdf').body.equals(ORIGINAL));
  assert.strictEqual(s.store.puts[0].headers['If-Match'], `"${md5(TITLED)}"`);
  assert.strictEqual(s.store.puts[0].headers['Content-MD5'], Buffer.from(md5(ORIGINAL), 'hex').toString('base64'));
  const record = s.docs.stored.get('a').pdfTitle;
  assert.deepStrictEqual([record.status, record.title, record.titledLength, record.titledSha256], ['restored', null, null, null]);
  assert.strictEqual(record.originalSha256, sha256(ORIGINAL));
});

test('apply refuses rehydrated bytes that do not match the manifest, writing nothing', async (t) => {
  const s = setup(t, { archive: { 'p1/a.pdf': OTHER }, manifest: [manifestLine('p1/a.pdf', ORIGINAL)] });
  await rehydrated(s, '--id', 'a');
  const result = await s.go('apply', '--id', 'a', '--live', '--confirm', '1');
  assert.strictEqual(result.summary.refused, 1);
  assert.match(s.logs.join('\n'), /reason=backup-hash-mismatch/);
  assert.strictEqual(s.store.puts.length, 0);
  assert.strictEqual(s.docs.stored.get('a').pdfTitle.status, 'titled');
  assert.strictEqual(result.exitCode, 1);
});

test('plan refuses a row whose record names a different original than the backup', async (t) => {
  const s = setup(t, { manifest: [manifestLine('p1/a.pdf', ORIGINAL, { sha256: sha256(OTHER) })] });
  const result = await s.go('plan', '--id', 'a');
  assert.strictEqual(result.summary.refused, 1);
  assert.match(s.logs.join('\n'), /reason=record-original-differs/);
});

test('apply skips and reports a row whose object changed after the plan (412)', async (t) => {
  const s = setup(t, { store: { onUploadUrl: (store, key) => store.set(key, { body: OTHER_TITLED, etag: md5(OTHER_TITLED) }) } });
  await rehydrated(s, '--id', 'a');
  const result = await s.go('apply', '--id', 'a', '--live', '--confirm', '1');
  assert.strictEqual(result.summary.changed, 1);
  assert.ok(s.store.store.get('p1/a.pdf').body.equals(OTHER_TITLED));
  assert.strictEqual(s.docs.patches.length, 0);
  assert.strictEqual(result.exitCode, 1);
});

test('apply reports a read-back that differs and leaves the record untouched', async (t) => {
  const s = setup(t, { store: { readBack: { 'p1/a.pdf': TITLED } } });
  await rehydrated(s, '--id', 'a');
  const result = await s.go('apply', '--id', 'a', '--live', '--confirm', '1');
  assert.strictEqual(result.summary.failed, 1);
  assert.strictEqual(s.docs.stored.get('a').pdfTitle.status, 'titled');
  assert.strictEqual(result.exitCode, 1);
});

test('apply refuses a row whose record holds a lease, writing nothing', async (t) => {
  const record = { ...titledRecord('p1/a.pdf', ORIGINAL, TITLED), lease: { leaseId: 'x', expiresAt: '2099-01-01T00:00:00Z' } };
  const s = setup(t, { rows: [{ id: 'a', projectId: 'p1', s3Key: 'p1/a.pdf', pdfTitle: record }] });
  await rehydrated(s, '--id', 'a');
  const result = await s.go('apply', '--id', 'a', '--live', '--confirm', '0');
  assert.strictEqual(result.summary.refused, 1);
  assert.strictEqual(s.store.puts.length, 0);
});

test('plan counts a leased row whose object still matches its backup as unchanged', async (t) => {
  const record = { ...titledRecord('p1/a.pdf', ORIGINAL, TITLED), status: 'skipped', lease: { leaseId: 'x' } };
  const s = setup(t, { bucket: { 'p1/a.pdf': ORIGINAL }, rows: [{ id: 'a', projectId: 'p1', s3Key: 'p1/a.pdf', pdfTitle: record }] });
  const result = await s.go('plan', '--all-changed');
  assert.deepStrictEqual([result.summary.unchanged, result.exitCode], [1, 0]);
});

test('apply on a rerun fixes a record left titled after its object was already restored', async (t) => {
  const s = setup(t, { bucket: { 'p1/a.pdf': ORIGINAL } });
  const result = await s.go('apply', '--id', 'a', '--live', '--confirm', '1');
  assert.strictEqual(result.summary.restored, 1);
  assert.strictEqual(s.store.puts.length, 0);
  assert.strictEqual(s.docs.stored.get('a').pdfTitle.status, 'restored');
});

test('a dry run of rehydrate and apply writes nothing', async (t) => {
  const s = setup(t);
  await s.go('rehydrate', '--all-changed');
  assert.strictEqual(s.azure.copies.length, 0);
  await rehydrated(s, '--all-changed');
  const result = await s.go('apply', '--all-changed');
  assert.strictEqual(result.summary.planned, 2);
  assert.deepStrictEqual([s.store.puts.length, s.docs.patches.length], [0, 0]);
});

test('apply --live refuses to start when --confirm is missing or differs from the rows it would write', async (t) => {
  const s = setup(t);
  await rehydrated(s, '--all-changed');
  const wrong = await s.go('apply', '--all-changed', '--live', '--confirm', '1');
  const missing = await s.go('apply', '--all-changed', '--live');
  assert.deepStrictEqual([wrong.exitCode, missing.exitCode], [1, 1]);
  assert.deepStrictEqual([s.store.puts.length, s.docs.patches.length], [0, 0]);
});

test('--max caps how many rows apply writes', async (t) => {
  const s = setup(t);
  await rehydrated(s, '--all-changed');
  const result = await s.go('apply', '--all-changed', '--live', '--max', '1', '--confirm', '1');
  assert.strictEqual(s.store.puts.length, 1);
  assert.strictEqual(result.summary.deferred, 1);
});

test('no signed URL reaches the log output, even when the PUT fails', async (t) => {
  const s = setup(t);
  await rehydrated(s, '--id', 'a');
  const failing = async (url) => { throw new Error(`connect ECONNRESET ${url}`); };
  const deps = {
    storage: s.store.storage, put: failing, containerFor: s.azure.containerFor,
    documents: s.docs.documents, readRows: s.docs.readRows, patch: s.docs.patch, now: () => NOW
  };
  const manifest = path.join(s.dir, 'objects.jsonl.gz');
  const result = await run(['apply', '--id', 'a', '--manifest', manifest, '--account', ACCOUNT, '--live', '--confirm', '1'], deps);
  assert.strictEqual(result.summary.failed, 1);
  assert.ok(!s.logs.join('\n').includes(SIGNATURE));
});

test('parseArgs needs exactly one selection and a manifest', () => {
  assert.throws(() => parseArgs(['plan', '--manifest', 'm', '--id', 'a', '--all-changed']), /exactly one/);
  assert.throws(() => parseArgs(['plan', '--manifest', 'm']), /exactly one/);
  assert.throws(() => parseArgs(['plan', '--id', 'a']), /--manifest/);
  assert.throws(() => parseArgs(['apply', '--manifest', 'm', '--id', 'a']), /--account/);
});
