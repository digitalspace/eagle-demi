'use strict';

process.env.NODE_ENV = 'test';
// Set before the script is required: config reads the environment once, at load.
process.env.MINIO_BUCKET_NAME = 'asnpnn';
process.env.MINIO_KEY_PREFIX = 'ozwdez';

const test = require('node:test');
const assert = require('node:assert');

const { parseArgs, backfillObjects, exitCodeFor } =
  require('../../src/scripts/backfill-objects');

const TARGET_BUCKET = 'asnpnn';

const DOCS = [
  { id: 'a', projectId: '1', s3Key: '1/aaa.pdf', datePosted: '2019-06-01T00:00:00Z' },
  { id: 'b', projectId: '1', s3Key: '1/bbb.pdf', datePosted: '2021-06-01T00:00:00Z' },
  { id: 'c', projectId: '2', s3Key: '2/ccc.pdf', datePosted: '2022-06-01T00:00:00Z' },
  { id: 'd', projectId: '2', s3Key: '', datePosted: '2022-07-01T00:00:00Z' }
];

/**
 * Documents repository double, partitioned by `projectId` the way Cosmos is.
 * The partition walk and the per-partition read are separate calls, so a script that skipped a
 * partition — or read one twice — shows up in `state.reads`.
 */
function fakeDocuments(docs = DOCS) {
  const state = { reads: [] };
  const partitions = [...new Set(docs.map(d => String(d.projectId)))];
  return {
    state,
    repo: { async listDistinctProjectIds() { return partitions; } },
    async readRows(access, projectId) {
      state.reads.push(projectId);
      return docs.filter(d => String(d.projectId) === projectId);
    }
  };
}

/**
 * Object-store double. `present` is what the TARGET bucket already holds and `sourceMissing` the
 * keys the source bucket does not, so a wrong prefix or a wrong source path lands on neither list
 * and is visible in the recorded calls.
 */
function fakeStorage({ present = [], sourceMissing = [], delayMs = 0 } = {}) {
  const notFound = () => Object.assign(new Error('Not Found'), { code: 'NotFound' });
  const state = { stats: [], copies: [], inFlight: 0, maxInFlight: 0 };

  const track = async (fn) => {
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    try {
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      return await fn();
    } finally {
      state.inFlight--;
    }
  };

  return {
    state,
    statObject: (bucket, key) => track(async () => {
      state.stats.push([bucket, key]);
      if (!present.includes(key)) throw notFound();
      return { size: 10 };
    }),
    copyObject: (bucket, key, source) => track(async () => {
      state.copies.push([bucket, key, source]);
      if (sourceMissing.some(k => source.endsWith(`/${k}`))) throw notFound();
      return { etag: 'x' };
    })
  };
}

/**
 * The two-credential double: the source client records its own calls, so a stat or a get issued
 * against the target client — or a put aimed at the source bucket — shows up on the wrong list.
 */
function fakeStreamStorage({ present = [], sourceMissing = [] } = {}) {
  const notFound = () => Object.assign(new Error('Not Found'), { code: 'NotFound' });
  const storage = fakeStorage({ present });
  storage.state.puts = [];
  storage.state.sourceStats = [];
  storage.state.sourceGets = [];

  storage.putObject = async (bucket, key, stream, size, meta) => {
    storage.state.puts.push([bucket, key, stream, size, meta]);
    return { etag: 'x' };
  };
  storage.source = {
    statObject: async (bucket, key) => {
      storage.state.sourceStats.push([bucket, key]);
      if (sourceMissing.includes(key)) throw notFound();
      return { size: 42, contentType: 'application/pdf' };
    },
    getObject: async (bucket, key) => {
      storage.state.sourceGets.push([bucket, key]);
      return `stream:${key}`;
    }
  };
  return storage;
}

function run(argv, { docs, storage }) {
  const fake = fakeDocuments(docs);
  return backfillObjects(argv, {
    storage,
    documents: fake.repo,
    readRows: fake.readRows,
    targetBucket: TARGET_BUCKET
  }).then(summary => ({ summary, docsState: fake.state }));
}

test('parseArgs defaults to a dry run against the prod bucket', () => {
  const args = parseArgs([]);
  assert.equal(args.live, false);
  assert.equal(args.sourceBucket, 'ozwdez');
  assert.equal(args.concurrency, 4);
});

test('parseArgs rejects an unknown flag and a bad date', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
  assert.throws(() => parseArgs(['--since', 'never']), /not a date/);
  assert.throws(() => parseArgs(['--concurrency', '0']), /concurrency/);
});

test('dry run copies nothing and counts the gap', async () => {
  const storage = fakeStorage({ present: ['ozwdez/1/aaa.pdf'] });
  const { summary } = await run([], { storage });

  assert.deepEqual(storage.state.copies, []);
  assert.equal(summary.scanned, 4);
  assert.equal(summary.noKey, 1);
  assert.equal(summary.present, 1);
  assert.equal(summary.planned, 2);
  assert.equal(summary.copied, 0);
  assert.equal(exitCodeFor(summary), 0);
});

test('live copies only the missing keys, prefixed target from unprefixed source', async () => {
  const storage = fakeStorage({ present: ['ozwdez/1/aaa.pdf'] });
  const { summary, docsState } = await run(['--live', '--concurrency', '1'], { storage });

  assert.deepEqual(storage.state.copies, [
    [TARGET_BUCKET, 'ozwdez/1/bbb.pdf', '/ozwdez/1/bbb.pdf'],
    [TARGET_BUCKET, 'ozwdez/2/ccc.pdf', '/ozwdez/2/ccc.pdf']
  ]);
  // The target is stat'd under the prefix; nothing is ever stat'd under the bare key.
  assert.ok(storage.state.stats.every(([bucket, key]) =>
    bucket === TARGET_BUCKET && key.startsWith('ozwdez/')));
  assert.equal(summary.copied, 2);
  assert.equal(summary.failed, 0);
  assert.deepEqual(docsState.reads, ['1', '2']);
});

test('--source-bucket names the bucket the copy reads from', async () => {
  const storage = fakeStorage();
  await run(['--live', '--source-bucket', 'otherbucket', '--limit', '1'], { storage });

  assert.deepEqual(storage.state.copies, [
    [TARGET_BUCKET, 'ozwdez/1/aaa.pdf', '/otherbucket/1/aaa.pdf']
  ]);
});

test('a key missing in the source is counted, not failed', async () => {
  const storage = fakeStorage({ sourceMissing: ['1/aaa.pdf', '1/bbb.pdf', '2/ccc.pdf'] });
  const { summary } = await run(['--live'], { storage });

  assert.equal(summary.missingInSource, 3);
  assert.equal(summary.copied, 0);
  assert.equal(summary.failed, 0);
  assert.equal(exitCodeFor(summary), 0);
});

test('a copy error other than NotFound fails the run', async () => {
  const storage = fakeStorage();
  storage.copyObject = async () => { throw new Error('AccessDenied'); };
  const { summary } = await run(['--live'], { storage });

  assert.equal(summary.failed, 3);
  assert.ok(summary.failures[0].includes('AccessDenied'));
  assert.equal(exitCodeFor(summary), 1);
});

test('concurrency bounds the calls in flight', async () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    id: String(i), projectId: '1', s3Key: `1/${i}.pdf`, datePosted: '2022-01-01T00:00:00Z'
  }));

  const bounded = fakeStorage({ delayMs: 2 });
  await run(['--live', '--concurrency', '3'], { docs: many, storage: bounded });
  assert.equal(bounded.state.maxInFlight, 3);

  const serial = fakeStorage({ delayMs: 2 });
  await run(['--live', '--concurrency', '1'], { docs: many, storage: serial });
  assert.equal(serial.state.maxInFlight, 1);
});

test('--since keeps documents posted on or after the date', async () => {
  const docs = [
    ...DOCS,
    { id: 'e', projectId: '3', s3Key: '3/eee.pdf', datePosted: '2020-01-01T00:00:00Z' },
    { id: 'f', projectId: '3', s3Key: '3/fff.pdf', datePosted: '2019-12-31T00:00:00Z' }
  ];
  const storage = fakeStorage();
  const { summary } = await run(['--live', '--since', '2020-01-01'], { docs, storage });

  assert.deepEqual(storage.state.copies.map(([, key]) => key),
    ['ozwdez/1/bbb.pdf', 'ozwdez/2/ccc.pdf', 'ozwdez/3/eee.pdf']);
  assert.equal(summary.scanned, 4);
});

test('--probe reports both buckets and exits on the source outcome', async () => {
  const reachable = fakeStorage({ present: ['1/aaa.pdf'] });
  const { summary } = await run(['--probe'], { storage: reachable });
  assert.deepEqual(reachable.state.stats, [
    ['ozwdez', '1/aaa.pdf'], [TARGET_BUCKET, 'ozwdez/1/aaa.pdf']
  ]);
  assert.match(summary.source, /^ok/);
  assert.equal(exitCodeFor(summary), 0);

  const denied = fakeStorage();
  denied.statObject = async () => { throw new Error('AccessDenied'); };
  const blocked = await run(['--probe'], { storage: denied });
  assert.equal(exitCodeFor(blocked.summary), 1);
});

test('stream mode reads the source with the source client, puts the target key sized and typed',
  async () => {
    const storage = fakeStreamStorage({ present: ['ozwdez/1/aaa.pdf'] });
    const { summary } = await run(['--live', '--concurrency', '1'], { storage });

    // Source side: prod bucket, bare key. Target side: this bucket, prefixed key.
    assert.deepEqual(storage.state.sourceStats,
      [['ozwdez', '1/bbb.pdf'], ['ozwdez', '2/ccc.pdf']]);
    assert.deepEqual(storage.state.sourceGets,
      [['ozwdez', '1/bbb.pdf'], ['ozwdez', '2/ccc.pdf']]);
    assert.deepEqual(storage.state.puts, [
      [TARGET_BUCKET, 'ozwdez/1/bbb.pdf', 'stream:1/bbb.pdf', 42, { 'Content-Type': 'application/pdf' }],
      [TARGET_BUCKET, 'ozwdez/2/ccc.pdf', 'stream:2/ccc.pdf', 42, { 'Content-Type': 'application/pdf' }]
    ]);
    assert.deepEqual(storage.state.copies, []);
    assert.equal(summary.transfer, 'stream');
    assert.equal(summary.copied, 2);
    assert.equal(summary.failed, 0);
  });

test('a key missing in the source bucket is counted in stream mode too', async () => {
  const storage = fakeStreamStorage({ sourceMissing: ['1/aaa.pdf'] });
  const { summary } = await run(['--live'], { storage });

  assert.equal(summary.missingInSource, 1);
  assert.equal(summary.copied, 2);
  assert.equal(exitCodeFor(summary), 0);
});

test('a stream failure counts as failed and the run carries on', async () => {
  const storage = fakeStreamStorage();
  storage.source.getObject = async (bucket, key) => {
    if (key === '1/bbb.pdf') throw new Error('connection reset');
    return `stream:${key}`;
  };
  const { summary } = await run(['--live', '--concurrency', '1'], { storage });

  assert.equal(summary.failed, 1);
  assert.ok(summary.failures[0].includes('ozwdez/1/bbb.pdf: connection reset'));
  // The keys after the failure still transferred.
  assert.deepEqual(storage.state.puts.map(([, key]) => key),
    ['ozwdez/1/aaa.pdf', 'ozwdez/2/ccc.pdf']);
  assert.equal(summary.copied, 2);
  assert.equal(exitCodeFor(summary), 1);
});

test('--probe stats the source with the source client and names the mode', async () => {
  const storage = fakeStreamStorage();
  const { summary } = await run(['--probe'], { storage });

  assert.deepEqual(storage.state.sourceStats, [['ozwdez', '1/aaa.pdf']]);
  assert.deepEqual(storage.state.stats, [[TARGET_BUCKET, 'ozwdez/1/aaa.pdf']]);
  assert.equal(summary.transfer, 'stream');
  assert.match(summary.source, /^ok size=42/);
  assert.equal(exitCodeFor(summary), 0);
});

test('the copy mode still reports itself as copy', async () => {
  const { summary } = await run([], { storage: fakeStorage() });
  assert.equal(summary.transfer, 'copy');
});
