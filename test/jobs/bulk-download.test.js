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
  const released = [];

  t.mock.method(bulkDownloads, 'getById', async () => row);
  // Snapshotted, because Cosmos serialises each patch as it is made and the worker keeps appending
  // to the same `parts` array — recording the reference would show every patch as the last one.
  t.mock.method(bulkDownloads, 'patch', async (id, fields) => {
    patches.push(JSON.parse(JSON.stringify(fields)));
    return fields;
  });
  // The terminal status writes are conditional (see the repository): true is "this worker still
  // owns the row", the ordinary case. A test about cancellation overrides it with false.
  t.mock.method(bulkDownloads, 'patchIfStatus', async (id, fields) => {
    patches.push(JSON.parse(JSON.stringify(fields)));
    return true;
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
  t.mock.method(bulkDownloads, 'releaseSlot', async key => { released.push(key); return true; });
  // The stamp every releaser competes for. True is "this worker claimed it", the ordinary case.
  t.mock.method(bulkDownloads, 'claimSlotRelease', async (id, at) => {
    patches.push({ slotReleasedAt: at });
    return true;
  });
  t.mock.method(storage, 'removeObject', async key => { removed.push(key); });
  t.mock.method(storage, 'putObjectStream', putObjectStream ||
    (async (key, stream) => { uploads.set(key, await collect(stream)); return key; }));
  t.mock.method(storage, 'getObjectStream', getObjectStream ||
    (async key => Readable.from([`bytes of ${key}`])));

  return {
    patches, uploads, claims, removed, reads, released,
    zipText: key => uploads.get(key).toString('latin1')
  };
}

// The one patch that flips the job's status; the metadata it names is patched separately.
const statusPatch = patches => patches.find(p => p.status) || {};
const readyPatch = patches => patches.find(p => p.partCount !== undefined) || {};

test('the bulk download worker', async (t) => {
  const maxBytes = config.bulkMaxBytes;
  const maxTotalBytes = config.bulkMaxTotalBytes;
  const maxJobAgeMs = config.bulkMaxJobAgeMs;
  const fetchAhead = config.bulkFetchAhead;
  t.afterEach(() => {
    t.mock.restoreAll();
    config.bulkMaxBytes = maxBytes;
    config.bulkMaxTotalBytes = maxTotalBytes;
    config.bulkMaxJobAgeMs = maxJobAgeMs;
    config.bulkFetchAhead = fetchAhead;
  });

  await t.test('objects are opened ahead of the append, no more than the window at once', async (tt) => {
    config.bulkFetchAhead = 3;
    const docs = Array.from({ length: 6 }, (_, i) => doc(`d${i}`));
    // `open` when the object store is asked, `read` when the archive has finished that entry —
    // an open recorded before an earlier read is a round trip that overlapped an append.
    const events = [];
    let inFlight = 0;
    let peak = 0;
    const { uploads, zipText } = harness(tt, {
      row: job(docs),
      docs,
      getObjectStream: async key => {
        events.push(`open ${key}`);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise(resolve => setTimeout(resolve, 5));
        inFlight -= 1;
        const stream = Readable.from([`bytes of ${key}`]);
        stream.once('end', () => events.push(`read ${key}`));
        return stream;
      }
    });

    await worker.run('job-1');

    assert.strictEqual(peak, 3,
      'serial fetching peaks at 1 and an unbounded window at 6 — neither is the configured window');
    assert.ok(events.indexOf('open etl/d2.pdf') < events.indexOf('read etl/d0.pdf'),
      'the point of the window: later objects are already in flight while an earlier one is packed');

    const text = zipText([...uploads.keys()][0]);
    const positions = docs.map(d => text.indexOf(`Site C Clean Energy/${d.id}.pdf`));
    assert.ok(positions.every(at => at >= 0), 'every document has to be in the zip');
    assert.deepStrictEqual(positions, [...positions].sort((a, b) => a - b),
      'fetching ahead must not reorder the entries — the zip is still built in the order asked for');
  });

  await t.test('an open that fails inside the window is recorded and the rest still pack', async (tt) => {
    config.bulkFetchAhead = 3;
    const docs = Array.from({ length: 6 }, (_, i) => doc(`d${i}`));
    const { patches, uploads, zipText } = harness(tt, {
      row: job(docs),
      docs,
      getObjectStream: async key => {
        if (key === 'etl/d2.pdf') throw new Error('S3 NoSuchKey ozwdez/etl/d2.pdf');
        return Readable.from([`bytes of ${key}`]);
      }
    });
    const warnings = [];
    tt.mock.method(logger, 'warn', (message, meta) => warnings.push(meta));

    await worker.run('job-1');

    assert.match(warnings[0].error, /NoSuchKey/,
      'the failure logged is the object store\'s, not a TypeError from packing a stream that never opened');
    assert.deepStrictEqual(readyPatch(patches).errors,
      [{ documentId: 'd2', name: 'd2.pdf', reason: 'unavailable' }],
      'a failed open is still that one document\'s error, not the part\'s');
    assert.strictEqual(readyPatch(patches).includedCount, 5);
    const text = zipText([...uploads.keys()][0]);
    const packed = ['d0', 'd1', 'd3', 'd4', 'd5'].map(id => text.indexOf(`${id}.pdf`));
    assert.ok(packed.every(at => at >= 0), 'the documents after the failure still have to be zipped');
    assert.deepStrictEqual(packed, [...packed].sort((a, b) => a - b));
  });

  await t.test('a stream that resets while it waits its turn is re-opened at its turn', async (tt) => {
    config.bulkFetchAhead = 3;
    const docs = [doc('d0'), doc('d1'), doc('d2')];
    const opens = [];
    const { patches, uploads, zipText } = harness(tt, {
      row: job(docs),
      docs,
      getObjectStream: async key => {
        opens.push(key);
        // d0 is slow to pack, so d1 is still parked in the window when its socket resets — the gap
        // the read-ahead opened. Nothing is subscribed to a parked stream but the window itself,
        // so an unhandled 'error' here is an uncaught exception rather than a failed document.
        if (key === 'etl/d0.pdf') {
          const slow = new PassThrough();
          slow.write('bytes of etl/d0.pdf');
          setTimeout(() => slow.end(), 40);
          return slow;
        }
        if (key === 'etl/d1.pdf' && opens.filter(k => k === 'etl/d1.pdf').length === 1) {
          const resets = new PassThrough();
          setTimeout(() => resets.emit('error', new Error('ECONNRESET while queued')), 5);
          return resets;
        }
        return Readable.from([`bytes of ${key}`]);
      }
    });
    tt.mock.method(logger, 'warn', () => {});

    await worker.run('job-1');

    assert.strictEqual(opens.filter(key => key === 'etl/d1.pdf').length, 2,
      'the window held that socket open through another document — a fresh open is what its turn ' +
      'would have given it before the window existed');
    assert.strictEqual(readyPatch(patches).errorCount, 0,
      'an idle socket dropped while parked must not cost the caller the file');
    assert.strictEqual(readyPatch(patches).includedCount, 3);
    assert.match(zipText([...uploads.keys()][0]), /bytes of etl\/d1\.pdf/);
  });

  await t.test('a re-open that fails too is that document\'s failure, and the part carries on', async (tt) => {
    config.bulkFetchAhead = 3;
    const docs = [doc('d0'), doc('d1'), doc('d2')];
    const opens = [];
    const { patches, uploads, zipText } = harness(tt, {
      row: job(docs),
      docs,
      getObjectStream: async key => {
        opens.push(key);
        if (key === 'etl/d0.pdf') {
          const slow = new PassThrough();
          slow.write('bytes of etl/d0.pdf');
          setTimeout(() => slow.end(), 40);
          return slow;
        }
        if (key === 'etl/d1.pdf') {
          if (opens.filter(k => k === 'etl/d1.pdf').length > 1) throw new Error('S3 NoSuchKey');
          const resets = new PassThrough();
          setTimeout(() => resets.emit('error', new Error('ECONNRESET while queued')), 5);
          return resets;
        }
        return Readable.from([`bytes of ${key}`]);
      }
    });
    tt.mock.method(logger, 'warn', () => {});

    await worker.run('job-1');

    assert.strictEqual(opens.filter(key => key === 'etl/d1.pdf').length, 2, 'one retry, not a loop');
    assert.deepStrictEqual(readyPatch(patches).errors,
      [{ documentId: 'd1', name: 'd1.pdf', reason: 'unavailable' }]);
    assert.strictEqual(readyPatch(patches).includedCount, 2);
    assert.match(zipText([...uploads.keys()][0]), /bytes of etl\/d2\.pdf/);
  });

  await t.test('an open that fails for a document the part never reaches is still handled', async (tt) => {
    config.bulkFetchAhead = 3;
    config.bulkMaxBytes = 15;  // one document per part, so every part abandons what it opened ahead
    const docs = [doc('d0'), doc('d1'), doc('d2'), doc('d3')];
    const { patches } = harness(tt, {
      row: job(docs),
      docs,
      getObjectStream: async key => {
        if (key === 'etl/d2.pdf') throw new Error('S3 NoSuchKey ozwdez/etl/d2.pdf');
        return Readable.from([`bytes of ${key}`]);
      }
    });
    tt.mock.method(logger, 'warn', () => {});
    // An open whose promise is dropped unread has to have resolved, not rejected: an abandoned
    // rejection is only ever reported process-wide, long after the job it belonged to.
    const unhandled = [];
    const record = reason => unhandled.push(reason);
    process.on('unhandledRejection', record);

    try {
      await worker.run('job-1');
      await new Promise(resolve => setImmediate(resolve));  // rejections are reported a tick late
    } finally {
      process.off('unhandledRejection', record);
    }

    assert.deepStrictEqual(unhandled.map(e => e && e.message), []);
    assert.deepStrictEqual(readyPatch(patches).errors,
      [{ documentId: 'd2', name: 'd2.pdf', reason: 'unavailable' }],
      'and the document is still reported when a part finally reaches it');
  });

  await t.test('opens that land after the part died are closed, including the one in hand', async (tt) => {
    config.bulkFetchAhead = 3;
    const docs = [doc('d0'), doc('d1'), doc('d2'), doc('d3')];
    const opened = [];
    const destroyed = [];
    const { patches } = harness(tt, {
      row: job(docs),
      docs,
      // The outage that fails the upload is the outage that makes the opens slow: every one of
      // them is still in flight when the part dies, so none can be closed where it is dropped.
      getObjectStream: async key => {
        opened.push(key);
        await new Promise(resolve => setTimeout(resolve, 30).unref());
        const stream = new PassThrough();
        const destroy = stream.destroy.bind(stream);
        stream.destroy = (...args) => { destroyed.push(key); return destroy(...args); };
        return stream;
      },
      putObjectStream: async () => { throw new Error('403 from the object store'); }
    });
    tt.mock.method(logger, 'error', () => {});

    await assert.rejects(worker.run('job-1'), /403 from the object store/);
    assert.deepStrictEqual(destroyed, [], 'nothing has arrived yet — that is the whole problem');
    await new Promise(resolve => setTimeout(resolve, 60));

    assert.deepStrictEqual(destroyed.sort(), opened.sort(),
      'every socket the window started is closed when it lands, the one taken for this document ' +
      'included — the part is long gone and nothing else can ever close them');
    assert.strictEqual(statusPatch(patches).status, 'failed');
  });

  await t.test('a cancel mid-part destroys the objects opened ahead of it', async (tt) => {
    config.bulkFetchAhead = 3;
    // More than the 20 documents between cancellation checks, so the check inside the part fires.
    const docs = Array.from({ length: 25 }, (_, i) => doc(`d${i}`));
    const row = job(docs);
    // A stream the archive read is destroyed by the pipe itself, so only the ones destroyed
    // UNREAD are the window's — those are the sockets a cancel would otherwise leak.
    const destroyedUnread = [];
    const { zipText } = harness(tt, {
      row,
      docs,
      getObjectStream: async key => {
        const stream = Readable.from([`bytes of ${key}`]);
        const destroy = stream.destroy.bind(stream);
        stream.destroy = (...args) => {
          if (!stream.readableDidRead) destroyedUnread.push(key);
          return destroy(...args);
        };
        return stream;
      }
    });
    let reads = 0;
    tt.mock.method(bulkDownloads, 'getById',
      async () => (reads++ === 0 ? row : { ...row, status: 'cancelled' }));
    tt.mock.method(logger, 'info', () => {});

    assert.strictEqual(await worker.run('job-1'), null);

    assert.doesNotMatch(zipText('zips/job-1-part1.zip'), /d20\.pdf/, 'the cancel stopped at d20');
    assert.deepStrictEqual(destroyedUnread.sort(),
      ['etl/d20.pdf', 'etl/d21.pdf', 'etl/d22.pdf'],
      'every object opened ahead of the cancel is closed, and nothing else is');
  });

  await t.test('a document the manifest no longer returns is dropped and named in errors.txt', async () => {
    const docs = [doc('d1'), doc('d2')];
    const { patches, uploads, zipText } = harness(t, {
      row: job([...docs, doc('d3')]),
      docs
    });

    await worker.run('job-1');

    assert.strictEqual(statusPatch(patches).status, 'ready');
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

  await t.test('documents nobody recorded a size for still pack into one part', async () => {
    // The estimate counts an unknown size as nothing, so the WORKER's own byte counter is the only
    // thing that can close a part here. A packer that gave each one its own part would upload 2,500
    // zips of one file for a selection this size.
    const docs = Array.from({ length: 2500 }, (_, i) => doc(`d${i}`, { fileSize: undefined }));
    const { uploads, patches } = harness(t, {
      row: job(docs),
      docs,
      getObjectStream: async () => Readable.from([Buffer.alloc(1024, 0x41)])
    });

    await worker.run('job-1');

    assert.strictEqual(uploads.size, 1);
    assert.strictEqual(readyPatch(patches).partCount, 1);
    assert.strictEqual(readyPatch(patches).includedCount, 2500);
  });

  await t.test('a part is closed by the bytes actually written, not by the sizes on the rows', async () => {
    config.bulkMaxBytes = 2000;
    // No recorded size at all, so nothing but the counter can say when a part is full.
    const docs = [doc('d1'), doc('d2'), doc('d3')].map(d => ({ ...d, fileSize: undefined }));
    const { uploads, zipText } = harness(t, {
      row: job(docs),
      docs,
      getObjectStream: async () => Readable.from([Buffer.alloc(1500, 0x41)])
    });

    await worker.run('job-1');

    assert.strictEqual(uploads.size, 2, '4.5 KiB of files cannot fit in one 2,000-byte part');
    assert.match(zipText('zips/job-1-part1.zip'), /d2\.pdf/,
      'the part takes the second file, then closes on the bytes it has written');
    assert.match(zipText('zips/job-1-part2.zip'), /d3\.pdf/);
  });

  await t.test('a document bigger than the part cap gets a part to itself', async () => {
    config.bulkMaxBytes = 1000;
    const docs = [doc('d1'), doc('big', { fileSize: 5000 }), doc('d2')];
    const { uploads, zipText } = harness(t, {
      row: job(docs),
      docs,
      getObjectStream: async key => Readable.from([
        Buffer.alloc(key === 'etl/big.pdf' ? 5000 : 10, 0x41)
      ])
    });

    await worker.run('job-1');

    assert.strictEqual(uploads.size, 3);
    assert.match(zipText('zips/job-1-part1.zip'), /d1\.pdf/);
    assert.match(zipText('zips/job-1-part2.zip'), /big\.pdf/,
      'a known size that overflows the part opens a new one rather than blowing the cap');
    assert.doesNotMatch(zipText('zips/job-1-part2.zip'), /d1\.pdf/);
    assert.match(zipText('zips/job-1-part3.zip'), /d2\.pdf/);
  });

  await t.test('status is patched after the parts it names', async () => {
    const docs = [doc('d1')];
    const { patches } = harness(t, { row: job(docs), docs });

    await worker.run('job-1');

    assert.ok(
      patches.findIndex(p => p.status === 'ready') > patches.findIndex(p => p.partCount !== undefined),
      'a poll that reads "ready" before the parts land hands out URLs for objects with no keys'
    );
    assert.ok(statusPatch(patches).finishedAt);
    assert.strictEqual(Object.keys(statusPatch(patches)).length, 2,
      'a poll that reads "ready" before the parts land hands out URLs for objects with no keys');
    assert.ok(Object.keys(readyPatch(patches)).length <= 10,
      'Cosmos refuses a patch over PATCH_MAX_OPERATIONS');
  });

  await t.test('a job from one project is labelled with that project', async (tt) => {
    const docs = [doc('d1'), doc('d2')];
    const { patches } = harness(tt, { row: job(docs), docs });

    await worker.run('job-1');

    assert.strictEqual(readyPatch(patches).label, 'Site C Clean Energy',
      'the label is what names the zip the caller downloads');
  });

  await t.test('a job spanning projects is labelled with how many', async (tt) => {
    const docs = [doc('d1'), doc('d2', { projectId: '311' })];
    const { patches } = harness(tt, { row: job(docs), docs });
    tt.mock.method(projects, 'listByIds',
      async () => [PROJECT, { id: '311', name: 'Coastal GasLink' }]);

    await worker.run('job-1');

    assert.strictEqual(readyPatch(patches).label, '2 projects',
      'no caller wants a zip named after one of the projects it holds');
  });

  await t.test('a project the caller cannot name leaves the label empty', async (tt) => {
    const docs = [doc('d1', { projectId: '999' })];
    const { patches } = harness(tt, { row: job(docs), docs });

    await worker.run('job-1');

    assert.strictEqual(readyPatch(patches).label, '',
      'the status route names an unlabelled job generically rather than after an id');
  });

  await t.test('a job cancelled before the worker dequeued it does no work', async (tt) => {
    const docs = [doc('d1')];
    const { patches, uploads, claims, released } =
      harness(tt, { row: job(docs, { status: 'cancelled' }), docs });

    assert.strictEqual(await worker.run('job-1'), null);

    assert.deepStrictEqual(claims, [], 'a cancelled job is not claimed');
    assert.deepStrictEqual(patches, [], 'cancelled is terminal — nothing writes over it');
    assert.strictEqual(uploads.size, 0);
    assert.deepStrictEqual(released, [], 'whoever cancelled gave the slot back');
  });

  await t.test('a cancel mid-part stops the build and deletes what it wrote', async (tt) => {
    // More than the 20 documents between cancellation checks, so the check inside the part fires.
    const docs = Array.from({ length: 25 }, (_, i) => doc(`d${i}`));
    const row = job(docs);
    const { patches, removed, released, zipText } = harness(tt, { row, docs });
    // The first read is the worker picking the job up; every later one is a cancellation check.
    let reads = 0;
    tt.mock.method(bulkDownloads, 'getById',
      async () => (reads++ === 0 ? row : { ...row, status: 'cancelled' }));
    const infos = [];
    tt.mock.method(logger, 'info', message => infos.push(message));

    assert.strictEqual(await worker.run('job-1'), null, 'a cancel is not a failure to retry');

    assert.match(zipText('zips/job-1-part1.zip'), /d19\.pdf/);
    assert.doesNotMatch(zipText('zips/job-1-part1.zip'), /d20\.pdf/,
      'the build stops at the check, it does not run the selection out');
    assert.deepStrictEqual(removed, ['zips/job-1-part1.zip'],
      'the partial zip is deleted here or nothing ever deletes it — the sweep skips cancelled rows');
    assert.ok(!patches.some(patch => patch.status), 'the row keeps the status the canceller wrote');
    assert.deepStrictEqual(patches[patches.length - 1], { parts: [] },
      'the keys are recorded, then cleared once they are really gone');
    assert.deepStrictEqual(released, [], 'the canceller released the slot already');
    assert.ok(infos.includes('[bulk] job cancelled job-1'));
  });

  await t.test('a part that will not delete stays on the row for the sweep', async (tt) => {
    const docs = [doc('d1')];
    const { patches, released } = harness(tt, { row: job(docs), docs });
    tt.mock.method(bulkDownloads, 'patchIfStatus', async () => false);  // the cancel won the row
    tt.mock.method(storage, 'removeObject', async () => { throw new Error('object store down'); });
    tt.mock.method(logger, 'info', () => {});
    tt.mock.method(logger, 'warn', () => {});

    assert.strictEqual(await worker.run('job-1'), null);

    const parts = patches.filter(patch => patch.parts).map(patch => patch.parts);
    assert.deepStrictEqual(parts[parts.length - 1].map(part => part.key), ['zips/job-1-part1.zip'],
      'a key cleared off the row is a key nothing can ever find again');
    assert.deepStrictEqual(released, []);
  });

  await t.test('a cancel between parts deletes every part built so far', async (tt) => {
    config.bulkMaxBytes = 15;
    const docs = [doc('d1'), doc('d2'), doc('d3')];
    const row = job(docs);
    const { patches, removed } = harness(tt, { row, docs });
    let reads = 0;
    tt.mock.method(bulkDownloads, 'getById',
      async () => (reads++ === 0 ? row : { ...row, status: 'cancelled' }));
    tt.mock.method(logger, 'info', () => {});

    assert.strictEqual(await worker.run('job-1'), null);

    assert.deepStrictEqual(removed, ['zips/job-1-part1.zip'],
      'a cancel must not wait out a whole part-sized zip before anything notices');
    assert.ok(!patches.some(patch => patch.status), 'and must not be overwritten by ready');
  });

  await t.test('a cancel that lands as the last part finishes still wins the row', async (tt) => {
    const docs = [doc('d1')];
    const { patches, removed, released } = harness(tt, { row: job(docs), docs });
    // The conditional patch refuses: the cancel took the row out of `running` first.
    tt.mock.method(bulkDownloads, 'patchIfStatus', async () => false);
    tt.mock.method(logger, 'info', () => {});

    assert.strictEqual(await worker.run('job-1'), null, 'the zip is built but nobody wants it');

    assert.ok(!patches.some(patch => patch.status === 'ready'));
    assert.deepStrictEqual(removed, ['zips/job-1-part1.zip']);
    assert.deepStrictEqual(released, [],
      'the cancel released the slot; a second release frees another of this requester\'s jobs');
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
      parties: ['user-1'],
      access: { authenticated: true, roles: ['idir'], level: 3, credentials: [{ id: 'c1' }, { id: 'c2' }] }
    });
    const { reads } = harness(tt, { row, docs });
    tt.mock.method(credentials, 'listForParty', async () => [{ id: 'c1', end }, { id: 'c3', end }]);

    await worker.run('job-1');

    assert.deepStrictEqual(reads[0].credentials, [{ id: 'c1' }],
      'c2 was revoked after submit; c3 was granted after it and is not part of what was asked for');
  });

  await t.test('a grant held by a group the caller belongs to survives the re-check', async (tt) => {
    const end = new Date(Date.now() + 86400000).toISOString();
    const docs = [doc('d1')];
    const row = job(docs, {
      requesterId: 'user-1',
      // What middleware/credentials.js loaded the request's own grants from: subject, key id, groups.
      parties: ['user-1', 'group-A'],
      access: { authenticated: true, roles: ['idir'], level: 3, credentials: [{ id: 'c1' }] }
    });
    const { reads } = harness(tt, { row, docs });
    tt.mock.method(credentials, 'listForParty',
      async party => (party === 'group-A' ? [{ id: 'c1', end }] : []));

    await worker.run('job-1');

    assert.deepStrictEqual(reads[0].credentials, [{ id: 'c1' }],
      'the grant is on the group, not the subject — re-checking the subject alone drops it and ' +
      'the caller gets a zip missing documents they may see');
  });

  await t.test('a finished job gives its quota slot back once', async (tt) => {
    const docs = [doc('d1')];
    const { released } = harness(tt, { row: job(docs), docs });

    await worker.run('job-1');

    assert.deepStrictEqual(released, ['198.51.100.7']);
  });

  await t.test('a failing job releases its slot once, on the delivery that runs out of retries', async (tt) => {
    const docs = [doc('d1')];
    const { released, patches } = harness(tt, { row: job(docs, { requesterKey: 'ip-1' }), docs });
    tt.mock.method(bulkDownloads, 'listDocumentsByIds', async () => { throw new Error('cosmos down'); });
    tt.mock.method(logger, 'error', () => {});

    for (const attempt of [1, 2]) {
      await assert.rejects(worker.run('job-1', { attempt, maxAttempts: 3 }), /cosmos down/);
    }
    assert.deepStrictEqual(released, [],
      'the job still has a retry coming, so it still needs the slot it is holding');

    await assert.rejects(worker.run('job-1', { attempt: 3, maxAttempts: 3 }), /cosmos down/);

    assert.deepStrictEqual(released, ['ip-1']);
    assert.ok(patches.some(p => p.slotReleasedAt),
      'the row has to carry the release, or a redelivery does it again');
  });

  await t.test('a redelivery after the last attempt does not release the slot twice', async (tt) => {
    const docs = [doc('d1')];
    // The stamp the failing delivery left behind: the counter is per requester, so releasing again
    // hands this requester a free slot one of their other jobs is using.
    const row = job(docs, { requesterKey: 'ip-1', status: 'failed', slotReleasedAt: new Date().toISOString() });
    const { released } = harness(tt, { row, docs });
    tt.mock.method(bulkDownloads, 'listDocumentsByIds', async () => { throw new Error('cosmos down'); });
    tt.mock.method(logger, 'error', () => {});

    await assert.rejects(worker.run('job-1', { attempt: 3, maxAttempts: 3 }), /cosmos down/);

    assert.deepStrictEqual(released, []);
  });

  await t.test('a rejected upload fails the part instead of hanging on it', async (tt) => {
    config.bulkFetchAhead = 3;
    // More than one document, so the window is holding opens when the upload dies: the outage that
    // fails the upload is the outage that makes those opens slow, and waiting them out is the hang.
    const docs = [doc('d1'), doc('d2'), doc('d3'), doc('d4')];
    const { patches } = harness(tt, {
      row: job(docs),
      docs,
      getObjectStream: async key => {
        // Never ends, so the entry await only settles if the upload rejection reaches it.
        if (key === 'etl/d1.pdf') return new PassThrough();
        await new Promise(resolve => setTimeout(resolve, 2000).unref());
        return new PassThrough();
      },
      putObjectStream: async () => { throw new Error('403 from the object store'); }
    });
    tt.mock.method(logger, 'error', () => {});

    const started = Date.now();
    await assert.rejects(worker.run('job-1'), /403 from the object store/);
    assert.ok(Date.now() - started < 500, 'an upload nobody watches parks a Function instance for 30 minutes');
    assert.strictEqual(statusPatch(patches).status, 'failed');
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
    assert.strictEqual(statusPatch(patches).error, 'over the size limit');
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
    const failed = statusPatch(patches);
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
