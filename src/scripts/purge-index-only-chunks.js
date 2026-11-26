'use strict';

/**
 * Delete `chunks` index rows whose chunk id has no Cosmos row. Dry run unless `--live`; runs on the
 * devbox. Flags and audit file: README, `db:purge-index-only-chunks`.
 */
const fs = require('fs');
const path = require('path');

const documents = require('../repositories/documents');
const chunks = require('../repositories/chunks');
const aiSearch = require('../search/ai-search');
const { systemAccess } = require('../helpers/access-sql');
const { quote } = require('../helpers/access-odata');
const { mapLimit } = require('../utils/worker-pool');
const { logger } = require('../utils/logger');
const {
  loadState, saveState, partitionsFor, NULL_PARTITION
} = require('./backfill-chunk-parent-fields');

const USAGE = 'usage: purge-index-only-chunks.js [--live --max-delete N] [--project ID] ' +
  '[--state FILE] [--max-minutes M] [--audit FILE]';

// Kept low: the serverless account is shared with the live API.
const CONCURRENCY = 2;

const INDEX_SELECT = 'id,chunkId,documentId,projectId,pageNumber';

const DOCUMENT_FIELDS = [
  'contentExtracted', 'contentExtractionError', 'contentPageCount', 'isDeleted', 'chunkPurgeFailedAt'
];

const VALUE_FLAGS = {
  '--max-delete': 'maxDelete',
  '--max-minutes': 'maxMinutes',
  '--project': 'project',
  '--state': 'state',
  '--audit': 'audit'
};

const COUNTERS = [
  'documents', 'indexRows', 'wouldDelete', 'deleted', 'failed', 'keptNoLiveRows',
  'keptNoLiveDocuments', 'cosmosOnly', 'cosmosOnlyDocuments', 'extractedNoChunksDocuments',
  'textlessDocuments', 'failedDocuments'
];

function parseArgs(argv) {
  const args = {
    live: false, maxDelete: null, maxMinutes: null, project: null, state: null, audit: null
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (VALUE_FLAGS[a]) args[VALUE_FLAGS[a]] = String(argv[++i] ?? '');
    else throw new Error(`[purge-index-only] unknown argument: ${a}. ${USAGE}`);
  }
  for (const flag of ['project', 'state', 'audit']) {
    // An empty `--project` would walk the no-project partition and report success.
    if (args[flag] === '') throw new Error(`[purge-index-only] --${flag} needs a value. ${USAGE}`);
  }
  if (args.maxDelete !== null) {
    args.maxDelete = Number(args.maxDelete);
    if (!Number.isInteger(args.maxDelete) || args.maxDelete < 1) {
      throw new Error('[purge-index-only] --max-delete must be a positive integer');
    }
  }
  if (args.live && args.maxDelete === null) {
    throw new Error(`[purge-index-only] --live needs --max-delete N. ${USAGE}`);
  }
  if (args.maxMinutes !== null) {
    args.maxMinutes = Number(args.maxMinutes);
    if (!(args.maxMinutes > 0)) throw new Error('[purge-index-only] --max-minutes must be above 0');
  }
  return args;
}

const newCounters = (mode) => Object.fromEntries([['mode', mode], ...COUNTERS.map(k => [k, 0])]);

function addCounters(into, from) {
  for (const k of COUNTERS) into[k] += from[k] || 0;
}

function defaultAuditPath(mode, now) {
  const base = fs.existsSync('/home/demi') ? '/home/demi' : '.';
  const stamp = now.toISOString();
  return path.join(base, `chunks-index-only-${stamp.slice(0, 10)}`,
    `${mode}-${stamp.replace(/[:.]/g, '-')}.ndjson`);
}

/**
 * Every index row of one document, keyed by index key. Paged with `skip` like listStaleChunkIds;
 * a full page that adds no key means the offset hit the service ceiling, which would loop forever.
 */
async function listIndexRows(search, index, documentId) {
  const filter = `documentId eq ${quote(documentId)}`;
  const pageRows = search.MAX_PAGE_ROWS;
  const rows = new Map();
  for (;;) {
    const before = rows.size;
    const { value } = await search.runSearch(index, {
      matchAll: true, filter, select: INDEX_SELECT, top: pageRows, skip: rows.size
    });
    const page = value || [];
    for (const row of page) if (row && row.id) rows.set(String(row.id), row);
    if (page.length < pageRows) return [...rows.values()];
    if (rows.size === before) {
      throw new Error(`index listing of document ${documentId} stopped at ${rows.size} rows`);
    }
  }
}

const auditLine = (row, action) => JSON.stringify({
  documentId: row.documentId, chunkId: row.chunkId, key: row.id ?? null,
  projectId: row.projectId ?? null, pageNumber: row.pageNumber ?? null, action
});

/** Reserved before the await, so two documents in flight cannot both fit under the ceiling. */
function reserveDeletes(run, count) {
  if (run.stop) return false;
  if (run.reserved + count > run.args.maxDelete) {
    run.stop = 'max-delete';
    logger.warn(`[purge-index-only] stopping: deleting ${count} more rows would pass --max-delete ` +
      `${run.args.maxDelete} (${run.reserved} reserved so far).`);
    return false;
  }
  run.reserved += count;
  return true;
}

async function deleteRows(run, counters, rows) {
  if (!reserveDeletes(run, rows.length)) return [];
  // The listed keys, never re-derived: the indexer's base64 key is not the chunk id.
  const failed = new Set((await run.search.deleteDocuments(rows.map(r => String(r.id)))).map(String));
  counters.failed += failed.size;
  counters.deleted += rows.length - failed.size;
  return rows.map(row => auditLine(row, failed.has(String(row.id)) ? 'failed' : 'deleted'));
}

/**
 * Marked extracted, no error, no Cosmos chunk. A textless ingest leaves that by design, with chunk
 * count 0 and no index rows; any other such document is a defect to re-extract.
 */
function judgeExtraction(counters, doc, projectId, indexRows) {
  if (doc.contentExtracted !== true || doc.contentExtractionError || doc.isDeleted === true ||
    doc.chunkPurgeFailedAt) return [];
  const contentPageCount = Number(doc.contentPageCount) || 0;
  if (contentPageCount === 0 && indexRows === 0) {
    counters.textlessDocuments++;
    return [];
  }
  counters.extractedNoChunksDocuments++;
  return [JSON.stringify({
    documentId: String(doc.id), projectId, contentPageCount, indexRows, action: 'extracted-no-chunks'
  })];
}

async function judgeDocument(run, counters, partition, doc) {
  const documentId = String(doc.id);
  const listed = await listIndexRows(run.search, run.index, documentId);
  // Read after the listing and right before the delete, so a chunk written meanwhile is kept.
  const live = new Set((await run.chunksRepo.idsForDocument(run.access, documentId)).map(String));
  counters.documents++;
  counters.indexRows += listed.length;

  const indexed = new Set(listed.map(row => String(row.chunkId)));
  const projectId = partition === NULL_PARTITION ? null : partition;
  // Indexer lag, not a fault: the audit line lets the runner re-check after the next indexer run.
  const lines = [...live].filter(id => !indexed.has(id))
    .map(chunkId => auditLine({ documentId, chunkId, projectId }, 'cosmos-only'));
  counters.cosmosOnly += lines.length;
  if (lines.length) counters.cosmosOnlyDocuments++;
  if (live.size === 0) lines.push(...judgeExtraction(counters, doc, projectId, listed.length));

  // A row with no chunk id cannot be judged, so it is kept.
  const indexOnly = listed.filter(row => row.chunkId && !live.has(String(row.chunkId)));
  if (indexOnly.length === 0) return lines;
  // These rows are the only searchable text the document has until it is re-extracted.
  if (live.size === 0) {
    counters.keptNoLiveRows += indexOnly.length;
    counters.keptNoLiveDocuments++;
    return lines.concat(indexOnly.map(row => auditLine(row, 'kept-no-live')));
  }
  if (!run.args.live) {
    counters.wouldDelete += indexOnly.length;
    return lines.concat(indexOnly.map(row => auditLine(row, 'would-delete')));
  }
  return lines.concat(await deleteRows(run, counters, indexOnly));
}

async function walkDocument(run, counters, partition, doc) {
  if (run.stop) return;
  try {
    const lines = await judgeDocument(run, counters, partition, doc);
    if (lines.length) fs.appendFileSync(run.auditPath, lines.join('\n') + '\n');
  } catch (err) {
    counters.failedDocuments++;
    logger.error(`[purge-index-only] document ${doc.id}: ${err.message}`,
      { error: err.message, stack: err.stack });
  }
}

/** Refuses before any read: a dry run against no index would report a clean corpus. */
function assertConfigured(search, opts) {
  if (!search.config().configured) {
    throw new Error('[purge-index-only] SEARCH_ENDPOINT is not set; refusing to run');
  }
  if (!opts.cosmosReady) {
    throw new Error('[purge-index-only] Cosmos is not configured (COSMOS_ENDPOINT); refusing to run');
  }
}

/** This run's counters, then the sum over every checkpointed partition, earlier runs included. */
function summaryLine(summary) {
  const c = (o) => `documents ${o.documents}, indexRows ${o.indexRows}, ` +
    `wouldDelete ${o.wouldDelete}, deleted ${o.deleted}, failed ${o.failed}, ` +
    `keptNoLiveChunks ${o.keptNoLiveRows} rows in ${o.keptNoLiveDocuments} documents, ` +
    `cosmosOnly ${o.cosmosOnly} in ${o.cosmosOnlyDocuments} documents, ` +
    `extractedNoChunks ${o.extractedNoChunksDocuments} documents, ` +
    `textless ${o.textlessDocuments} documents, failedDocuments ${o.failedDocuments}`;
  return `[purge-index-only] ${summary.mode}: ${summary.partitions} partitions walked, ` +
    `${summary.resumed} resumed; this run: ${c(summary.run)}; checkpointed total: ` +
    `${c(summary.total)}; stop ${summary.stop || 'none'}; audit ${summary.auditPath}`;
}

/** Checkpointed partitions; a live run resuming a dry run's file would skip what it never deleted. */
function loadWalked(args, mode) {
  const walked = args.state ? loadState(args.state).walked : {};
  if (Object.values(walked).some(c => c.mode !== mode)) {
    throw new Error(`[purge-index-only] ${args.state} was written by another mode; use a new file`);
  }
  return walked;
}

async function walkPartition(run, partition) {
  const counters = newCounters(run.mode);
  const rows = partition === NULL_PARTITION
    ? await run.documentsRepo.projectedRowsWithNoProject(run.access, DOCUMENT_FIELDS)
    : await run.documentsRepo.projectedRowsForProject(run.access, partition, DOCUMENT_FIELDS);
  await mapLimit(rows, CONCURRENCY, doc => walkDocument(run, counters, partition, doc));
  return counters;
}

/**
 * @param {string[]} argv
 * @param {object} [opts]  {cosmosReady} plus test seams {documents, chunks, search, now, clock}
 */
async function purge(argv = [], opts = {}) {
  const args = parseArgs(argv);
  const search = opts.search || aiSearch;
  assertConfigured(search, opts);
  const mode = args.live ? 'live' : 'dry-run';
  const clock = opts.clock || Date.now;
  const startedMs = clock();
  const auditPath = args.audit || defaultAuditPath(mode, opts.now || new Date());
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  const walked = loadWalked(args, mode);

  const run = {
    args, mode, search, auditPath, access: systemAccess(), index: search.config().index,
    documentsRepo: opts.documents || documents, chunksRepo: opts.chunks || chunks,
    reserved: 0, stop: null
  };
  const partitions = await partitionsFor(args, run.documentsRepo, run.access);
  const todo = partitions.filter(p => !(p in walked));
  const summary = {
    mode, partitions: 0, resumed: partitions.length - todo.length, run: newCounters(mode),
    total: newCounters(mode), stop: null, auditPath
  };
  logger.info(`[purge-index-only] ${mode}: ${todo.length} partitions to walk; audit ${auditPath}`);

  for (const partition of todo) {
    if (args.maxMinutes !== null && clock() - startedMs >= args.maxMinutes * 60000) {
      run.stop = 'max-minutes';
    }
    if (run.stop) break;
    const counters = await walkPartition(run, partition);
    addCounters(summary.run, counters);
    summary.partitions++;
    // A stop or a failure leaves the partition for the next run to walk again.
    if (args.state && !run.stop && !counters.failed && !counters.failedDocuments) {
      walked[partition] = counters;
      saveState(args.state, { walked });
    }
  }

  for (const counters of Object.values(walked)) addCounters(summary.total, counters);
  summary.stop = run.stop;
  logger.info(summaryLine(summary));
  return summary;
}

/** Non-zero on any stop before the end, failed delete or document that could not be judged. */
function exitCodeFor(summary) {
  return summary.stop || summary.run.failed || summary.run.failedDocuments ? 1 : 0;
}

module.exports = { parseArgs, purge, exitCodeFor, USAGE };

if (require.main === module) {
  const { initCosmosClient } = require('../db/cosmos-nosql');
  const cosmosReady = Boolean(initCosmosClient());

  purge(process.argv.slice(2), { cosmosReady })
    .then(summary => process.exit(exitCodeFor(summary)))
    .catch(err => {
      logger.error(`[purge-index-only] Fatal: ${err.message}`, { error: err.message, stack: err.stack });
      process.exit(1);
    });
}
