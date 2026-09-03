'use strict';

/**
 * Copy the document objects this environment's bucket is missing out of the prod bucket.
 *
 * WHY. The non-prod bucket (`MINIO_BUCKET_NAME`, keys nested under `MINIO_KEY_PREFIX`) holds a copy
 * of prod taken before ~2020-05, so roughly 8,500 documents posted after that date point at a key
 * that 404s — the row lists and downloads, the download 404s. Every `s3Key` still exists in the
 * prod bucket `ozwdez` on the same NRS host under the identical key with NO prefix, so the fix is a
 * server-side copy per missing key: `copyObject` moves the bytes inside the object store, and
 * nothing streams through the machine running this.
 *
 *   node src/scripts/backfill-objects.js --probe
 *   node src/scripts/backfill-objects.js --since 2020-01-01 --live
 *     [--source-bucket ozwdez] [--concurrency 4] [--limit N]
 *
 * `--probe` stats one document's key in both buckets with the configured credentials and exits: it
 * answers "can these credentials read prod at all" before a run is worth starting.
 *
 * **DRY RUN BY DEFAULT**, matching the sibling scripts; a dry run counts the gap and writes nothing.
 * Resumable by nature: every key is stat'd in the target before it is copied, so a killed run
 * re-runs as a no-op over whatever already landed.
 *
 * Cosmos and the object store are both private, so a live run executes on the devbox via
 * `demi-run`, detached with a log file — see the wiki, "Backfill missing objects on test".
 */

const Minio = require('minio');
const config = require('../config');
const documents = require('../repositories/documents');
const { selectWhere, fetchAll } = require('../repositories/_sql');
const { systemAccess } = require('../helpers/access-sql');
const { resolveObjectKey } = require('../storage/objectKey');
const { logger } = require('../utils/logger');
const { mapLimit } = require('../utils/worker-pool');

// Only the fields the decision needs; the rest of a document row is ~1 KB of RU per row wasted.
const SELECT = 'c.id, c.s3Key, c.datePosted, c.fileSize';

// Same part size as src/storage/minio.js: without a hint the SDK buffers 528 MiB parts.
const UPLOAD_PART_SIZE = 64 * 1024 * 1024;

const PROGRESS_EVERY = 200;
const MAX_REPORTED_FAILURES = 20;

const DEFAULTS = {
  sourceBucket: 'ozwdez', concurrency: 4, limit: 0, since: '', live: false, probe: false
};

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--dry-run') args.live = false;
    else if (a === '--probe') args.probe = true;
    else if (a === '--source-bucket') args.sourceBucket = argv[++i];
    else if (a === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--since') args.since = argv[++i];
    else throw new Error(`[object-backfill] unknown argument: ${a}`);
  }

  if (!args.sourceBucket) throw new Error('[object-backfill] --source-bucket needs a value');
  if (!Number.isFinite(args.concurrency) || args.concurrency < 1) {
    throw new Error('[object-backfill] --concurrency must be 1 or more');
  }
  if (!Number.isFinite(args.limit) || args.limit < 0) {
    throw new Error('[object-backfill] --limit must be 0 or more');
  }
  if (args.since && Number.isNaN(Date.parse(args.since))) {
    throw new Error(`[object-backfill] --since is not a date: ${args.since}`);
  }
  return args;
}

/** A key that is not there, however this SDK spells it on stat versus copy. */
function isNotFound(err) {
  return Boolean(err) &&
    (err.code === 'NotFound' || err.code === 'NoSuchKey' || err.statusCode === 404);
}

function defaultStorage() {
  // src/storage/minio.js keeps its client private and pins one bucket; this copy spans two.
  const client = new Minio.Client({
    endPoint: config.minioHost,
    port: config.minioPort,
    useSSL: config.minioSsl,
    accessKey: config.minioAccess,
    secretKey: config.minioSecret,
    region: config.minioRegion,
    partSize: UPLOAD_PART_SIZE
  });
  return {
    statObject: (bucket, key) => client.statObject(bucket, key),
    copyObject: (bucket, key, source) => client.copyObject(bucket, key, source)
  };
}

/** One partition's rows, projected. Single-partition, so the read is bounded and pages reliably. */
async function readPartition(access, projectId) {
  const spec = selectWhere({
    access,
    partitionField: documents.PARTITION_FIELD,
    select: SELECT
  });
  return fetchAll(documents.CONTAINER, spec, { partitionKey: String(projectId ?? '') });
}

/**
 * Every document row, partition by partition.
 *
 * Per-partition, NOT one cross-partition paged read: the SDK drops `x-ms-continuation` on a
 * cross-partition query, so a paging loop there stops silently at 1,000 rows (see
 * backfill-display-name-sort.js). Concurrent `next()` calls are queued by the runtime, so the
 * worker pool can share one iterator.
 */
async function* eachRow(documentsRepo, readRows, access, since) {
  const sinceMs = since ? Date.parse(since) : null;
  for (const partition of await documentsRepo.listDistinctProjectIds(access)) {
    for (const row of await readRows(access, String(partition ?? ''))) {
      // No datePosted cannot be proven on or after the date, so --since excludes it.
      if (sinceMs !== null && !(row.datePosted && Date.parse(row.datePosted) >= sinceMs)) continue;
      yield row;
    }
  }
}

function summaryLine(s) {
  return `[object-backfill] mode=${s.mode} scanned=${s.scanned} noKey=${s.noKey} ` +
    `present=${s.present} planned=${s.planned} copied=${s.copied} ` +
    `missingInSource=${s.missingInSource} failed=${s.failed}`;
}

/**
 * Stat one document's key in both buckets and say what happened.
 * Source reachable is the answer being sought, so only that decides the exit code.
 */
async function probeOne(args, storage, documentsRepo, readRows, access, targetBucket) {
  const summary = { mode: 'probe', failed: 0, key: null, source: 'no document to probe', target: '-' };

  for await (const row of eachRow(documentsRepo, readRows, access, args.since)) {
    if (!row.s3Key) continue;
    summary.key = row.s3Key;
    summary.source = await statOutcome(storage, args.sourceBucket, row.s3Key);
    summary.target = await statOutcome(storage, targetBucket, resolveObjectKey(row.s3Key));
    break;
  }

  summary.failed = summary.source.startsWith('ok') ? 0 : 1;
  logger.info(`[object-backfill] probe key=${summary.key} ` +
    `source=${args.sourceBucket} -> ${summary.source} ` +
    `target=${targetBucket} -> ${summary.target}`);
  return summary;
}

async function statOutcome(storage, bucket, key) {
  try {
    const stat = await storage.statObject(bucket, key);
    return `ok size=${stat && stat.size}`;
  } catch (err) {
    return isNotFound(err) ? 'missing' : `error: ${err.message}`;
  }
}

/**
 * @param {string[]} argv
 * @param {object} [deps] test seam: {storage, documents, readRows, targetBucket}
 */
async function backfillObjects(argv = [], deps = {}) {
  const args = parseArgs(argv);
  const storage = deps.storage || defaultStorage();
  const documentsRepo = deps.documents || documents;
  const readRows = deps.readRows || readPartition;
  const targetBucket = deps.targetBucket || config.minioBucket;

  // systemAccess(), because a scoped context lists only the rows it can see and would leave the
  // rest of the corpus un-backfilled while reporting success.
  const access = systemAccess();

  if (args.probe) {
    return probeOne(args, storage, documentsRepo, readRows, access, targetBucket);
  }

  const summary = {
    mode: args.live ? 'live' : 'dry-run',
    scanned: 0, noKey: 0, present: 0, planned: 0, copied: 0, missingInSource: 0, failed: 0,
    failures: []
  };

  const fail = (key, message) => {
    summary.failed++;
    if (summary.failures.length < MAX_REPORTED_FAILURES) summary.failures.push(`${key}: ${message}`);
  };

  const handle = async (row) => {
    if (args.limit && summary.scanned >= args.limit) return;
    summary.scanned++;
    if (summary.scanned % PROGRESS_EVERY === 0) logger.info(summaryLine(summary));

    if (!row.s3Key) { summary.noKey++; return; }

    const targetKey = resolveObjectKey(row.s3Key);
    try {
      await storage.statObject(targetBucket, targetKey);
      summary.present++;
      return;
    } catch (err) {
      if (!isNotFound(err)) { fail(targetKey, err.message); return; }
    }

    summary.planned++;
    if (!args.live) return;

    try {
      // The source key carries NO prefix: prod's bucket is what the recorded s3Key is relative to.
      await storage.copyObject(targetBucket, targetKey, `/${args.sourceBucket}/${row.s3Key}`);
      summary.copied++;
    } catch (err) {
      if (isNotFound(err)) summary.missingInSource++;
      else fail(targetKey, err.message);
    }
  };

  await mapLimit(eachRow(documentsRepo, readRows, access, args.since), args.concurrency, handle);

  logger.info(summaryLine(summary));
  if (summary.failed) {
    logger.error(`[object-backfill] first ${summary.failures.length} failures: ` +
      summary.failures.join(' | '));
  }
  return summary;
}

function exitCodeFor(summary) {
  return summary.failed > 0 ? 1 : 0;
}

module.exports = {
  parseArgs, isNotFound, eachRow, summaryLine, backfillObjects, exitCodeFor
};

if (require.main === module) {
  const { initCosmosClient } = require('../db/cosmos-nosql');
  initCosmosClient();

  backfillObjects(process.argv.slice(2))
    .then(summary => process.exit(exitCodeFor(summary)))
    .catch(err => {
      logger.error('[object-backfill] Fatal', { error: err.message, stack: err.stack });
      process.exit(1);
    });
}
