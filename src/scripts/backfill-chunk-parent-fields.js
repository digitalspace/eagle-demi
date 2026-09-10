'use strict';

/**
 * Stamp each document's filter metadata onto every one of its chunks.
 *
 * WHY. A chunk query can filter on `type`, `milestone`, `projectPhase` and `documentAuthorType`
 * only if every chunk carries its parent's copy (`chunks.CHUNK_PARENT_FIELDS`): resolving the
 * matching documents first is capped at `ai-search.DOCUMENT_SCOPE_CAP`, and all four were over
 * that cap on the live corpus. Ingest writes them on every new chunk; the ~1.1M older ones are
 * what this fills.
 *
 * THE ORDER OF THE STEPS AROUND IT IS NOT THE OBVIOUS ONE — List-id backfill, index PUT,
 * data-source PUT, app, then this. Out of order nothing reports an error and the values strand in
 * Cosmos, with `--force` as the repair. Wiki [[Bulk-Download-Operations]], "Chunk parent-field
 * rollout", holds the sequence, the checks and what the summary means.
 *
 * **DRY RUN BY DEFAULT**. `--live` is the mutating flag.
 *
 *   node src/scripts/backfill-chunk-parent-fields.js [--live | --dry-run]
 *          [--project <id> | --pending] [--force] [--concurrency N] [--max-attempts N]
 *          [--state ./backfill-chunk-parent-fields.state.json]
 *
 * `--max-attempts N` (1-20 accepted) sets the chunk-patch retry budget. This walk defaults to 12,
 * well above the shared bulk default, which is sized for the request path: a corpus walk on a
 * serverless account stays throttled for minutes at a time, and a batch that runs out of attempts
 * leaves the document part-stamped. Nothing here is inside a request, so the wait is free.
 *
 * `--live --pending` repairs only the documents flagged `parentFieldsPending` — the writes whose
 * re-stamp could not be queued or was skipped (`controllers/nosql/document.js`). `--live --project
 * <id>` is the manual repair, the one the poison-queue alert names. EVERY live walk clears the
 * flag on the documents it verified, whichever of the three scopes it ran under: the proof that a
 * document's chunks agree is the same proof in all of them, and a `--project` repair that left the
 * flag raised kept the drift line pointing at documents that were already fixed. Both flags ignore
 * the state file, because naming a subset is how a repair is asked for; a corpus run resumes from it.
 *
 * A live run patches Cosmos AND deletes index rows whose chunk is gone, so it needs the search
 * grant as well as the Cosmos one. Cosmos is private-endpoint-only and keyless, so it must execute
 * on the devbox (`demi-devbox-<env>`) via `demi-run`.
 */
const fs = require('fs');

const documents = require('../repositories/documents');
const chunks = require('../repositories/chunks');
const aiSearch = require('../search/ai-search');
const { systemAccess } = require('../helpers/access-sql');
const { mapLimit } = require('../utils/worker-pool');
const { logger } = require('../utils/logger');

const DEFAULT_STATE = './backfill-chunk-parent-fields.state.json';

/**
 * The bucket for documents whose `projectId` is JSON null. They address no partition key, so they
 * are read cross-partition under this name and are checkpointed and counted like any other
 * partition — left out, their chunks stay unstamped forever and the unscoped stale-chunk count
 * never reaches zero. The spaces and brackets are what keep it out of the id space: a real
 * partition key here is a Mongo ObjectId or `''`.
 */
const NULL_PARTITION = '(no projectId)';

/**
 * Unstamped index rows examined for orphans per partition. A ceiling rather than a full drain: on
 * a partition the backfill has just patched, every row still reads as unstamped until the indexer
 * catches up, and the orphans among them are found by the next pass instead.
 */
const ORPHAN_SCAN_CAP = 2000;

/**
 * Why an orphan scan did not run. `search.listStaleChunkIds` answers null for all three causes and
 * logs which one; the summary carries the sentence so a run whose purge never happened says so in
 * the figures a wrapper reads, rather than reporting zero orphans found.
 */
const ORPHAN_SKIP_REASON =
  'the index could not say which rows are unstamped: search unconfigured, or no ' +
  'parentFieldsVersion column';

/**
 * Partitions walked at once. Two, not one, because each document costs a chunk-id query and a bulk
 * patch that are mostly round-trip latency; not more, because this serverless account is shared
 * with the live API and the ceiling is throttling somebody else.
 */
const DEFAULT_CONCURRENCY = 2;

/**
 * Chunk-patch retry budget for THIS walk, three times the shared bulk default. The shared one is
 * held down by the request paths that share `bulkVerified` — an ingest upsert cannot block for a
 * minute — while nothing here is inside a request: the 2026-09 walk lost 70 documents to a
 * throttle that outlasted its budget, and the only cost of a longer one is wall clock.
 */
const DEFAULT_MAX_ATTEMPTS = 12;

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
    // NOT `String(row.projectId)`: that folds a JSON null into `'null'`, a partition no document
    // lives in, so `--pending` read an empty partition and exited 0 with the flag still raised.
    const partition = partitionOf(row.projectId);
    if (!byPartition.has(partition)) byPartition.set(partition, new Set());
    byPartition.get(partition).add(String(row.id));
  }
  return byPartition;
}

/**
 * The instant a document's chunks are stamped with: the token its flag was raised with where it
 * carries one, so the repair is ordered exactly as the write that asked for it, and the walk's own
 * start instant otherwise — which is older than any re-stamp queued after this run began, so a
 * corpus pass cannot overwrite one.
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
  // Both name what to walk, and the answers are different sets.
  if (args.pending && args.project !== null) {
    throw new Error('[backfill] --pending and --project contradict each other');
  }
  // An empty value would scope the run to the no-project partition rather than to the project the
  // operator named, and report success having patched almost nothing.
  if (args.project !== null && !args.project) {
    throw new Error('[backfill] --project needs a project id');
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 8) {
    throw new Error(`[backfill] --concurrency must be between 1 and 8, got: ${args.concurrency}`);
  }
  // Rejected rather than clamped silently, because a typo that read as "1" would turn the retry
  // off on the walk that needs it most.
  if (!Number.isInteger(args.maxAttempts) || args.maxAttempts < 1 || args.maxAttempts > 20) {
    throw new Error(`[backfill] --max-attempts must be between 1 and 20, got: ${args.maxAttempts}`);
  }
  if (!args.state) throw new Error('[backfill] --state needs a path');

  return args;
}

/**
 * `{walked: {partition: documents}, expected, expectedAt}`.
 *
 * One record per finished partition, and it is the document count: a checkpointed partition is not
 * re-read, so that count is the only evidence the coverage check has. `expected` is the corpus
 * total as it was when the backfill started, absent in a file this script did not write.
 */
function loadState(path) {
  try {
    const state = JSON.parse(fs.readFileSync(path, 'utf8'));
    return {
      walked: state.walked || {},
      // A non-number here is a file this script did not write, or one truncated by an older
      // in-place write. Treated as absent, which is the fail-closed branch.
      expected: Number.isFinite(state.expected) ? state.expected : undefined,
      expectedAt: state.expectedAt
    };
  } catch (err) {
    // A corrupt or absent file starts a fresh walk rather than stopping the run: every write here
    // is idempotent, so re-walking a partition costs RU and changes nothing.
    if (err.code !== 'ENOENT') {
      logger.warn(`[backfill] ignoring unreadable state file ${path}: ${err.message}`);
    }
    return { walked: {} };
  }
}

/**
 * Written beside the target and renamed. `writeFileSync` truncates first, so a kill mid-write
 * leaves JSON `loadState` reads as "nothing checkpointed" and the resume re-walks 1.1M chunks.
 * `rename` inside one directory is atomic.
 */
function saveState(path, state) {
  const tmp = `${path}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, path);
}

/**
 * Every partition to walk, in a stable order.
 *
 * FROM THE DOCUMENTS CONTAINER, NOT FROM `projects`. A document's partition key is whatever
 * `parent-admit.js` admitted as its parent, ProjectNotification ids included, and those partitions
 * have no `projects` row at all — enumerating from `projects.listVisible` skips them silently.
 */
async function partitionsFor(args, documentsRepo, access) {
  if (args.project !== null) return [args.project];
  const ids = await documentsRepo.listDistinctProjectIds(access);
  // NOT `String(id ?? '')`. A JSON-null `projectId` and `''` are two different partitions, and
  // folding one into the other pinned every read to `''` and walked nothing. The DISTINCT cannot
  // return the null rows at all, which is why they come back as a bucket of their own.
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
  // ONCE per run, before anything is read: it is the stamp every unflagged row's chunks get, so a
  // walk that takes hours still loses to a re-stamp queued after it started rather than to one
  // queued after it reached that partition.
  const startedAt = opts.now || new Date().toISOString();

  // systemAccess() is mandatory: a scoped context would list only the documents it can SEE and
  // leave the rest unfilterable, a partial backfill reporting success.
  const access = systemAccess();

  const summary = {
    mode: args.live ? 'live' : 'dry-run',
    scope: args.pending ? 'pending' : (args.project !== null ? 'project' : 'corpus'),
    partitions: 0,
    resumed: 0,
    documents: 0,
    // Documents a previous run walked in the partitions it checkpointed, read back from the state
    // file. Added to `documents` to answer "was the whole corpus covered" across a resume.
    checkpointed: 0,
    // Documents whose `projectId` is JSON null, walked as their own bucket — see NULL_PARTITION.
    nullProject: 0,
    planned: 0,
    skipped: 0,
    documentsReStamped: 0,
    patched: 0,
    // Chunk operations a NEWER walk had already stamped, so this one left them alone. Not a
    // failure: the value on those chunks is at least as current as the one this walk carries.
    skippedNewer: 0,
    // Documents whose `parentFieldsPending` flag this run cleared, having proved their chunks
    // agree; those whose row moved under the run, whose flag belongs to that newer write; and
    // those whose row the clear could not find at all, which is drift nothing else reports.
    pendingCleared: 0,
    pendingConflicts: 0,
    pendingMissed: 0,
    // `--pending` only: documents it was asked to repair whose flag is still raised — the re-stamp
    // did not land, or the row moved partition between the flag listing and the walk and was never
    // seen at all. The second kind is counted nowhere else, and it is why a run could clear nothing
    // and still exit 0 while the reconcile kept reporting the same documents.
    pendingLeftRaised: 0,
    // Index rows whose Cosmos chunk is gone. Found on every run, deleted only by a live one.
    orphansFound: 0,
    orphansPurged: 0,
    orphansFailed: 0,
    // Partitions whose orphan scan could not run, and the one reason it could not.
    orphansSkipped: 0,
    orphansSkippedReason: null,
    // Two counters, two units: a document whose patch threw, and a chunk operation Cosmos rejected.
    // One document is ~19 chunk operations, so a single mixed number could not be read either way.
    failedDocuments: 0,
    failedChunks: 0,
    statusCounts: {},
    requestCharge: 0
  };
  let logged = 0;
  // Flagged ids the run reached an outcome on, whichever outcome it was. `--pending` diffs the
  // list it was given against this at the end: an id in neither is one the walk never saw.
  const pendingAccounted = new Set();

  // The checkpoint belongs to the corpus walk. `--project` and `--pending` are deliberate repairs
  // of a known subset, so skipping one an earlier run finished is the opposite of what was asked.
  const resumable = args.project === null && !args.pending;
  const state = resumable ? loadState(args.state) : { walked: {} };
  const walked = { ...state.walked };

  // In `--pending` mode the walk is driven by the flag rather than by the partition list: only the
  // documents a re-stamp never reached, in only the partitions that hold one.
  const pendingByPartition = args.pending
    ? groupByPartition(await documentsRepo.listParentFieldsPending(access))
    : null;

  const partitions = pendingByPartition
    ? [...pendingByPartition.keys()]
    : await partitionsFor(args, documentsRepo, access);
  const todo = partitions.filter(p => !(p in walked));
  // Counted from the state file BEFORE the walk adds to it, so `checkpointed` covers exactly the
  // partitions this run does not read.
  const resumedPartitions = partitions.filter(p => p in walked);
  summary.resumed = resumedPartitions.length;
  summary.checkpointed = resumedPartitions.reduce((n, p) => n + walked[p], 0);
  // The same predicate counted directly, so a walk that never reached a partition shows as a
  // number rather than a quiet success. Measured against the corpus this backfill was STARTED
  // over: ingest keeps running, and chunks written after the start are stamped at ingest, so a
  // fresh count would make a complete resume report incomplete purely because the corpus grew. An
  // old state file — checkpoints but no snapshot — falls back to a fresh count.
  let expected;
  if (resumable) {
    // EVERY document, null-projectId rows included: the null bucket is walked, so leaving them out
    // would let a run that never read it still report full coverage.
    const countedNow = await documentsRepo.countVisible(access, {});
    summary.expectedNow = countedNow;
    if (state.expected === undefined) {
      expected = countedNow;
      // Only a run that has nothing checkpointed can claim to be the start of this backfill. It is
      // held in memory and written down by the first checkpoint, so a dry run leaves no state file.
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
   * Delete the index rows of this partition whose Cosmos chunk no longer exists.
   *
   * `chunks.deleteSurplus` removes chunks from Cosmos and the AI Search indexer has no deletion
   * detection, so those rows sit in the index unstamped forever — no patch can reach them, and the
   * unstamped count they inflate is what withholds the facets for every search over this project.
   *
   * A candidate is CONFIRMED against Cosmos before it is deleted: a chunk whose document moved to
   * another project is absent from this partition's ids and is not an orphan.
   */
  const purgeOrphans = async (partition, cosmosChunkIds) => {
    const stale = await search.listStaleChunkIds({
      version: chunks.CHUNK_PARENT_FIELDS_VERSION,
      projectId: projectIdOf(partition),
      maxRows: ORPHAN_SCAN_CAP
    });
    // "Cannot say", never "none": the rows are still there, still unstamped, and still holding
    // the facets back — so this is counted and exits non-zero on a live run rather than passing
    // as a partition with no orphans.
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
      // Nothing to check it against, so nothing is deleted: a row missing either id is a schema
      // the purge cannot judge.
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
    // PROJECTED, not `listVisible`: this compares five short strings per document and the full
    // catalogued row is what a corpus-wide walk pays for otherwise.
    const rowsHere = partition === NULL_PARTITION
      ? await documentsRepo.parentFieldRowsWithNoProject(access)
      : await documentsRepo.parentFieldRowsForProject(access, partition);
    // What `setParentFieldsPending` needs: the row's own projectId, never the bucket name.
    const partitionKey = projectIdOf(partition);
    const onlyIds = pendingByPartition ? pendingByPartition.get(partition) : null;
    let stampableHere = 0;
    let walkedHere = 0;
    const toStamp = [];
    // Documents whose `parentFieldsPending` flag this partition may clear. Every scope, not just
    // `--pending`: a `--project` repair compares the same chunks against the same row, so it holds
    // the same proof. The FLAGGED ones only — an unflagged document has nothing to clear, and a
    // patch per document would be one extra write for every row of the corpus.
    const clearable = [];
    // Chunk ids that disagree with their document, per document — the patch below writes to these
    // and no others.
    const staleIds = new Map();
    // Every chunk id this partition holds in Cosmos, which is what the orphan purge compares the
    // index against. Complete only when the whole partition is walked, so `--pending` skips it.
    const cosmosChunkIds = new Set();

    for (const doc of rowsHere) {
      if (onlyIds && !onlyIds.has(String(doc.id))) continue;
      summary.documents++;
      walkedHere++;

      const fields = chunksRepo.parentFieldsOf(doc);
      // A document that HAS something to copy down. THE LIST REFS ONLY: `projectId` and
      // `parentFieldsVersion` are never null, so reading every value would make the checkpoint
      // rule below true of every partition.
      if (chunks.CHUNK_PARENT_LIST_REFS.some(field => fields[field] !== null)) stampableHere++;

      // WHAT THE CHUNKS ACTUALLY HOLD, not what the document has to offer. Comparing the two ends
      // is what lets a value be CLEARED: a document whose type was removed upstream has nulls and
      // chunks still answering the old type.
      const rows = await chunksRepo.parentFieldRowsForDocument(access, doc.id);
      for (const row of rows) cosmosChunkIds.add(String(row.id));
      const stale = args.force
        ? rows
        : rows.filter(row => !chunksRepo.chunkMatchesParent(row, fields));
      if (stale.length === 0) {
        summary.skipped++;
        // Nothing to patch, so nothing failed: a flag left over from a re-stamp that never ran is
        // cleared by whatever proves the chunks agree, not only by a patch.
        if (args.live && doc.parentFieldsPending === true) clearable.push(doc);
        continue;
      }

      summary.planned++;
      if (!args.live) continue;

      toStamp.push(doc);
      staleIds.set(String(doc.id), stale.map(row => row.id));
    }

    // ONE call at the end of the partition, through the helper the seed and
    // `backfill-document-list-ids.js` also re-stamp with. No `failedIds`: this script writes no
    // document rows. `stamp` patches THE STALE ROWS ONLY — the ids that disagree are already in
    // hand, and on a corpus where most chunks are correct that is a repair rather than a rewrite.
    const result = await chunksRepo.reStampAfterWrite(access, toStamp, [], {
      onError: (doc, err) => {
        if (logged++ < chunks.MAX_LOGGED_RESTAMP_ERRORS) {
          logger.error(`[backfill] document ${doc.id}: ${err.message}`);
        }
      },
      // Stamped per document rather than through the helper's batch-wide `stampedAt`, because a
      // flagged row's instant is its own flag token — see `stampedAtFor`.
      stamp: (acc, documentId, doc) => chunksRepo.setFieldsForChunks(
        acc, documentId, staleIds.get(String(documentId)), chunksRepo.parentFieldsOf(doc),
        { stampedAt: stampedAtFor(doc, startedAt), maxAttempts: args.maxAttempts })
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

    // PER DOCUMENT, not per partition: `stampedDocumentIds` names the ones whose every chunk
    // operation was accepted, so a partition that lost a chunk under one document still clears the
    // flag on the rest. A document that failed keeps its flag for the next run.
    const stamped = new Set(result.stampedDocumentIds);
    if (args.live) {
      for (const doc of toStamp) {
        if (doc.parentFieldsPending === true && stamped.has(String(doc.id))) clearable.push(doc);
      }
    }

    summary.partitions++;
    if (partition === NULL_PARTITION) summary.nullProject = walkedHere;
    const landed = result.failedDocuments === 0 && result.failedChunks === 0;

    // Only from a complete walk: `--pending` reads a handful of documents, so its chunk ids say
    // nothing about which of the partition's index rows have a chunk behind them.
    if (!onlyIds) await purgeOrphans(partition, cosmosChunkIds);

    for (const doc of clearable) {
      // Guarded on the TOKEN the flag was raised with, as `jobs/restamp-chunks.js` guards its own
      // clear. An etag asks "did anything write this row", which an unrelated extraction patch
      // answers yes to, and the clear then loses to it forever; the token asks the only question
      // that matters — is the flag still the one this run walked. A row carrying no token is a
      // flag raised before tokens existed, and nothing newer can be hiding behind it.
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
        // The clear found no row to write. The document was deleted under the run, or its
        // partition key is not the one this walk read it from — either way the flag was not taken
        // down, so the run is not a success.
        summary.pendingMissed++;
        logger.warn(`[backfill] document ${doc.id}: its pending flag could not be cleared ` +
          `(${outcome.reason || outcome.status}).`);
      }
    }

    // CHECKPOINTED ONLY WHEN THE PARTITION HAD SOMETHING TO COPY AND ALL OF IT LANDED. A
    // partition whose documents carry no List refs at all is indistinguishable from
    // `backfill-document-list-ids.js` not having run yet, so it stays off and a rerun retries it.
    if (args.live && resumable && landed && stampableHere > 0) {
      // The count goes down with the partition, because nothing re-reads it: this is the only
      // record a later run has of what this partition contributed to the corpus total.
      walked[partition] = walkedHere;
      state.walked = walked;
      saveState(args.state, state);
    }
  };

  await mapLimit(todo, args.concurrency, walk);

  // THE IDS THE RUN WAS ASKED FOR AND NEVER ANSWERED. A row whose partition key changed between
  // `listParentFieldsPending` and the walk is not in the partition this run read it from, so no
  // clear was attempted, nothing was counted, and the flag stays up — which is a run that exits 0
  // while the reconcile keeps naming the same documents. Live only: a dry run clears nothing by
  // design, so every flag being still raised says nothing about drift.
  if (args.live && pendingByPartition) {
    const leftRaised = [];
    for (const ids of pendingByPartition.values()) {
      for (const id of ids) if (!pendingAccounted.has(id)) leftRaised.push(id);
    }
    summary.pendingLeftRaised = leftRaised.length;
    if (leftRaised.length) {
      // Named, not just counted: a count cannot say which rows to repair. Capped, because a
      // systematic fault leaves every flagged document here.
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

  // THE COVERAGE CHECK, the same one `backfill-document-list-ids.js` makes: a partial run that
  // reports success is worse than no run, because nobody re-runs it. On EVERY run, resumed
  // included — a resume is compared on what it walked plus what its checkpoints recorded.
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
 * Exit code for a finished run. A partial backfill must not exit 0: a wrapper would read that as
 * "every chunk filter works now". Partial has four halves, the first two as in
 * `backfill-document-list-ids.js`: a rejected write; a walk that never reached every partition —
 * which a resumed run is NOT exempt from; a pending flag still raised, whether the clear found no
 * row (`pendingMissed`) or the walk never reached the document at all (`pendingLeftRaised`), since
 * the drift line keeps reporting both; and, on a live run only, an orphan purge that
 * did not finish — rows it could not scan and rows the service refused to delete are both index
 * rows that stay unstamped for good. A dry run is not the thing that was going to delete them, so
 * it is not held to that. Short, never merely different: documents deleted between a checkpoint
 * and the resume make `covered` exceed a fresh `expected`, and that is no partition being missed.
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
  // The bucket naming, shared with `backfill-display-name-sort.js`: two walks that disagreed on
  // which partition a null `projectId` belongs to would each report covering rows the other read.
  partitionOf, projectIdOf,
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
