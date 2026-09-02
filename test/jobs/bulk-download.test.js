'use strict';

/**
 * The bulk-download worker, with the repositories and object storage stubbed — no Cosmos, no NRS.
 *
 * The zips are asserted by reading the bytes the upload received: entries are STORED (no deflate),
 * so an entry name and its content are plain text inside the archive. That keeps the assertions on
 * what a caller actually unzips without adding an unzip dependency for the test suite.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { Readable, PassThrough } = require('node:stream');

const config = require('../../src/config');
const storage = require('../../src/storage');
const cosmos = require('../../src/db/cosmos-nosql');
const bulkDownloads = require('../../src/repositories/bulk-downloads');
const credentials = require('../../src/repositories/credentials');
const projects = require('../../src/repositories/projects');
const { packPartCount } = require('../../src/jobs/pack-parts');
const { logger } = require('../../src/utils/logger');

const worker = require('../../src/jobs/bulk-download');

const PROJECT = { id: '207', name: 'Site C Clean Energy' };

function doc(id, extra = {}) {
  return {
    id,
    projectId: PROJECT.id,
    displayName: `Document ${id}`,
    documentFileName: `${id}.pdf`,
    s3Key: `etl/${id}.pdf`,
    fileExt: 'pdf',
    fileSize: 10,
    mimeType: 'application/pdf',
    ...extra
  };
}

function job(docs, extra = {}) {
  return {
    id: 'job-1',
    status: 'queued',
    documentIds: docs.map(d => d.id),
    access: { authenticated: false, roles: [], level: 4 },
    requesterKey: '198.51.100.7',
    requesterId: '',
    documentCount: docs.length,
    createdAt: new Date().toISOString(),
    parts: [],
    ...extra
  };
}

function collect(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/**
 * Stub every dependency the worker has and hand back what each recorded.
 * `docs` is what the manifest read returns — leaving a requested id out of it is how a test says
 * "no longer visible to this caller".
 */
function harness(t, { row, docs, getObjectStream, putObjectStream } = {}) {
  const patches = [];
  const uploads = new Map();
  const claims = [];
  const removed = [];
  const reads = [];

  t.mock.method(bulkDownloads, 'getById', async () => row);
  // Snapshotted, because Cosmos serialises each patch as it is made and the worker keeps appending
  // to the same `parts` array — recording the reference would show every patch as the last one.
  t.mock.method(bulkDownloads, 'patch', async (id, fields) => {
    patches.push(JSON.parse(JSON.stringify(fields)));
    return fields;
  });
  // The claim, which is an etag-conditioned replace rather than a patch.
  t.mock.method(cosmos, 'replace', async (container, id, pk, item) => {
    claims.push(item);
    return item;
  });
  // REVERSED on purpose: a Cosmos `IN` query answers in whatever order it likes, so the worker has
  // to restore the requested order itself. Returning it already sorted would hide that entirely.
  t.mock.method(bulkDownloads, 'listDocumentsByIds', async (access, ids) => {
    reads.push(access);
    return (docs || []).filter(d => ids.includes(String(d.id))).reverse();
  });
  t.mock.method(projects, 'listByIds', async () => [PROJECT]);
  t.mock.method(storage, 'removeObject', async key => { removed.push(key); });
  t.mock.method(storage, 'putObjectStream', putObjectStream ||
    (async (key, stream) => { uploads.set(key, await collect(stream)); return key; }));
  t.mock.method(storage, 'getObjectStream', getObjectStream ||
    (async key => Readable.from([`bytes of ${key}`])));

  return { patches, uploads, claims, removed, reads, zipText: key => uploads.get(key).toString('latin1') };
}

const finalPatch = patches => patches[patches.length - 1];
const readyPatch = patches => patches.find(p => p.partCount !== undefined) || {};

test('the bulk download worker', async (t) => {
  const maxBytes = config.bulkMaxBytes;
  const maxTotalBytes = config.bulkMaxTotalBytes;
  const maxJobAgeMs = config.bulkMaxJobAgeMs;
  t.afterEach(() => {
    t.mock.restoreAll();
    config.bulkMaxBytes = maxBytes;
    config.bulkMaxTotalBytes = maxTotalBytes;
    config.bulkMaxJobAgeMs = maxJobAgeMs;
  });

  await t.test('a document the manifest no longer returns is dropped and named in errors.txt', async () => {
    const docs = [doc('d1'), doc('d2')];
    const { patches, uploads, zipText } = harness(t, {
      row: job([...docs, doc('d3')]),
      docs
    });

    await worker.run('job-1');

    assert.strictEqual(finalPatch(patches).status, 'ready');
    const ready = readyPatch(patches);
    assert.strictEqual(ready.includedCount, 2, 'the zip holds only what the access snapshot still returns');
    assert.strictEqual(ready.errorCount, 1);
    assert.deepStrictEqual(ready.errors, [{ documentId: 'd3', name: '', reason: 'not available' }]);

    const text = zipText([...uploads.keys()][0]);
    assert.match(text, /errors\.txt/, 'the caller has to be told which files are missing');
    assert.match(text, /d3\t\tnot available/);
    assert.doesNotMatch(text, /bytes of etl\/d3\.pdf/, 'and the document itself must not be in there');
  });

  await t.test('a document with no object key is recorded rather than zipped', async () => {
    const docs = [doc('d1'), doc('d2', { s3Key: '' })];
    const { patches } = harness(t, { row: job(docs), docs });

    await worker.run('job-1');

    assert.strictEqual(readyPatch(patches).includedCount, 1);
    assert.deepStrictEqual(readyPatch(patches).errors,
      [{ documentId: 'd2', name: 'd2.pdf', reason: 'no object key' }]);
  });

  await t.test('names are sanitised and colliding ones are deduped per folder', async () => {
    const docs = [
      doc('d1', { documentFileName: 'Report.pdf' }),
      doc('d2', { documentFileName: 'report.pdf' }),
      doc('d3', { documentFileName: '../../etc/passwd', fileExt: 'pdf' })
    ];
    const { uploads, zipText } = harness(t, { row: job(docs), docs });

    await worker.run('job-1');

    const text = zipText([...uploads.keys()][0]);
    assert.match(text, /Site C Clean Energy\/Report\.pdf/);
    assert.match(text, /Site C Clean Energy\/report \(2\)\.pdf/,
      'two names differing only in case cannot both extract into one folder');
    assert.match(text, /Site C Clean Energy\/etcpasswd\.pdf/,
      'a name carrying path separators must not escape its folder');
    assert.doesNotMatch(text, /\.\.\//);
  });

  await t.test('a right-to-left override cannot disguise the extension', async () => {
    // "invoice‮fdp.exe" renders as "invoiceexe.pdf" in every file manager that honours it.
    const docs = [doc('d1', { documentFileName: 'invoice‮fdp.exe', fileExt: 'exe' })];
    const { uploads, zipText } = harness(t, { row: job(docs), docs });

    await worker.run('job-1');

    const text = zipText([...uploads.keys()][0]);
    assert.doesNotMatch(text, /‮/, 'the character that reverses the name has to be gone');
    assert.match(text, /Site C Clean Energy\/invoicefdp\.exe/);
  });

  await t.test('a dot in the title is not mistaken for an extension', async () => {
    const docs = [doc('d1', { documentFileName: 'Application Report v1.2', fileExt: 'pdf' })];
    const { uploads, zipText } = harness(t, { row: job(docs), docs });

    await worker.run('job-1');

    assert.match(zipText([...uploads.keys()][0]), /Application Report v1\.2\.pdf/,
      'extname would have called ".2" the extension and shipped a file nothing opens');
  });

  await t.test('a name this caller may not see falls back to the document id', async () => {
    // A per-record dial withholds the title. It must not come back as the file name instead.
    const docs = [doc('d1', {
      documentFileName: 'Sealed Enforcement Order.pdf',
      displayName: 'Sealed Enforcement Order',
      vis: { documentFileName: 0, displayName: 0 }
    })];
    const { uploads, zipText } = harness(t, { row: job(docs), docs });

    await worker.run('job-1');

    const text = zipText([...uploads.keys()][0]);
    assert.doesNotMatch(text, /Sealed Enforcement Order/, 'the redactor withheld this title');
    assert.match(text, /Site C Clean Energy\/d1\.pdf/);
  });

  await t.test('a project the caller cannot name becomes unknown-project', async () => {
    const docs = [doc('d1', { projectId: '999' })];
    const { uploads, zipText } = harness(t, { row: job(docs), docs });

    await worker.run('job-1');

    assert.match(zipText([...uploads.keys()][0]), /unknown-project\/d1\.pdf/);
  });

  await t.test('an unreadable object does not abort the part', async () => {
    const docs = [doc('d1'), doc('d2'), doc('d3')];
    const { patches, uploads, zipText } = harness(t, {
      row: job(docs),
      docs,
      getObjectStream: async key => {
        if (key === 'etl/d2.pdf') throw new Error('S3 NoSuchKey ozwdez/etl/d2.pdf');
        return Readable.from([`bytes of ${key}`]);
      }
    });

    await worker.run('job-1');

    const text = zipText([...uploads.keys()][0]);
    assert.match(text, /bytes of etl\/d1\.pdf/);
    assert.match(text, /bytes of etl\/d3\.pdf/, 'the files after the failure still have to be zipped');
    assert.deepStrictEqual(readyPatch(patches).errors,
      [{ documentId: 'd2', name: 'd2.pdf', reason: 'unavailable' }]);
    assert.doesNotMatch(text, /NoSuchKey/, 'the driver message names the bucket layout');
  });

  await t.test('an object that fails mid-stream is recorded and not counted as included', async () => {
    const docs = [doc('d1'), doc('d2')];
    const { patches, uploads, zipText } = harness(t, {
      row: job(docs),
      docs,
      getObjectStream: async key => {
        if (key !== 'etl/d1.pdf') return Readable.from([`bytes of ${key}`]);
        const stream = new PassThrough();
        stream.write('half a ');
        setImmediate(() => stream.destroy(new Error('connection reset')));
        return stream;
      }
    });

    await worker.run('job-1');

    assert.match(zipText([...uploads.keys()][0]), /bytes of etl\/d2\.pdf/);
    const ready = readyPatch(patches);
    assert.deepStrictEqual(ready.errors, [{ documentId: 'd1', name: 'd1.pdf', reason: 'truncated' }]);
    assert.strictEqual(ready.includedCount, 1,
      'a half-written entry counted as included tells the caller they got a file they did not');
  });

  await t.test('each part is patched onto the row as it finishes', async () => {
    config.bulkMaxBytes = 15;
    const docs = [doc('d1'), doc('d2'), doc('d3')];
    const { patches, claims } = harness(t, { row: job(docs), docs });

    await worker.run('job-1');

    const progress = patches.filter(p => p.parts && p.partCount === undefined).map(p => p.parts.length);
    assert.deepStrictEqual(progress, [1, 2, 3], 'a poll has to see partsReady climb, not silence');
    assert.strictEqual(claims.length, 1);
    assert.strictEqual(claims[0].status, 'running');
    assert.ok(claims[0].startedAt);
  });

  await t.test('the parts hold the documents in the order they were asked for', async () => {
    config.bulkMaxBytes = 1000;
    const docs = [
      doc('d0', { fileSize: 900 }),
      doc('d1', { fileSize: 100 }),
      doc('d2', { fileSize: 900 })
    ];
    const { uploads, patches, zipText } = harness(t, { row: job(docs), docs });

    await worker.run('job-1');

    assert.strictEqual(uploads.size, packPartCount(docs, 1000),
      'the worker and the controller must pack identically or partCount lies');
    assert.deepStrictEqual([...uploads.keys()],
      ['zips/job-1-part1.zip', 'zips/job-1-part2.zip']);
    assert.match(zipText('zips/job-1-part1.zip'), /d0\.pdf/,
      'the manifest read answers unordered — part 1 still has to start at the first id asked for');
    assert.doesNotMatch(zipText('zips/job-1-part1.zip'), /d2\.pdf/);

    const ready = readyPatch(patches);
    assert.strictEqual(ready.partCount, uploads.size);
    assert.ok(ready.bytes > 0, 'the row carries the bytes the caller will download');
    assert.strictEqual(ready.ttl, config.bulkJobTtlDays * 24 * 60 * 60);
  });

  await t.test('status is patched last, after the parts it names', async () => {
    const docs = [doc('d1')];
    const { patches } = harness(t, { row: job(docs), docs });

    await worker.run('job-1');

    assert.strictEqual(finalPatch(patches).status, 'ready');
    assert.ok(finalPatch(patches).finishedAt);
    assert.strictEqual(Object.keys(finalPatch(patches)).length, 2,
      'a poll that reads "ready" before the parts land hands out URLs for objects with no keys');
    assert.ok(Object.keys(readyPatch(patches)).length <= 10,
      'Cosmos refuses a patch over PATCH_MAX_OPERATIONS');
  });

  await t.test('a redelivered ready job is not rebuilt', async () => {
    const docs = [doc('d1')];
    const { patches, uploads } = harness(t, { row: job(docs, { status: 'ready' }), docs });

    await worker.run('job-1');

    assert.deepStrictEqual(patches, [], 'a second delivery must not overwrite a finished job');
    assert.strictEqual(uploads.size, 0);
  });

  await t.test('a job another instance is already running is left alone', async (tt) => {
    const docs = [doc('d1')];
    const { patches, uploads, claims } = harness(tt, { row: job(docs, { status: 'running' }), docs });

    assert.strictEqual(await worker.run('job-1'), null);
    assert.deepStrictEqual(claims, [], 'the status alone rules it out before any write');
    assert.deepStrictEqual(patches, []);
    assert.strictEqual(uploads.size, 0);
  });

  await t.test('a job stuck running past the visibility timeout is claimed by the redelivery', async (tt) => {
    const docs = [doc('d1')];
    const startedAt = new Date(Date.now() - config.bulkStaleRunningMs - 60_000).toISOString();
    const { claims } = harness(tt, { row: job(docs, { status: 'running', startedAt }), docs });

    await worker.run('job-1');

    assert.strictEqual(claims.length, 1, 'a dead instance never comes back to finish; the retry must');
    assert.strictEqual(claims[0].status, 'running');
    assert.notStrictEqual(claims[0].startedAt, startedAt);
  });

  await t.test('losing the claim race returns instead of building the zip twice', async (tt) => {
    const docs = [doc('d1')];
    const { patches, uploads } = harness(tt, { row: job(docs), docs });
    tt.mock.method(cosmos, 'replace', async () => {
      const err = new Error('Entity with the specified id already exists');
      err.code = 412;
      throw err;
    });

    assert.strictEqual(await worker.run('job-1'), null, 'a lost race is not a failure to retry');
    assert.deepStrictEqual(patches, []);
    assert.strictEqual(uploads.size, 0);
  });

  await t.test('a job older than the age cap is failed without a retry', async (tt) => {
    config.bulkMaxJobAgeMs = 2 * 60 * 60 * 1000;
    const docs = [doc('d1')];
    const stale = job(docs, { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() });
    const { patches, uploads, claims } = harness(tt, { row: stale, docs });

    assert.strictEqual(await worker.run('job-1'), null, 'a retry would only be older still');

    assert.deepStrictEqual(claims, []);
    assert.strictEqual(uploads.size, 0);
    assert.strictEqual(patches[0].status, 'failed');
    assert.strictEqual(patches[0].error, 'expired before run');
  });

  await t.test('the parts of a previous attempt are deleted before the rebuild', async () => {
    const docs = [doc('d1')];
    const previous = job(docs, {
      status: 'failed',
      parts: [{ n: 1, key: 'zips/job-1-part1.zip' }, { n: 2, key: 'zips/job-1-part2.zip' }]
    });
    const { removed } = harness(t, { row: previous, docs });

    await worker.run('job-1');

    assert.deepStrictEqual(removed, ['zips/job-1-part1.zip', 'zips/job-1-part2.zip'],
      'a rebuild overwrites part1 but orphans every part the shorter run does not reach');
  });

  await t.test('a revoked credential does not survive in the access snapshot', async (tt) => {
    const end = new Date(Date.now() + 86400000).toISOString();
    const docs = [doc('d1')];
    const row = job(docs, {
      requesterId: 'user-1',
      access: { authenticated: true, roles: ['idir'], level: 3, credentials: [{ id: 'c1' }, { id: 'c2' }] }
    });
    const { reads } = harness(tt, { row, docs });
    tt.mock.method(credentials, 'listForParty', async () => [{ id: 'c1', end }, { id: 'c3', end }]);

    await worker.run('job-1');

    assert.deepStrictEqual(reads[0].credentials, [{ id: 'c1' }],
      'c2 was revoked after submit; c3 was granted after it and is not part of what was asked for');
  });

  await t.test('a rejected upload fails the part instead of hanging on it', async (tt) => {
    const docs = [doc('d1')];
    const { patches } = harness(tt, {
      row: job(docs),
      docs,
      // Never ends, so the entry await only settles if the upload rejection reaches it.
      getObjectStream: async () => new PassThrough(),
      putObjectStream: async () => { throw new Error('403 from the object store'); }
    });
    tt.mock.method(logger, 'error', () => {});

    const started = Date.now();
    await assert.rejects(worker.run('job-1'), /403 from the object store/);
    assert.ok(Date.now() - started < 500, 'an upload nobody watches parks a Function instance for 30 minutes');
    assert.strictEqual(finalPatch(patches).status, 'failed');
  });

  await t.test('a selection that outgrows the total cap while streaming fails the job', async (tt) => {
    // Every fileSize is unknown, so nothing was capped at submit — the running total is the check.
    config.bulkMaxTotalBytes = 200;
    const docs = [doc('d1', { fileSize: 0 }), doc('d2', { fileSize: 0 })];
    const { patches } = harness(tt, {
      row: job(docs),
      docs,
      getObjectStream: async () => Readable.from([Buffer.alloc(500, 0x41)])
    });
    tt.mock.method(logger, 'error', () => {});

    await assert.rejects(worker.run('job-1'), /over the size limit/);
    assert.strictEqual(finalPatch(patches).error, 'over the size limit');
  });

  await t.test('a message with no job row is logged and dropped', async (tt) => {
    const { patches } = harness(tt, { row: undefined, docs: [] });
    const warnings = [];
    tt.mock.method(logger, 'warn', message => { warnings.push(message); });

    const result = await worker.run('gone');

    assert.strictEqual(result, null, 'there is nothing to retry, so this must not throw');
    assert.deepStrictEqual(patches, []);
    assert.match(warnings[0], /\[bulk\] job missing gone/);
  });

  await t.test('a failed job is patched, logged for the alert, and rethrown', async (tt) => {
    const { patches } = harness(tt, { row: job([doc('d1')]), docs: [doc('d1')] });
    tt.mock.method(bulkDownloads, 'listDocumentsByIds', async () => { throw new Error('cosmos down'); });
    const errors = [];
    tt.mock.method(logger, 'error', (message, meta) => { errors.push({ message, meta }); });

    await assert.rejects(worker.run('job-1', { attempt: 3, maxAttempts: 3 }), /cosmos down/,
      'the queue only retries what the handler rethrows');

    assert.strictEqual(errors[0].message, '[bulk] job failed job-1: cosmos down',
      'the poison alert matches this string — changing it silently disables the alert');
    const failed = finalPatch(patches);
    assert.strictEqual(failed.status, 'failed');
    assert.strictEqual(failed.error, 'cosmos down');
    assert.ok(failed.finishedAt);
  });

  await t.test('an attempt that still has a retry does not fire the poison alert', async (tt) => {
    harness(tt, { row: job([doc('d1')]), docs: [doc('d1')] });
    tt.mock.method(bulkDownloads, 'listDocumentsByIds', async () => { throw new Error('cosmos down'); });
    const errors = [];
    tt.mock.method(logger, 'error', message => { errors.push(message); });

    await assert.rejects(worker.run('job-1', { attempt: 1, maxAttempts: 3 }), /cosmos down/,
      'it still has to be rethrown, or the message is dropped instead of retried');

    assert.match(errors[0], /^\[bulk\] attempt failed job-1 \(1\/3\)/);
    assert.ok(errors.every(message => !message.startsWith('[bulk] job failed')),
      'paging somebody on delivery 1 of 3 makes the alert noise');
  });
});
