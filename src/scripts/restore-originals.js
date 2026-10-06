'use strict';

/**
 * Put stored documents back to the copies held in the Azure archive backup. Break-glass only.
 *
 *   node src/scripts/restore-originals.js plan      <selection> --manifest objects.jsonl.gz [--out ids.txt]
 *   node src/scripts/restore-originals.js rehydrate <selection> --manifest <file> --account <acct> [--live]
 *   node src/scripts/restore-originals.js status    <selection> --manifest <file> --account <acct>
 *   node src/scripts/restore-originals.js apply     <selection> --manifest <file> --account <acct>
 *     [--live --confirm <rows>]
 *
 * <selection> is exactly one of `--id <docId>`, `--ids <file>`, `--project <projectId>`,
 * `--all-changed`. Every mode takes `--max <n>` and `--concurrency <n>`.
 * Set `BACKUP_CLIENT_ID` to reach blob storage as that identity; Cosmos stays on `AZURE_CLIENT_ID`.
 *
 * **DRY RUN BY DEFAULT**: without `--live` nothing is written. A row is one bucket key with the
 * selected documents that store it. `rehydrate` copies the archived blob into `restore` at Cool
 * (up to 15 hours); `apply` checks those bytes against the verify manifest, writes them back with
 * If-Match on the ETag seen at plan time and a signed Content-MD5, reads them back, and only then
 * marks each document's `pdfTitle` record `restored`. Nothing in the bucket is deleted; the
 * replaced object stays as an older version.
 * Exit codes: 0 clean, 1 any row refused, changed or failed, 2 rows still rehydrating.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { Transform, Writable } = require('stream');
const config = require('../config');
const documents = require('../repositories/documents');
const { systemAccess } = require('../helpers/access-sql');
const { logger } = require('../utils/logger');
const { mapLimit } = require('../utils/worker-pool');
const { eachRow, readPartition } = require('./backfill-objects');
const {
  ACCOUNT_NAME, redact, stripQuotes, isMd5Etag, readLines, defaultContainers, rehydrationState
} = require('./backup-originals');

const TAG = '[restore]';
const SELECT = 'c.id, c.projectId, c.s3Key, c.pdfTitle';
const MODES = ['plan', 'rehydrate', 'status', 'apply'];
const SELECTORS = ['id', 'ids', 'project', 'allChanged'];
// Statuses that say the stored file is not the original; anything else already agrees with it.
const STALE_STATUSES = new Set(['titled', 'needs-review']);
// Mirrors the source container, so a name here never collides with the drill's `drill/<runId>/`.
const REHYDRATED_PREFIX = 'originals/';
const UPLOAD_SECONDS = 300;
const MAX_REPORTED = 20;

const FLAGS = {
  '--id': 'id', '--ids': 'ids', '--project': 'project', '--manifest': 'manifest',
  '--account': 'account', '--container': 'container', '--restore-container': 'restoreContainer',
  '--out': 'out'
};
const NUMBERS = { '--max': 'max', '--confirm': 'confirm', '--concurrency': 'concurrency' };

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (!MODES.includes(mode)) throw new Error(`${TAG} first argument must be one of: ${MODES.join(', ')}`);
  const args = {
    mode, live: false, allChanged: false, max: 0, confirm: null, concurrency: 8,
    container: 'originals', restoreContainer: 'restore'
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--live') args.live = true;
    else if (a === '--dry-run') args.live = false;
    else if (a === '--all-changed') args.allChanged = true;
    else if (NUMBERS[a]) args[NUMBERS[a]] = Number(rest[++i]);
    else if (FLAGS[a]) args[FLAGS[a]] = rest[++i];
    else throw new Error(`${TAG} unknown argument: ${a}`);
  }
  if (SELECTORS.filter(s => args[s]).length !== 1) {
    throw new Error(`${TAG} give exactly one of --id, --ids, --project, --all-changed`);
  }
  if (!args.manifest) throw new Error(`${TAG} ${mode} needs --manifest`);
  if (mode !== 'plan' && !args.account) throw new Error(`${TAG} ${mode} needs --account`);
  if (args.account && !ACCOUNT_NAME.test(args.account)) throw new Error(`${TAG} --account is not a storage account name`);
  if (!Number.isInteger(args.max) || args.max < 0) throw new Error(`${TAG} --max must be 0 or more`);
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) throw new Error(`${TAG} --concurrency must be 1 or more`);
  if (args.confirm !== null && (!Number.isInteger(args.confirm) || args.confirm < 0)) {
    throw new Error(`${TAG} --confirm must be a row count`);
  }
  return args;
}

/** The verify manifest by key, and the sha256 of the file read, to set against summary.json. */
function readManifest(file) {
  const raw = fs.readFileSync(file);
  const text = (raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw).toString('utf8');
  const entries = new Map();
  for (const line of text.split('\n').filter(Boolean)) {
    const e = JSON.parse(line);
    entries.set(e.key, e);
  }
  return { entries, sha256: crypto.createHash('sha256').update(raw).digest('hex') };
}

async function selectDocs(args, d) {
  if (args.allChanged) {
    const rows = [];
    for await (const r of eachRow(d.documents, d.readRows, systemAccess(), '')) rows.push(r);
    return { docs: rows, notFound: [] };
  }
  if (args.project) return { docs: await d.readRows(systemAccess(), args.project), notFound: [] };
  const ids = args.id ? [args.id] : readLines(args.ids);
  const docs = [];
  const notFound = [];
  for (const id of ids) {
    const doc = await d.documents.readForWrite(id);
    if (doc) docs.push(doc);
    else notFound.push(id);
  }
  return { docs, notFound };
}

/** One row per bucket key, carrying every selected document that stores it. */
function groupByKey(docs) {
  const rows = new Map();
  for (const doc of docs) {
    if (!doc.s3Key) continue;
    if (!rows.has(doc.s3Key)) rows.set(doc.s3Key, { key: doc.s3Key, docs: [] });
    rows.get(doc.s3Key).docs.push(doc);
  }
  return [...rows.values()];
}

/** Why the bucket object differs from its backup, or null when it is the backed-up bytes. */
function difference(stat, entry) {
  if (stat.size !== entry.size) return 'size-differs';
  const etag = stripQuotes(stat.etag).toLowerCase();
  if (isMd5Etag(etag)) return etag === entry.md5 ? null : 'md5-differs';
  // A multipart ETag is not the content MD5: only the ETag recorded at backup time proves a match.
  return etag === stripQuotes(entry.etag).toLowerCase() ? null : 'etag-differs';
}

/** What the restore does to one document's record: `none`, `update`, or `blocked:<reason>`. */
function recordAction(doc, entry) {
  const r = doc.pdfTitle;
  if (!r || typeof r !== 'object' || r.sourceKey !== doc.s3Key) return 'none';
  if (r.lease) return 'blocked:lease-held';
  if (r.inFlight) return 'blocked:in-flight';
  // A later title must find the restored bytes recorded as the original, or it ends in needs-review.
  if (r.originalSha256 && (r.originalSha256 !== entry.sha256 || r.originalLength !== entry.size)) {
    return 'blocked:record-original-differs';
  }
  return STALE_STATUSES.has(r.status) ? 'update' : 'none';
}

/** Decide a row from the manifest, the bucket and the records. Reads only. */
async function assess(row, ctx) {
  const entry = ctx.manifest.get(row.key);
  if (!entry) return { decision: 'refused', reason: 'no-backup' };
  if (entry.status !== 'ok' || !entry.md5 || !entry.sha256 || !Number.isInteger(entry.size)) {
    return { decision: 'refused', reason: `backup-not-verified:${entry.status}` };
  }
  row.entry = entry;
  const stat = await ctx.storage.statObject(row.key);
  // Without an ETag there is nothing to make the write conditional on.
  if (!stat || !stat.etag) return { decision: 'refused', reason: 'missing-in-bucket' };
  row.etag = stripQuotes(stat.etag);
  const why = difference(stat, entry);
  const actions = row.docs.map(doc => recordAction(doc, entry));
  const blocked = actions.find(a => a.startsWith('blocked:'));
  // The object already is the original, so a lease on it is the title job's business, not ours.
  if (blocked && !why) return { decision: 'unchanged' };
  if (blocked) return { decision: 'refused', reason: blocked.slice('blocked:'.length) };
  row.recordUpdates = actions.filter(a => a === 'update').length;
  if (why) return { decision: 'restore', reason: why };
  return row.recordUpdates ? { decision: 'record-only', reason: 'object-matches-record-stale' } : { decision: 'unchanged' };
}

/** Bytes, MD5 and sha256 of a stream, copied into `file` when one is given. */
async function digest(stream, file) {
  const md5 = crypto.createHash('md5');
  const sha256 = crypto.createHash('sha256');
  let size = 0;
  const tap = new Transform({
    transform(chunk, _enc, cb) { md5.update(chunk); sha256.update(chunk); size += chunk.length; cb(null, chunk); }
  });
  const sink = file ? fs.createWriteStream(file) : new Writable({ write(_c, _e, cb) { cb(); } });
  await pipeline(stream, tap, sink);
  return { size, md5: md5.digest('hex'), sha256: sha256.digest('hex') };
}

const sameBytes = (got, entry) => got.size === entry.size && got.md5 === entry.md5 && got.sha256 === entry.sha256;

/** PUT a file to a signed URL; resolves the status code. Content-Length is set, never chunked. */
function putFile(url, file, headers) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request(target, { method: 'PUT', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    fs.createReadStream(file).on('error', reject).pipe(req);
  });
}

function defaultPatch(doc, operations) {
  const cosmos = require('../db/cosmos-nosql');
  const partition = doc.projectId === null || doc.projectId === undefined ? null : String(doc.projectId);
  return cosmos.patch(documents.CONTAINER, String(doc.id), partition, operations, undefined, doc._etag);
}

/** Mark each stale record restored, guarded by the row's `_etag`. Only fields a restore owns move. */
async function updateRecords(row, ctx) {
  let updated = 0;
  for (const doc of await readDocsFresh(row, ctx)) {
    if (!doc || recordAction(doc, row.entry) !== 'update') continue;
    await ctx.patch(doc, [
      { op: 'set', path: '/pdfTitle/status', value: 'restored' },
      { op: 'set', path: '/pdfTitle/reason', value: 'archive-restore' },
      { op: 'set', path: '/pdfTitle/title', value: null },
      { op: 'set', path: '/pdfTitle/titledLength', value: null },
      { op: 'set', path: '/pdfTitle/titledSha256', value: null },
      { op: 'set', path: '/pdfTitle/at', value: ctx.now().toISOString() }
    ]);
    updated++;
  }
  return updated;
}

async function readDocsFresh(row, ctx) {
  return Promise.all(row.docs.map(doc => ctx.documents.readForWrite(doc.id, doc.projectId)));
}

/** Copy state of a row's rehydrated blob: `absent`, `pending`, `ready` or `failed`. */
async function copyState(row, ctx) {
  try {
    const props = await ctx.restore.getBlockBlobClient(REHYDRATED_PREFIX + row.key).getProperties();
    row.contentType = props.contentType;
    return rehydrationState(props);
  } catch (err) {
    if (err.statusCode === 404) return 'absent';
    throw err;
  }
}

async function rehydrateOne(row, ctx) {
  const state = await copyState(row, ctx);
  if (state === 'pending' || state === 'ready') return { outcome: state };
  if (!ctx.live) return { outcome: 'planned', reason: state === 'failed' ? 'restart-failed-copy' : null };
  // Never a tier change in place: that would make the original readable to the API's reader role.
  await ctx.restore.getBlockBlobClient(REHYDRATED_PREFIX + row.key).beginCopyFromURL(
    ctx.originals.getBlockBlobClient(row.key).url, { tier: 'Cool', rehydratePriority: 'Standard' });
  return { outcome: 'started', reason: state === 'failed' ? 'restarted-failed-copy' : null };
}

async function writeOne(row, ctx) {
  const file = path.join(ctx.tmpDir, 'object');
  try {
    const blob = ctx.restore.getBlockBlobClient(REHYDRATED_PREFIX + row.key);
    const got = await digest((await blob.download()).readableStreamBody, file);
    if (!sameBytes(got, row.entry)) return { outcome: 'refused', reason: 'backup-hash-mismatch' };

    // A lease taken since the plan means a title job is on this file now.
    const blocked = (await readDocsFresh(row, ctx)).map(doc => doc && recordAction(doc, row.entry))
      .find(a => a && a.startsWith('blocked:'));
    if (blocked) return { outcome: 'refused', reason: blocked.slice('blocked:'.length) };

    const contentMd5 = Buffer.from(got.md5, 'hex').toString('base64');
    const url = await ctx.storage.getUploadUrl(row.key, { expirySeconds: UPLOAD_SECONDS, contentMd5 });
    const status = await ctx.put(url, file, {
      'Content-Length': String(got.size),
      'Content-MD5': contentMd5,
      'Content-Type': row.contentType || 'application/octet-stream',
      'If-Match': `"${row.etag}"`
    });
    if (status === 412) return { outcome: 'changed', reason: 'object changed since plan' };
    if (status < 200 || status >= 300) throw new Error(`PUT returned ${status}`);

    const back = await digest(await ctx.storage.getObjectStream(row.key));
    if (!sameBytes(back, row.entry)) return { outcome: 'failed', reason: 'read-back-mismatch' };
    return { outcome: 'restored', records: await updateRecords(row, ctx) };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function logRow(mode, row, outcome, reason) {
  const ids = row.docs.map(d => d.id).join(',');
  const extra = reason ? ` reason=${reason}` : '';
  const line = `${TAG} ${mode} key=${row.key} docs=${ids} outcome=${outcome}${extra}`;
  if (['refused', 'changed', 'failed'].includes(outcome)) logger.warn(line);
  else logger.info(line);
}

function exitCodeFor(counts, mode) {
  if (counts.refused || counts.changed || counts.failed || counts.notFound) return 1;
  const waiting = mode === 'apply' || mode === 'status';
  return waiting && (counts.pending || counts.absent) ? 2 : 0;
}

/** The rows a mode acts on, after --max; the rest are counted as deferred. */
function capped(rows, max) {
  return max ? { take: rows.slice(0, max), deferred: rows.length - Math.min(rows.length, max) } : { take: rows, deferred: 0 };
}

async function run(argv, deps = {}) {
  const args = parseArgs(argv);
  const d = {
    documents,
    readRows: (access, projectId) => readPartition(access, projectId, SELECT),
    put: putFile,
    patch: defaultPatch,
    now: () => new Date(),
    ...deps
  };
  if (!d.storage) {
    // Blob names are the recorded s3Key, so a backend that prefixes or moves keys would miss them.
    if (config.storageBackend !== 'minio' || config.minioKeyPrefix) {
      throw new Error(`${TAG} needs STORAGE_BACKEND=minio and an empty MINIO_KEY_PREFIX`);
    }
    d.storage = require('../storage');
  }
  if (!d.containerFor && args.account) d.containerFor = defaultContainers(args.account);

  const manifest = readManifest(args.manifest);
  logger.info(`${TAG} ${args.mode} mode=${args.live ? 'live' : 'dry-run'} manifest entries=${manifest.entries.size} ` +
    `sha256=${manifest.sha256}`);
  const { docs, notFound } = await selectDocs(args, d);
  for (const id of notFound) logger.warn(`${TAG} ${args.mode} doc=${id} outcome=failed reason=not-found`);

  const ctx = {
    ...d, live: args.live, manifest: manifest.entries,
    originals: d.containerFor && d.containerFor(args.container),
    restore: d.containerFor && d.containerFor(args.restoreContainer)
  };
  const counts = { selectedDocs: docs.length, notFound: notFound.length, unchanged: 0, deferred: 0 };
  const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
  const failures = [];
  const settle = (row, outcome, reason) => {
    bump(outcome);
    logRow(args.mode, row, outcome, reason);
    if (['refused', 'changed', 'failed'].includes(outcome) && failures.length < MAX_REPORTED) {
      failures.push(`${row.key}: ${reason}`);
    }
  };

  const rows = groupByKey(docs);
  await mapLimit(rows, args.concurrency, async (row) => {
    try {
      Object.assign(row, await assess(row, ctx));
    } catch (err) {
      Object.assign(row, { decision: 'failed', reason: redact(err.message) });
    }
  });
  const work = [];
  for (const row of rows) {
    if (row.decision === 'unchanged') {
      // --all-changed means only the changed rows are the selection.
      if (args.allChanged) counts.unchanged++;
      else settle(row, 'unchanged');
    } else if (row.decision === 'refused' || row.decision === 'failed') settle(row, row.decision, row.reason);
    else work.push(row);
  }

  if (args.mode === 'plan') {
    const { take, deferred } = capped(work, args.max);
    counts.deferred = deferred;
    for (const row of take) settle(row, row.decision, `${row.reason} records=${row.recordUpdates}`);
    if (args.out) fs.writeFileSync(args.out, take.flatMap(r => r.docs.map(doc => `${doc.id}\n`)).join(''));
  } else if (args.mode === 'rehydrate' || args.mode === 'status') {
    const { take, deferred } = capped(work.filter(r => r.decision === 'restore'), args.max);
    counts.deferred = deferred;
    await mapLimit(take, args.concurrency, async (row) => {
      try {
        if (args.mode === 'status') settle(row, await copyState(row, ctx));
        else {
          const { outcome, reason } = await rehydrateOne(row, ctx);
          settle(row, outcome, reason);
        }
      } catch (err) {
        settle(row, 'failed', redact(err.message));
      }
    });
  } else {
    await mapLimit(work, args.concurrency, async (row) => {
      try {
        row.copy = row.decision === 'restore' ? await copyState(row, ctx) : null;
      } catch (err) {
        row.copy = 'error';
        row.reason = redact(err.message);
      }
    });
    const ready = [];
    for (const row of work) {
      if (row.copy === 'error') settle(row, 'failed', row.reason);
      else if (row.copy === 'failed') settle(row, 'refused', 'rehydrate-copy-failed');
      else if (row.copy === 'absent' || row.copy === 'pending') settle(row, 'pending', `rehydrate ${row.copy}`);
      else ready.push(row);
    }
    const { take, deferred } = capped(ready, args.max);
    counts.deferred = deferred;
    if (!args.live) {
      for (const row of take) settle(row, 'planned', row.decision === 'restore' ? row.reason : row.decision);
      logger.info(`${TAG} apply dry-run would write ${take.length} rows; rerun with --live --confirm ${take.length}`);
    } else if (args.confirm !== take.length) {
      logger.error(`${TAG} apply refused: --confirm ${args.confirm ?? 'missing'} but ${take.length} rows would be written`);
      return { exitCode: 1, summary: { ...counts, writes: take.length, refusedConfirm: true } };
    } else {
      ctx.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-originals-'));
      try {
        for (const row of take) {
          try {
            if (row.decision === 'record-only') settle(row, 'restored', `records=${await updateRecords(row, ctx)}`);
            else {
              const { outcome, reason, records } = await writeOne(row, ctx);
              settle(row, outcome, reason || `records=${records}`);
            }
          } catch (err) {
            settle(row, 'failed', redact(err.message));
          }
        }
      } finally {
        fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
      }
    }
  }

  const { selectedDocs, ...rest } = counts;
  logger.info(`${TAG} ${args.mode} summary docs=${selectedDocs} rows=${rows.length} ` +
    Object.entries(rest).map(([k, v]) => `${k}=${v}`).join(' '));
  if (failures.length) logger.error(`${TAG} first problems: ${failures.join(' | ')}`);
  return { exitCode: exitCodeFor(counts, args.mode), summary: counts };
}

module.exports = { parseArgs, difference, recordAction, run };

if (require.main === module) {
  require('../db/cosmos-nosql').initCosmosClient();
  run(process.argv.slice(2))
    .then(result => process.exit(result.exitCode))
    .catch(err => {
      logger.error(`${TAG} Fatal`, { error: redact(err.message), stack: redact(err.stack) });
      process.exit(1);
    });
}
