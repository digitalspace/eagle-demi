'use strict';

/**
 * Copy each document's filter fields onto its chunks. Dry run unless `--live`; runs on the devbox.
 * Step order, flags and summary: wiki [[Chunk-Parent-Field-Backfill]]. Out of order it strands values.
 */
const fs = require('fs');

const documents = require('../repositories/documents');
const chunks = require('../repositories/chunks');
const aiSearch = require('../search/ai-search');
const { systemAccess } = require('../helpers/access-sql');
const { mapLimit } = require('../utils/worker-pool');
const { logger } = require('../utils/logger');

const DEFAULT_STATE = './backfill-chunk-parent-fields.state.json';

// Bucket for documents whose `projectId` is JSON null, read cross-partition. Spaces and brackets
// keep it apart from real keys, which are ObjectIds or `''`.
const NULL_PARTITION = '(no projectId)';

// A ceiling, not a full drain: rows just patched read as unstamped until the indexer catches up.
const ORPHAN_SCAN_CAP = 2000;

const ORPHAN_SKIP_REASON =
  'the index could not say which rows are unstamped: search unconfigured, or no ' +
  'parentFieldsVersion column';

// Kept low: the serverless account is shared with the live API.
const DEFAULT_CONCURRENCY = 2;

// Above the shared bulk default, which request paths keep short. A corpus walk stays throttled
// for minutes, and running out of attempts leaves a document part-stamped.
const DEFAULT_MAX_ATTEMPTS = 12;

// Throttle hints run to tens of seconds; clipping one resends into a partition with no budget.
const BACKFILL_MAX_BACKOFF_MS = 60000;

/** The bucket a row belongs to: its own partition key, or the null bucket. */
function partitionOf(projectId) {
  return projectId === null || projectId === undefined ? NULL_PARTITION : String(projectId);
}

/** The reverse: the projectId a bucket name stands for, which for the null bucket is `null`. */
function projectIdOf(partition) {
  return partition === NULL_PARTITION ? null : partition;
}

/** `{id, projectId}` rows -> partition -> Set of document ids. */
function groupByPartition(rows) {
  const byPartition = new Map();
  for (const row of rows) {
    // Not `String(row.projectId)`: that turns JSON null into `'null'`, a partition nothing lives in.
    const partition = partitionOf(row.projectId);
    if (!byPartition.has(partition)) byPartition.set(partition, new Set());
    byPartition.get(partition).add(String(row.id));
  }
  return byPartition;
}

/**
 * The flag's own token when it has one, else the run's start, which loses to any re-stamp queued
 * after the run began.
 */
function stampedAtFor(doc, startedAt) {
  return doc.parentFieldsPending === true && doc.parentFieldsPendingAt
    ? doc.parentFieldsPendingAt
    : startedAt;
}

function parseArgs(argv) {
  const args = {
    live: false, project: null, pending: false, force: false,
    concurrency: DEFAULT_CONCURRENCY, state: DEFAULT_STATE, maxAttempts: DEFAULT_MAX_ATTEMPTS
  };
  let explicitDryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--pending') args.pending = true;
    else if (a === '--force') args.force = true;
    else if (a === '--project') args.project = String(argv[++i] || '');
    else if (a === '--concurrency') args.concurrency = parseInt(argv[++i], 10);
    else if (a === '--max-attempts') args.maxAttempts = parseInt(argv[++i], 10);
    else if (a === '--state') args.state = String(argv[++i] || '');
    else throw new Error(`[backfill] unknown argument: ${a}`);
  }

  if (args.live && explicitDryRun) {
    throw new Error('[backfill] --live and --dry-run contradict each other');
  }
  if (args.pending && args.project !== null) {
    throw new Error('[backfill] --pending and --project contradict each other');
  }
  // An empty value would walk the no-project partition and report success.
  if (args.project !== null && !args.project) {
    throw new Error('[backfill] --project needs a project id');
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 8) {
    throw new Error(`[backfill] --concurrency must be between 1 and 8, got: ${args.concurrency}`);
  }
  // Rejected, not clamped: a typo read as "1" would turn retry off.
  if (!Number.isInteger(args.maxAttempts) || args.maxAttempts < 1 || args.maxAttempts > 20) {
    throw new Error(`[backfill] --max-attempts must be between 1 and 20, got: ${args.maxAttempts}`);
  }
  if (!args.state) throw new Error('[backfill] --state needs a path');

  return args;
}

/**
 * `{walked: {partition: documentCount}, expected, expectedAt}`. A checkpointed partition is not
 * re-read, so its count is all the coverage check has; `expected` is the corpus size at start.
 */
function loadState(path) {
  try {
    const state = JSON.parse(fs.readFileSync(path, 'utf8'));
    return {
      walked: state.walked || {},
      // Treated as absent when not a number, which fails closed.
      expected: Number.isFinite(state.expected) ? state.expected : undefined,
      expectedAt: state.expectedAt
    };
  } catch (err) {
    // Writes are idempotent, so a bad file just costs a fresh walk.
    if (err.code !== 'ENOENT') {
      logger.warn(`[backfill] ignoring unreadable state file ${path}: ${err.message}`);
    }
    return { walked: {} };
  }
}

/**
 * Write then rename, which is atomic: a kill mid-write would otherwise lose every checkpoint.
 */
function saveState(path, state) {
  const tmp = `${path}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, path);
}

/**
 * Read from documents, not `projects`: parents such as ProjectNotification ids have no project row.
 */
async function partitionsFor(args, documentsRepo, access) {
  if (args.project !== null) return [args.project];
  const ids = await documentsRepo.listDistinctProjectIds(access);
  // JSON null and `''` are different partitions, and DISTINCT never returns the null rows.
  return [...ids.map(String), NULL_PARTITION];
}

/**
 * @param {string[]} argv
 * @param {object} [opts]  test seam: {documents, chunks, state, now}
 */
async function backfill(argv = [], opts = {}) {
  const args = parseArgs(argv);
  const documentsRepo = opts.documents || documents;
  const chunksRepo = opts.chunks || chunks;
  const search = opts.search || aiSearch;
  // Taken once before any read, so an hours-long walk loses to any re-stamp queued after it began.
  const startedAt = opts.now || new Date().toISOString();

  // A scoped context would see only some documents and report a partial run as success.
  const access = systemAccess();

  const summary = {
    mode: args.live ? 'live' : 'dry-run',
    scope: args.pending ? 'pending' : (args.project !== null ? 'project' : 'corpus'),
    partitions: 0,
    resumed: 0,
    documents: 0,
    // Documents in partitions a previous run checkpointed; counts toward coverage on a resume.
    checkpointed: 0,
    nullProject: 0,
    planned: 0,
    skipped: 0,
    documentsReStamped: 0,
    patched: 0,
    // Chunks a newer walk already stamped. Not a failure.
    skippedNewer: 0,
    pendingCleared: 0,
    pendingConflicts: 0,
    pendingMissed: 0,
    // `--pending` only: flags still raised, including rows that moved partition and were never seen.
    pendingLeftRaised: 0,
    // Index rows whose Cosmos chunk is gone. Found on every run, deleted only by a live one.
    orphansFound: 0,
    orphansPurged: 0,
    orphansFailed: 0,
    orphansSkipped: 0,
    orphansSkippedReason: null,
    // Two units on purpose: one document is about 19 chunk operations.
    failedDocuments: 0,
    failedChunks: 0,
    statusCounts: {},
    requestCharge: 0
  };
  let logged = 0;
  // Flagged ids the run reached any outcome on; `--pending` diffs its list against this at the end.
  const pendingAccounted = new Set();

  // Repairs of a named subset ignore the checkpoint; only the corpus walk resumes.
  const resumable = args.project === null && !args.pending;
  const state = resumable ? loadState(args.state) : { walked: {} };
  const walked = { ...state.walked };

  const pendingByPartition = args.pending
    ? groupByPartition(await documentsRepo.listParentFieldsPending(access))
    : null;

  const partitions = pendingByPartition
    ? [...pendingByPartition.keys()]
    : await partitionsFor(args, documentsRepo, access);
  const todo = partitions.filter(p => !(p in walked));
  // Read before the walk adds to the state, so it covers exactly the partitions this run skips.
  const resumedPartitions = partitions.filter(p => p in walked);
  summary.resumed = resumedPartitions.length;
  summary.checkpointed = resumedPartitions.reduce((n, p) => n + walked[p], 0);
  // Measured against the corpus at start: later ingest is stamped on write, so a fresh count would
  // fail a complete resume.
  let expected;
  if (resumable) {
    // Null-projectId rows included, because the null bucket is walked.
    const countedNow = await documentsRepo.countVisible(access, {});
    summary.expectedNow = countedNow;
    if (state.expected === undefined) {
      expected = countedNow;
      // Only a fresh start sets the snapshot; the first checkpoint saves it, so a dry run writes none.
      if (!Object.keys(walked).length) {
        state.expected = countedNow;
        state.expectedAt = new Date().toISOString();
      }
    } else {
      expected = state.expected;
      if (countedNow !== expected) {
        logger.info(
          `[backfill] the corpus holds ${countedNow} documents now, ${expected} when this backfill ` +
          `started (${state.expectedAt || 'time not recorded'}); coverage is measured against the ` +
          'snapshot, because documents ingested since are stamped at ingest.'
        );
      }
    }
  }

  /**
   * Delete index rows whose Cosmos chunk is gone; the indexer never sees deletes, and those rows
   * hold back facets. Each is confirmed by point read first: its document may have moved project.
   */
  const purgeOrphans = async (partition, cosmosChunkIds) => {
    const stale = await search.listStaleChunkIds({
      version: chunks.CHUNK_PARENT_FIELDS_VERSION,
      projectId: projectIdOf(partition),
      maxRows: ORPHAN_SCAN_CAP
    });
    // "Cannot say" is not "none": counted, and fails a live run.
    if (!stale) {
      summary.orphansSkipped++;
      summary.orphansSkippedReason = ORPHAN_SKIP_REASON;
      logger.warn(`[backfill] partition ${partition}: no orphan scan — ${ORPHAN_SKIP_REASON}.`);
      return;
    }
    if (!stale.complete) {
      logger.warn(
        `[backfill] partition ${partition}: ${stale.total} unstamped index rows, of which ` +
        `${stale.rows.length} were examined for orphans. Re-run once the indexer has caught up.`
      );
    }

    const orphans = [];
    for (const row of stale.rows) {
      // A row missing either id cannot be judged, so it is kept.
      if (!row.chunkId || !row.documentId) continue;
      if (cosmosChunkIds.has(String(row.chunkId))) continue;
      if (await chunksRepo.getById(access, row.chunkId, row.documentId)) continue;
      orphans.push(String(row.id));
    }
    summary.orphansFound += orphans.length;
    if (orphans.length === 0 || !args.live) return;

    const failed = await search.deleteDocuments(orphans);
    summary.orphansPurged += orphans.length - failed.length;
    summary.orphansFailed += failed.length;
    logger.info(
      `[backfill] partition ${partition}: ${orphans.length - failed.length} orphaned index rows ` +
      `deleted, ${failed.length} still indexed.`
    );
  };

  const walk = async (partition) => {
    // Projected rows, not `listVisible`: full rows cost too much across the corpus.
    const rowsHere = partition === NULL_PARTITION
      ? await documentsRepo.parentFieldRowsWithNoProject(access)
      : await documentsRepo.parentFieldRowsForProject(access, partition);
    // What `setParentFieldsPending` needs: the row's own projectId, never the bucket name.
    const partitionKey = projectIdOf(partition);
    const onlyIds = pendingByPartition ? pendingByPartition.get(partition) : null;
    let stampableHere = 0;
    let walkedHere = 0;
    const toStamp = [];
    // Flagged documents whose chunks were proved to agree, in every scope, not just `--pending`.
    const clearable = [];
    const staleIds = new Map();
    // Complete only when the whole partition is walked, so `--pending` skips the orphan purge.
    const cosmosChunkIds = new Set();

    for (const doc of rowsHere) {
      if (onlyIds && !onlyIds.has(String(doc.id))) continue;
      summary.documents++;
      walkedHere++;

      const fields = chunksRepo.parentFieldsOf(doc);
      // List refs only: `projectId` and `parentFieldsVersion` are never null.
      if (chunks.CHUNK_PARENT_LIST_REFS.some(field => fields[field] !== null)) stampableHere++;

      // Compares what the chunks hold, so a value removed upstream is cleared too.
      const rows = await chunksRepo.parentFieldRowsForDocument(access, doc.id);
      for (const row of rows) cosmosChunkIds.add(String(row.id));
      const stale = args.force
        ? rows
        : rows.filter(row => !chunksRepo.chunkMatchesParent(row, fields));
      if (stale.length === 0) {
        summary.skipped++;
        // Chunks already agree, so a leftover flag can be cleared without a patch.
        if (args.live && doc.parentFieldsPending === true) clearable.push(doc);
        continue;
      }

      summary.planned++;
      if (!args.live) continue;

      toStamp.push(doc);
      staleIds.set(String(doc.id), stale.map(row => row.id));
    }

    // No `failedIds`: this script writes no document rows. `stamp` patches only the stale chunk ids.
    const result = await chunksRepo.reStampAfterWrite(access, toStamp, [], {
      onError: (doc, err) => {
        if (logged++ < chunks.MAX_LOGGED_RESTAMP_ERRORS) {
          logger.error(`[backfill] document ${doc.id}: ${err.message}`);
        }
      },
      // Per document, not batch-wide: a flagged row stamps with its own token.
      stamp: (acc, documentId, doc) => chunksRepo.setFieldsForChunks(
        acc, documentId, staleIds.get(String(documentId)), chunksRepo.parentFieldsOf(doc),
        {
          stampedAt: stampedAtFor(doc, startedAt), maxAttempts: args.maxAttempts,
          maxBackoffMs: BACKFILL_MAX_BACKOFF_MS
        })
    });
    summary.documentsReStamped += result.stamped;
    summary.patched += result.chunks;
    summary.skippedNewer += result.skippedNewer;
    summary.failedDocuments += result.failedDocuments;
    summary.failedChunks += result.failedChunks;
    summary.requestCharge += result.requestCharge;
    for (const [status, n] of Object.entries(result.statusCounts)) {
      summary.statusCounts[status] = (summary.statusCounts[status] || 0) + n;
    }

    // Per document: one failed chunk keeps only its own document's flag raised.
    const stamped = new Set(result.stampedDocumentIds);
    if (args.live) {
      for (const doc of toStamp) {
        if (doc.parentFieldsPending === true && stamped.has(String(doc.id))) clearable.push(doc);
      }
    }

    summary.partitions++;
    if (partition === NULL_PARTITION) summary.nullProject = walkedHere;
    const landed = result.failedDocuments === 0 && result.failedChunks === 0;

    if (!onlyIds) await purgeOrphans(partition, cosmosChunkIds);

    for (const doc of clearable) {
      // Guarded on the flag token, not the etag, as `jobs/restamp-chunks.js` does: any unrelated
      // patch moves the etag, and the clear would never win.
      const guard = doc.parentFieldsPendingAt ? { pendingAt: doc.parentFieldsPendingAt } : {};
      const outcome = await documentsRepo.setParentFieldsPending(doc.id, partitionKey, false, guard);
      pendingAccounted.add(String(doc.id));
      if (outcome.status === 'cleared') {
        summary.pendingCleared++;
      } else if (outcome.status === 'conflict') {
        summary.pendingConflicts++;
        logger.warn(`[backfill] document ${doc.id} was written again while this run walked it; ` +
          'its pending flag is left raised for the newer write to clear.');
      } else {
        // No row found: deleted under the run, or moved partition. The flag stays up, so it fails.
        summary.pendingMissed++;
        logger.warn(`[backfill] document ${doc.id}: its pending flag could not be cleared ` +
          `(${outcome.reason || outcome.status}).`);
      }
    }

    // A partition with no List refs looks like `backfill-document-list-ids.js` has not run yet, so
    // it is not checkpointed and a rerun retries it.
    if (args.live && resumable && landed && stampableHere > 0) {
      walked[partition] = walkedHere;
      state.walked = walked;
      saveState(args.state, state);
    }
  };

  await mapLimit(todo, args.concurrency, walk);

  // Flagged ids never reached, for example a row that moved partition after the listing. Live
  // only: a dry run clears nothing.
  if (args.live && pendingByPartition) {
    const leftRaised = [];
    for (const ids of pendingByPartition.values()) {
      for (const id of ids) if (!pendingAccounted.has(id)) leftRaised.push(id);
    }
    summary.pendingLeftRaised = leftRaised.length;
    if (leftRaised.length) {
      // Named so they can be repaired; capped because a systematic fault lists every one.
      logger.error(
        `[backfill] ${leftRaised.length} flagged documents are still flagged: their re-stamp did ` +
        'not land, or their row was not in the partition this run walked it from ' +
        `(${leftRaised.slice(0, 20).join(', ')}). Re-run --pending --live.`
      );
    }
  }

  const suffix = args.live ? '' : ' (dry run, nothing written)';
  logger.info(
    `[backfill] ${summary.scope}: ${summary.partitions} partitions walked, ${summary.resumed} ` +
    `already done; ${summary.documents} documents seen, ${summary.planned} to stamp, ` +
    `${summary.skipped} skipped whose chunks already agree; ` +
    `${summary.documentsReStamped} documents re-stamped, ${summary.patched} chunk operations ` +
    `landed, ${summary.skippedNewer} left to a newer walk, ` +
    `${summary.pendingCleared} pending flags cleared (${summary.pendingConflicts} left ` +
    `raised for a newer write, ${summary.pendingMissed} whose row the clear could not find, ` +
    `${summary.pendingLeftRaised} never reached), ` +
    `${summary.orphansFound} orphaned index rows found ` +
    `(${summary.orphansPurged} deleted, ${summary.orphansFailed} still indexed, ` +
    `${summary.orphansSkipped} partitions not scanned` +
    `${summary.orphansSkippedReason ? `: ${summary.orphansSkippedReason}` : ''}), ` +
    `${summary.failedDocuments} documents left part-stamped (${summary.failedChunks} chunk ` +
    `operations rejected), ${summary.requestCharge.toFixed(0)} RU${suffix}`
  );
  if (summary.failedDocuments || summary.failedChunks) {
    logger.error(`[backfill] statuses: ${JSON.stringify(summary.statusCounts)}`);
  }

  // A partial run that reports success never gets re-run. Resumes count their checkpoints too.
  if (expected !== undefined) {
    summary.expected = expected;
    const covered = summary.documents + summary.checkpointed;
    if (covered < expected) {
      logger.error(
        `[backfill] INCOMPLETE: covered ${covered} of ${expected} documents ` +
        `(${summary.documents} walked now, ${summary.checkpointed} in ${summary.resumed} ` +
        'checkpointed partitions). Some partition was not enumerated — do NOT treat this run ' +
        'as done.'
      );
    } else {
      logger.info(
        `[backfill] covered ${covered} of ${expected} documents (${summary.documents} walked now, ` +
        `${summary.checkpointed} in ${summary.resumed} checkpointed partitions).`
      );
    }
  }

  return summary;
}

/**
 * Non-zero on any partial run: rejected writes, short coverage, flags still raised, or (live only)
 * an unfinished orphan purge. Coverage fails only when short; deletes can push it over.
 */
function exitCodeFor(summary) {
  const covered = summary.documents + (summary.checkpointed || 0);
  const incomplete = summary.expected !== undefined && covered < summary.expected;
  const orphansUnfinished = summary.mode === 'live' &&
    ((summary.orphansSkipped || 0) > 0 || (summary.orphansFailed || 0) > 0);
  return summary.failedDocuments || summary.failedChunks || incomplete ||
    summary.pendingMissed || summary.pendingLeftRaised || orphansUnfinished ? 1 : 0;
}

module.exports = {
  parseArgs, loadState, saveState, backfill, exitCodeFor,
  DEFAULT_CONCURRENCY, DEFAULT_MAX_ATTEMPTS, DEFAULT_STATE, NULL_PARTITION
};

if (require.main === module) {
  const { initCosmosClient } = require('../db/cosmos-nosql');
  initCosmosClient();

  backfill(process.argv.slice(2))
    .then(summary => {
      process.exit(exitCodeFor(summary));
    })
    .catch(err => {
      logger.error(`[backfill] Fatal: ${err.stack || err.message}`);
      process.exit(1);
    });
}
