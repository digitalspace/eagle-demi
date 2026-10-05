'use strict';

/**
 * One-time backup of every stored original from the object store into the Azure archive container.
 *
 *   node src/scripts/backup-originals.js list-bucket --bucket zdspnb --out bucket.jsonl
 *   node src/scripts/backup-originals.js export-rows --out rows.jsonl
 *   node src/scripts/backup-originals.js copy --bucket zdspnb --account <acct>
 *     --bucket-list bucket.jsonl --rows rows.jsonl [--missing-out missing.txt] [--concurrency 8] [--live]
 *   node src/scripts/backup-originals.js verify --env test --account <acct>
 *     --bucket-list bucket.jsonl --rows rows.jsonl [--bucket-missing missing.txt] [--live]
 *   node src/scripts/backup-originals.js drill --account <acct> --drill-list drill.jsonl [--sample 20] [--live]
 *   node src/scripts/backup-originals.js drill --account <acct> --drill-list drill.jsonl --check [--live]
 *
 * **DRY RUN BY DEFAULT**: without `--live` nothing is written to Azure. Each blob name is the
 * s3Key unchanged. A blob is committed straight to Archive, create-only, and only after the bytes
 * read are proven equal to the source; resume is a rerun, because existing names are skipped.
 * Exit codes: 0 clean, 1 any failure or gap, 2 drill still rehydrating.
 */

const crypto = require('crypto');
const fs = require('fs');
const zlib = require('zlib');
const config = require('../config');
const documents = require('../repositories/documents');
const { systemAccess } = require('../helpers/access-sql');
const { createCredential } = require('../utils/azure-credential');
const { logger } = require('../utils/logger');
const { mapLimit } = require('../utils/worker-pool');
const { isNotFound, eachRow, clientFor, readPartition } = require('./backfill-objects');

const TAG = '[backup]';
const BLOCK_SIZE = 16 * 1024 * 1024;
const MAX_ATTEMPTS = 6;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 60000;
const PROGRESS_EVERY = 500;
const MAX_REPORTED = 20;
// Blob metadata is capped at 8 KB in total; the full id list goes in the manifest.
const MAX_DOC_IDS_IN_METADATA = 20;
const SELECT = 'c.id, c.s3Key, c.fileSize, c.read';
// The account name is built into a host name, so only a valid storage account name passes.
const ACCOUNT_NAME = /^[a-z0-9]{3,24}$/;

const SUBCOMMANDS = ['list-bucket', 'export-rows', 'copy', 'verify', 'drill'];
const REQUIRED = {
  'list-bucket': ['bucket', 'out'],
  'export-rows': ['out'],
  copy: ['bucket', 'account', 'bucketList', 'rows'],
  verify: ['env', 'account', 'bucketList', 'rows'],
  drill: ['account', 'drillList']
};
const FLAGS = {
  '--bucket': 'bucket', '--out': 'out', '--account': 'account', '--container': 'container',
  '--manifest-container': 'manifestContainer', '--restore-container': 'restoreContainer',
  '--bucket-list': 'bucketList', '--rows': 'rows', '--bucket-missing': 'bucketMissing',
  '--missing-out': 'missingOut', '--env': 'env', '--drill-list': 'drillList'
};

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!SUBCOMMANDS.includes(command)) {
    throw new Error(`${TAG} first argument must be one of: ${SUBCOMMANDS.join(', ')}`);
  }
  const args = {
    command, live: false, check: false, concurrency: 8, limit: 0, sample: 20,
    container: 'originals', manifestContainer: 'manifests', restoreContainer: 'restore'
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--live') args.live = true;
    else if (a === '--dry-run') args.live = false;
    else if (a === '--check') args.check = true;
    else if (a === '--concurrency') args.concurrency = Number(rest[++i]);
    else if (a === '--limit') args.limit = Number(rest[++i]);
    else if (a === '--sample') args.sample = Number(rest[++i]);
    else if (FLAGS[a]) args[FLAGS[a]] = rest[++i];
    else throw new Error(`${TAG} unknown argument: ${a}`);
  }
  for (const name of REQUIRED[command]) {
    if (!args[name]) throw new Error(`${TAG} ${command} needs --${name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`);
  }
  if (args.account && !ACCOUNT_NAME.test(args.account)) {
    throw new Error(`${TAG} --account is not a storage account name`);
  }
  for (const n of ['concurrency', 'sample']) {
    if (!Number.isInteger(args[n]) || args[n] < 1) throw new Error(`${TAG} --${n} must be 1 or more`);
  }
  if (!Number.isInteger(args.limit) || args.limit < 0) throw new Error(`${TAG} --limit must be 0 or more`);
  return args;
}

/** Strip anything that could carry a credential before it reaches a log line. */
function redact(text) {
  let out = String(text)
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/((?:x-amz-[a-z-]+|signature|sig|credential|token|accesskey|secretkey)=)[^&\s]+/gi, '$1<redacted>');
  for (const secret of [config.minioAccess, config.minioSecret, config.sourceMinioAccess, config.sourceMinioSecret]) {
    if (secret) out = out.split(secret).join('<redacted>');
  }
  return out;
}

const isThrottle = err => Boolean(err) &&
  (err.code === 'SlowDown' || err.code === 'ServerBusy' || err.statusCode === 503);

async function withBackoff(fn, sleep) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isThrottle(err) || attempt >= MAX_ATTEMPTS) throw err;
      const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
      await sleep(delay / 2 + Math.random() * delay / 2);
    }
  }
}

const stripQuotes = etag => String(etag || '').replace(/"/g, '');
// Only a plain single-part ETag is the content MD5; multipart ("-N") and anything else is not.
const isMd5Etag = etag => /^[0-9a-f]{32}$/.test(etag);
const blockId = i => Buffer.from(String(i).padStart(6, '0')).toString('base64');
const md5Hex = bytes => (bytes ? Buffer.from(bytes).toString('hex') : '');

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
}

function writeJsonl(file, rows) {
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

function defaultSource() {
  // The source credential when one is set, otherwise this environment's own bucket credential.
  const client = config.sourceMinioAccess
    ? clientFor(config.sourceMinioHost, config.sourceMinioPort, config.sourceMinioSsl,
      config.sourceMinioAccess, config.sourceMinioSecret)
    : clientFor(config.minioHost, config.minioPort, config.minioSsl, config.minioAccess, config.minioSecret);
  return {
    listObjects: (bucket) => client.listObjectsV2(bucket, '', true),
    statObject: (bucket, key) => client.statObject(bucket, key),
    getObject: (bucket, key) => client.getObject(bucket, key)
  };
}

function defaultContainers(account) {
  const { BlobServiceClient } = require('@azure/storage-blob');
  const service = new BlobServiceClient(`https://${account}.blob.core.windows.net`, createCredential());
  return name => service.getContainerClient(name);
}

async function listBucket(args, deps) {
  const rows = [];
  let bytes = 0;
  for await (const o of deps.source.listObjects(args.bucket)) {
    if (!o.name) continue;
    rows.push({ key: o.name, size: o.size, etag: stripQuotes(o.etag) });
    bytes += o.size;
  }
  writeJsonl(args.out, rows);
  const multipart = rows.filter(r => r.etag.includes('-')).length;
  logger.info(`${TAG} list-bucket bucket=${args.bucket} objects=${rows.length} bytes=${bytes} multipart=${multipart}`);
  return { exitCode: 0, summary: { objects: rows.length, bytes, multipart } };
}

async function exportRows(args, deps) {
  const rows = [];
  // systemAccess(): a scoped read would miss rows and the backup would look complete without them.
  for await (const r of eachRow(deps.documents, deps.readRows, systemAccess(), '')) {
    rows.push({ id: r.id, s3Key: r.s3Key || '', fileSize: r.fileSize ?? null, read: r.read || [] });
  }
  writeJsonl(args.out, rows);
  logger.info(`${TAG} export-rows rows=${rows.length} withKey=${rows.filter(r => r.s3Key).length}`);
  return { exitCode: 0, summary: { rows: rows.length } };
}

/** The union of the bucket listing and the Cosmos keys, so orphan objects are kept too. */
function buildPlan(bucketRows, docRows) {
  const plan = new Map();
  for (const o of bucketRows) plan.set(o.key, { key: o.key, size: o.size, etag: o.etag, documentIds: [] });
  for (const r of docRows) {
    if (!r.s3Key) continue;
    if (!plan.has(r.s3Key)) plan.set(r.s3Key, { key: r.s3Key, size: null, etag: null, documentIds: [] });
    plan.get(r.s3Key).documentIds.push(r.id);
  }
  return plan;
}

function shortIds(ids) {
  if (!ids.length) return 'none';
  const head = ids.slice(0, MAX_DOC_IDS_IN_METADATA).join(',');
  return ids.length > MAX_DOC_IDS_IN_METADATA ? `${head},+${ids.length - MAX_DOC_IDS_IN_METADATA}` : head;
}

async function readSource(ctx, key, stage) {
  const md5 = crypto.createHash('md5');
  const sha256 = crypto.createHash('sha256');
  const blockIds = [];
  let size = 0;
  let pending = [];
  let pendingLen = 0;

  const flush = async () => {
    const block = Buffer.concat(pending, pendingLen);
    pending = [];
    pendingLen = 0;
    const id = blockId(blockIds.length);
    await stage(id, block, { transactionalContentMD5: crypto.createHash('md5').update(block).digest() });
    blockIds.push(id);
  };

  const stream = await ctx.source.getObject(ctx.bucket, key);
  try {
    for await (const chunk of stream) {
      md5.update(chunk);
      sha256.update(chunk);
      size += chunk.length;
      if (!stage) continue;
      for (let off = 0; off < chunk.length;) {
        const take = Math.min(ctx.blockSize - pendingLen, chunk.length - off);
        pending.push(chunk.subarray(off, off + take));
        pendingLen += take;
        off += take;
        if (pendingLen === ctx.blockSize) await flush();
      }
    }
    if (stage && pendingLen) await flush();
  } finally {
    // An abandoned response body holds its source socket open for the rest of the run.
    if (stream && stream.destroy) stream.destroy();
  }
  return { blockIds, size, md5: md5.digest(), sha256: sha256.digest('hex') };
}

class Mismatch extends Error {}

async function copyOne(ctx, entry) {
  const blob = ctx.originals.getBlockBlobClient(entry.key);
  if (await blob.exists()) return { outcome: 'present' };
  if (!ctx.live) return { outcome: 'planned' };

  let stat;
  try {
    stat = await ctx.source.statObject(ctx.bucket, entry.key);
  } catch (err) {
    if (isNotFound(err)) return { outcome: 'missingInSource' };
    throw err;
  }
  const etag = stripQuotes(stat.etag);

  const read = await readSource(ctx, entry.key,
    (id, block, opts) => blob.stageBlock(id, block, block.length, opts));
  if (read.size !== stat.size) throw new Mismatch(`size mismatch: read ${read.size}, source ${stat.size}`);
  if (isMd5Etag(etag)) {
    if (read.md5.toString('hex') !== etag) throw new Mismatch('md5 does not match source ETag');
  } else {
    // A multipart ETag is not the content MD5, so a second read must give the same bytes.
    const second = await readSource(ctx, entry.key, null);
    if (second.size !== read.size || second.sha256 !== read.sha256) {
      throw new Mismatch('sha256 differs between two reads of a multipart object');
    }
  }

  try {
    await blob.commitBlockList(read.blockIds, {
      tier: 'Archive',
      conditions: { ifNoneMatch: '*' },
      blobHTTPHeaders: {
        blobContentMD5: read.md5,
        blobContentType: (stat.metaData && stat.metaData['content-type']) || 'application/octet-stream'
      },
      metadata: {
        sourcebucket: ctx.bucket,
        sourceetag: etag,
        md5: read.md5.toString('hex'),
        sha256: read.sha256,
        size: String(read.size),
        documentids: shortIds(entry.documentIds),
        copiedat: ctx.now().toISOString()
      }
    });
  } catch (err) {
    // Another writer got there between the exists check and the commit; theirs stands.
    if (err.statusCode === 409 || err.statusCode === 412) return { outcome: 'present' };
    throw err;
  }
  return { outcome: 'copied', bytes: read.size };
}

function copySummaryLine(s) {
  return `${TAG} copy mode=${s.mode} total=${s.total} present=${s.present} planned=${s.planned} ` +
    `copied=${s.copied} bytes=${s.bytes} missingInSource=${s.missingInSource} ` +
    `mismatch=${s.mismatch} failed=${s.failed}`;
}

async function copy(args, deps) {
  let entries = [...buildPlan(readJsonl(args.bucketList), readJsonl(args.rows)).values()];
  if (args.limit) entries = entries.slice(0, args.limit);

  const originals = deps.containerFor(args.container);
  if (args.live && !(await originals.exists())) {
    // Never created here: a typo would otherwise become an empty container without retention.
    throw new Error(`${TAG} container ${args.container} not found in account ${args.account}; ` +
      'the backup storage infrastructure must be deployed first');
  }
  const ctx = {
    originals, source: deps.source, bucket: args.bucket, live: args.live,
    blockSize: deps.blockSize || BLOCK_SIZE, now: deps.now
  };
  const summary = {
    mode: args.live ? 'live' : 'dry-run', total: entries.length,
    present: 0, planned: 0, copied: 0, bytes: 0, missingInSource: 0, mismatch: 0, failed: 0, failures: []
  };
  const missing = [];
  let done = 0;

  await mapLimit(entries, args.concurrency, async (entry) => {
    try {
      const { outcome, bytes = 0 } = await withBackoff(() => copyOne(ctx, entry), deps.sleep);
      summary[outcome]++;
      summary.bytes += bytes;
      if (outcome === 'missingInSource') missing.push(entry.key);
    } catch (err) {
      if (err instanceof Mismatch) summary.mismatch++;
      summary.failed++;
      if (summary.failures.length < MAX_REPORTED) summary.failures.push(`${entry.key}: ${redact(err.message)}`);
    }
    if (++done % PROGRESS_EVERY === 0) logger.info(copySummaryLine(summary));
  });

  if (args.live && args.missingOut) fs.writeFileSync(args.missingOut, missing.map(k => `${k}\n`).join(''));
  logger.info(copySummaryLine(summary));
  if (summary.failed) logger.error(`${TAG} first ${summary.failures.length} failures: ${summary.failures.join(' | ')}`);
  return { exitCode: summary.failed ? 1 : 0, summary };
}

async function listBlobs(container) {
  const blobs = new Map();
  for await (const item of container.listBlobsFlat({ includeMetadata: true })) blobs.set(item.name, item);
  return blobs;
}

/** Reconcile the stored blobs against the bucket listing and the Cosmos keys; every gap is named. */
function reconcile(bucketRows, docRows, blobs, listedMissing) {
  const gaps = [];
  const gap = (key, reason) => gaps.push({ key, reason });
  const bucketKeys = new Map(bucketRows.map(o => [o.key, o]));

  let bucketBytes = 0;
  for (const o of bucketRows) {
    bucketBytes += o.size;
    const blob = blobs.get(o.key);
    if (!blob) { gap(o.key, 'missing'); continue; }
    const meta = blob.metadata || {};
    if (blob.properties.contentLength !== o.size) gap(o.key, 'size-mismatch');
    if (isMd5Etag(o.etag) ? meta.md5 !== o.etag : meta.sourceetag !== o.etag) gap(o.key, 'md5-mismatch');
  }

  let blobBytes = 0;
  for (const [name, blob] of blobs) {
    const meta = blob.metadata || {};
    blobBytes += blob.properties.contentLength;
    if (blob.properties.accessTier !== 'Archive') gap(name, 'not-archive');
    if (!meta.sha256) gap(name, 'no-sha256');
    if (!meta.md5 || md5Hex(blob.properties.contentMD5) !== meta.md5) gap(name, 'content-md5');
    if (!bucketKeys.has(name)) gap(name, 'not-in-bucket');
  }
  if (blobs.size !== bucketRows.length) gap(null, 'count');
  if (blobBytes !== bucketBytes) gap(null, 'bytes');

  const cosmosKeys = new Set(docRows.map(r => r.s3Key).filter(Boolean));
  const missingInSource = [];
  let cosmosBacked = 0;
  for (const key of cosmosKeys) {
    if (blobs.has(key)) cosmosBacked++;
    else if (listedMissing.has(key) && !bucketKeys.has(key)) missingInSource.push(key);
    else gap(key, 'cosmos-unbacked');
  }

  return {
    gaps, missingInSource,
    counts: {
      bucket: { objects: bucketRows.length, bytes: bucketBytes },
      blobs: { objects: blobs.size, bytes: blobBytes },
      cosmos: { rows: docRows.length, keys: cosmosKeys.size, backed: cosmosBacked, missingInSource: missingInSource.length }
    }
  };
}

function manifestLines(bucketRows, docRows, blobs, result) {
  const idsByKey = new Map();
  for (const r of docRows) {
    if (!r.s3Key) continue;
    if (!idsByKey.has(r.s3Key)) idsByKey.set(r.s3Key, []);
    idsByKey.get(r.s3Key).push(r.id);
  }
  const reasons = new Map();
  for (const g of result.gaps) {
    if (g.key !== null) reasons.set(g.key, [...(reasons.get(g.key) || []), g.reason]);
  }
  const line = (key, size, etag) => {
    const blob = blobs.get(key);
    const meta = (blob && blob.metadata) || {};
    return {
      key, size, etag: etag ?? meta.sourceetag ?? null, md5: meta.md5 ?? null, sha256: meta.sha256 ?? null,
      documentIds: idsByKey.get(key) || [], copiedAt: meta.copiedat ?? null,
      status: reasons.has(key) ? reasons.get(key).join(',') : 'ok'
    };
  };
  const keys = new Set();
  const lines = [];
  for (const o of bucketRows) { keys.add(o.key); lines.push(line(o.key, o.size, o.etag)); }
  for (const [name, blob] of blobs) {
    if (!keys.has(name)) { keys.add(name); lines.push(line(name, blob.properties.contentLength, null)); }
  }
  for (const key of result.missingInSource) {
    if (!keys.has(key)) { keys.add(key); lines.push({ ...line(key, null, null), status: 'missing-in-source' }); }
  }
  for (const key of idsByKey.keys()) {
    if (!keys.has(key)) lines.push(line(key, null, null));
  }
  return lines;
}

async function verify(args, deps) {
  const bucketRows = readJsonl(args.bucketList);
  const docRows = readJsonl(args.rows);
  const listedMissing = new Set(args.bucketMissing ? readLines(args.bucketMissing) : []);
  const blobs = await listBlobs(deps.containerFor(args.container));
  const result = reconcile(bucketRows, docRows, blobs, listedMissing);

  const runId = deps.now().toISOString().replace(/[:.]/g, '-');
  const manifest = zlib.gzipSync(manifestLines(bucketRows, docRows, blobs, result)
    .map(l => JSON.stringify(l)).join('\n') + '\n');
  const prefix = `${args.env}/${runId}`;
  const byReason = {};
  for (const g of result.gaps) byReason[g.reason] = (byReason[g.reason] || 0) + 1;
  const summary = {
    env: args.env, runId, ...result.counts, gaps: result.gaps.length, gapsByReason: byReason,
    gapKeys: result.gaps.filter(g => g.key !== null).map(g => `${g.key}: ${g.reason}`),
    missingInSource: result.missingInSource,
    manifest: { name: `${prefix}/objects.jsonl.gz`, sha256: crypto.createHash('sha256').update(manifest).digest('hex') }
  };

  if (args.live) {
    const manifests = deps.containerFor(args.manifestContainer);
    const put = (name, body, type) => manifests.getBlockBlobClient(name).upload(body, body.length, {
      conditions: { ifNoneMatch: '*' }, blobHTTPHeaders: { blobContentType: type }
    });
    await put(summary.manifest.name, manifest, 'application/gzip');
    await put(`${prefix}/summary.json`, Buffer.from(JSON.stringify(summary, null, 2)), 'application/json');
  }

  const c = result.counts;
  logger.info(`${TAG} verify mode=${args.live ? 'live' : 'dry-run'} env=${args.env} runId=${runId} ` +
    `bucket=${c.bucket.objects}/${c.bucket.bytes} blobs=${c.blobs.objects}/${c.blobs.bytes} ` +
    `cosmosKeys=${c.cosmos.keys} cosmosBacked=${c.cosmos.backed} missingInSource=${c.cosmos.missingInSource} ` +
    `gaps=${result.gaps.length} ${JSON.stringify(byReason)} manifestSha256=${summary.manifest.sha256}`);
  if (result.gaps.length) logger.error(`${TAG} first gaps: ${summary.gapKeys.slice(0, MAX_REPORTED).join(' | ')}`);
  return { exitCode: result.gaps.length ? 1 : 0, summary };
}

/** Start phase: copy a random sample into `restore` at Cool, which rehydrates it (up to 15 h). */
async function drillStart(args, deps) {
  const originals = deps.containerFor(args.container);
  const restore = deps.containerFor(args.restoreContainer);
  const sample = [];
  let seen = 0;
  // Reservoir sample: one pass over the listing, nothing held but the sample.
  for await (const item of originals.listBlobsFlat({ includeMetadata: true })) {
    seen++;
    const pick = { name: item.name, sha256: (item.metadata || {}).sha256 };
    if (sample.length < args.sample) sample.push(pick);
    else {
      const j = Math.floor(deps.random() * seen);
      if (j < args.sample) sample[j] = pick;
    }
  }
  const runId = deps.now().toISOString().replace(/[:.]/g, '-');
  const entries = sample.map(s => ({ ...s, restoreName: `drill/${runId}/${s.name}` }));
  if (args.live) {
    for (const e of entries) {
      await restore.getBlockBlobClient(e.restoreName).beginCopyFromURL(
        originals.getBlockBlobClient(e.name).url, { tier: 'Cool', rehydratePriority: 'Standard' });
    }
    writeJsonl(args.drillList, entries);
  }
  logger.info(`${TAG} drill start mode=${args.live ? 'live' : 'dry-run'} blobs=${seen} sample=${entries.length}`);
  return { exitCode: 0, summary: { started: args.live ? entries.length : 0, sample: entries.length } };
}

/** Check phase: once each copy lands, compare its sha256 with the metadata, then delete it. */
async function drillCheck(args, deps) {
  const restore = deps.containerFor(args.restoreContainer);
  const summary = { matched: 0, mismatch: 0, pending: 0, failed: 0, failures: [] };
  for (const e of readJsonl(args.drillList)) {
    const blob = restore.getBlockBlobClient(e.restoreName);
    try {
      const props = await blob.getProperties();
      if (props.copyStatus === 'pending') { summary.pending++; continue; }
      if (props.copyStatus !== 'success') throw new Error(`copy ${props.copyStatus}`);
      const body = (await blob.download()).readableStreamBody;
      const hash = crypto.createHash('sha256');
      for await (const chunk of body) hash.update(chunk);
      if (hash.digest('hex') === e.sha256) summary.matched++;
      else { summary.mismatch++; summary.failures.push(`${e.name}: sha256 mismatch`); }
      if (args.live) await blob.delete();
    } catch (err) {
      summary.failed++;
      summary.failures.push(`${e.name}: ${redact(err.message)}`);
    }
  }
  logger.info(`${TAG} drill check mode=${args.live ? 'live' : 'dry-run'} matched=${summary.matched} ` +
    `mismatch=${summary.mismatch} pending=${summary.pending} failed=${summary.failed}`);
  if (summary.failures.length) logger.error(`${TAG} drill failures: ${summary.failures.slice(0, MAX_REPORTED).join(' | ')}`);
  const exitCode = summary.mismatch || summary.failed ? 1 : summary.pending ? 2 : 0;
  return { exitCode, summary };
}

/**
 * @param {string[]} argv
 * @param {object} [deps] test seam: {source, containerFor, documents, readRows, sleep, now, random, blockSize}
 */
async function run(argv, deps = {}) {
  const args = parseArgs(argv);
  const d = {
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => new Date(),
    random: Math.random,
    documents,
    readRows: (access, projectId) => readPartition(access, projectId, SELECT),
    ...deps
  };
  if (!d.source && (args.command === 'list-bucket' || args.command === 'copy')) d.source = defaultSource();
  if (!d.containerFor && args.account) d.containerFor = defaultContainers(args.account);

  if (args.command === 'list-bucket') return listBucket(args, d);
  if (args.command === 'export-rows') return exportRows(args, d);
  if (args.command === 'copy') return copy(args, d);
  if (args.command === 'verify') return verify(args, d);
  return args.check ? drillCheck(args, d) : drillStart(args, d);
}

module.exports = {
  parseArgs, redact, buildPlan, reconcile, run,
  ACCOUNT_NAME, stripQuotes, isMd5Etag, readLines, defaultContainers
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'export-rows') require('../db/cosmos-nosql').initCosmosClient();

  run(argv)
    .then(result => process.exit(result.exitCode))
    .catch(err => {
      logger.error(`${TAG} Fatal`, { error: redact(err.message), stack: redact(err.stack) });
      process.exit(1);
    });
}
