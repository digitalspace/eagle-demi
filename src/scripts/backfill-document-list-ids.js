'use strict';

/**
 * Patch List ObjectIds onto documents seeded with labels only. Dry run unless `--live`; runs on the
 * devbox. Order: index, data source, this, indexer reset, app; wiki [[Chunk-Parent-Field-Backfill]].
 */

const documents = require('../repositories/documents');
const projects = require('../repositories/projects');
const chunks = require('../repositories/chunks');
const cosmos = require('../db/cosmos-nosql');
const sources = require('../seed/sources');
const { resolveListLabel, listRefId } = require('../seed/transform');
const { systemAccess } = require('../helpers/access-sql');

const DEFAULT_PAGE_SIZE = 200;

// The Cosmos bulk limit; larger requests are rejected, not split. `--batch` can go lower on 429s.
const DEFAULT_BATCH = cosmos.BULK_MAX_OPERATIONS;

/** `_sql.pageOptions` clamps `maxItemCount` here; asking for more silently gets this instead. */
const MAX_PAGE_SIZE = 1000;

/** The fields this backfill owns. Nothing else on the row is touched. */
const BACKFILLED = [
  'typeId', 'milestoneId', 'projectPhaseId', 'documentAuthorType', 'documentAuthorTypeId'
];

function parseArgs(argv) {
  const args = { live: false, pageSize: DEFAULT_PAGE_SIZE, batch: DEFAULT_BATCH };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--page-size') args.pageSize = parseInt(argv[++i], 10);
    else if (a === '--batch') args.batch = parseInt(argv[++i], 10);
    else throw new Error(`[backfill] unknown argument: ${a}`);
  }
  // A larger value would be clamped silently and then misreported as the page size that ran.
  if (!Number.isInteger(args.pageSize) || args.pageSize < 1 || args.pageSize > MAX_PAGE_SIZE) {
    throw new Error(
      `[backfill] --page-size must be between 1 and ${MAX_PAGE_SIZE}, got: ${args.pageSize}`);
  }
  if (!Number.isInteger(args.batch) || args.batch < 1 || args.batch > cosmos.BULK_MAX_OPERATIONS) {
    throw new Error(
      `[backfill] --batch must be between 1 and ${cosmos.BULK_MAX_OPERATIONS}, got: ${args.batch}`);
  }
  return args;
}

/** Same helpers as `transformDocument`, so the two cannot drift. */
function listFieldsFor(eagleDoc, listLookup) {
  return {
    typeId: listRefId(eagleDoc.type),
    milestoneId: listRefId(eagleDoc.milestone),
    projectPhaseId: listRefId(eagleDoc.projectPhase),
    documentAuthorType: resolveListLabel(eagleDoc.documentAuthorType, listLookup),
    documentAuthorTypeId: listRefId(eagleDoc.documentAuthorType)
  };
}

/**
 * Patch operations for one row, or null when it agrees. `??` treats a missing property as null, so
 * rows that only lack the key are not rewritten.
 */
function planPatch(doc, fields, now) {
  const changed = Object.entries(fields).filter(([key, value]) => (doc[key] ?? null) !== value);
  if (changed.length === 0) return null;
  return [
    ...changed.map(([key, value]) => ({ op: 'set', path: `/${key}`, value })),
    { op: 'set', path: '/updatedAt', value: now }
  ];
}

/**
 * @param {string[]} argv
 * @param {object} [opts]  test seam: {documents, sources, chunks, bulkVerified, now}
 */
async function backfill(argv = [], opts = {}) {
  const args = parseArgs(argv);
  const documentsRepo = opts.documents || documents;
  const projectsRepo = opts.projects || projects;
  const src = opts.sources || sources;
  const chunksRepo = opts.chunks || chunks;
  // documentsRepo, not the module, so an injected repository is also the one written to.
  const write = opts.bulkVerified ||
    ((operations) => cosmos.bulkVerified(documentsRepo.CONTAINER, operations));
  const now = opts.now || new Date().toISOString();

  // A scoped context would see only some documents and report a partial run as success.
  const access = systemAccess();

  const summary = {
    mode: args.live ? 'live' : 'dry-run',
    scanned: 0,
    unmatched: 0,
    current: 0,
    planned: 0,
    patched: 0,
    failed: 0,
    // Documents, then chunk operations: one document is about 19 of them.
    documentsReStamped: 0,
    reStampFailedDocuments: 0,
    reStampFailedChunks: 0,
    // Row write rejected, so chunks were left alone; a re-run does both together.
    reStampSkipped: 0,
    // In a dry run, the rows that would be flagged.
    pendingRaised: 0,
    pendingCleared: 0,
    pendingConflicts: 0,
    pendingMissed: 0,
    // Ids, not a count, so they can be repaired.
    pendingLeftRaised: [],
    statusCounts: {},
    requestCharge: 0
  };

  const listLookup = await src.fetchListLookup();

  // Keyed by Eagle _id, which is the Cosmos row id. Holds five short strings per document, not the
  // raw payload, to keep memory low.
  const byEagleId = new Map();
  const eagle = await src.streamEagleDocuments((items) => {
    for (const d of items) {
      if (d && d._id) byEagleId.set(String(d._id), listFieldsFor(d, listLookup));
    }
  });
  console.log(`[backfill] ${byEagleId.size} eagle documents read (upstream reports ${eagle.total})`);

  // Grouped by partition because a bulk request cannot span partition keys.
  const pending = new Map();
  // Chunks copy the List refs and nothing else refreshes them. Only documents whose fields moved,
  // and only after their row write landed.
  const pendingReStamp = new Map();
  // partition -> newest pending token, which guards its chunk patches.
  const pendingStampedAt = new Map();
  let reStampErrorsLogged = 0;
  const reStamp = async (projectId, failedIds = []) => {
    const docs = pendingReStamp.get(projectId) || [];
    const stampedAt = pendingStampedAt.get(projectId);
    pendingReStamp.delete(projectId);
    pendingStampedAt.delete(projectId);
    // `failedIds` are the rows Cosmos rejected; their chunks are skipped.
    const result = await chunksRepo.reStampAfterWrite(access, docs, failedIds, {
      // Newer-only: a slow partition cannot put stale values back.
      stampedAt,
      // console, not the logger: run by hand on the devbox, its output is the report.
      onError: (doc, err) => {
        if (++reStampErrorsLogged <= chunks.MAX_LOGGED_RESTAMP_ERRORS) {
          console.error(`[backfill] chunk re-stamp failed for ${doc.id}: ${err.message}`);
        }
      }
    });
    summary.documentsReStamped += result.stamped;
    summary.reStampFailedDocuments += result.failedDocuments;
    summary.reStampFailedChunks += result.failedChunks;
    summary.reStampSkipped += result.skipped;

    // Guarded on this run's token: a write that landed meanwhile owns a newer flag, which must stay.
    const stamped = new Map(docs.map(d => [String(d.id), d]));
    for (const id of result.stampedDocumentIds) {
      // The row's own projectId, never the bucket name.
      const doc = stamped.get(String(id));
      const outcome = await documentsRepo.setParentFieldsPending(
        doc.id, doc.projectId, false, { pendingAt: doc.parentFieldsPendingAt });
      if (outcome.status === 'cleared') summary.pendingCleared++;
      else if (outcome.status === 'conflict') summary.pendingConflicts++;
      else summary.pendingMissed++;
    }
    // Left raised deliberately: their chunks hold a mix of old and new values, which is the state
    // the repair exists for.
    summary.pendingLeftRaised.push(...result.failedDocumentIds);
  };
  const flush = async (projectId) => {
    const operations = pending.get(projectId) || [];
    pending.delete(projectId);
    if (operations.length === 0) {
      await reStamp(projectId);
      return;
    }
    const result = await write(operations);
    summary.patched += result.succeeded || 0;
    summary.failed += result.failed || 0;
    summary.requestCharge += result.requestCharge || 0;
    for (const [status, n] of Object.entries(result.statusCounts || {})) {
      summary.statusCounts[status] = (summary.statusCounts[status] || 0) + n;
    }
    await reStamp(projectId, result.failedIds || []);
  };

  // One query per partition: a cross-partition `ORDER BY` read returns no continuation token, so
  // paging stops after one page. `''` is a real partition holding documents with no project.
  const projectPage = await projectsRepo.listVisible(access, {});
  const partitions = ['', ...projectPage.items.map(p => String(p.id))];
  const expected = await documentsRepo.countVisible(access, { sourceSystem: 'eagle' });

  for (const partition of partitions) {
    const page = await documentsRepo.listVisible(access, {
      sourceSystem: 'eagle', projectId: partition
    });

    for (const doc of page.items) {
      summary.scanned++;
      const fields = byEagleId.get(String(doc.id));
      if (!fields) {
        // Not in Eagle: counted, not nulled, so a later run can still recover the ids.
        summary.unmatched++;
        continue;
      }
      const ops = planPatch(doc, fields, now);
      if (!ops) { summary.current++; continue; }
      summary.planned++;
      const merged = { ...doc, ...fields };
      const moved = chunksRepo.parentFieldsChanged(doc, merged);
      // Counted before the write, so a dry run reports it too.
      if (moved) summary.pendingRaised++;
      if (!args.live) continue;

      const pk = String(doc.projectId);
      if (moved) {
        // Flag raised in the same patch as the ids, as the API write path does, so a killed run
        // stays visible to the reconcile. No etag guard: offline maintenance, nothing else writes.
        const raise = documentsRepo.pendingRaiseOps(doc.parentFieldsPendingAt);
        ops.push(
          { op: 'set', path: '/parentFieldsPending', value: raise.parentFieldsPending },
          { op: 'set', path: '/parentFieldsPendingAt', value: raise.parentFieldsPendingAt }
        );
        merged.parentFieldsPendingAt = raise.parentFieldsPendingAt;
        const restamps = pendingReStamp.get(pk) || [];
        restamps.push(merged);
        pendingReStamp.set(pk, restamps);
        // Newest token wins, so the stamp is at least as current as every flag in the batch.
        const newest = pendingStampedAt.get(pk);
        if (!newest || merged.parentFieldsPendingAt > newest) {
          pendingStampedAt.set(pk, merged.parentFieldsPendingAt);
        }
      }
      const group = pending.get(pk) || [];
      group.push({ operationType: 'Patch', partitionKey: pk, id: String(doc.id), resourceBody: { operations: ops } });
      pending.set(pk, group);
      if (group.length >= args.batch) await flush(pk);
    }

    if (args.live) await flush(String(partition));
  }

  console.log(
    `[backfill] ${summary.scanned} scanned, ${summary.planned} to patch, ` +
    `${summary.current} already current, ${summary.unmatched} unmatched`
  );

  // A partial run that reports success never gets re-run, so coverage is checked against a count.
  summary.expected = expected;
  if (summary.scanned !== expected) {
    console.log(
      `[backfill] INCOMPLETE: scanned ${summary.scanned} of ${expected} documents. ` +
      `Some partition was not walked — do NOT treat this run as done.`
    );
  }

  for (const projectId of [...pending.keys()]) await flush(projectId);

  const suffix = args.live ? '' : ' (dry run, nothing written)';
  console.log(
    `[backfill] ${summary.planned} of ${summary.scanned} documents need ${BACKFILLED.join(', ')}; ` +
    `${summary.patched} patched, ${summary.failed} failed, ` +
    `${summary.documentsReStamped} documents had their chunks re-stamped, ` +
    `${summary.requestCharge.toFixed(0)} RU${suffix}`
  );
  if (summary.reStampFailedDocuments || summary.reStampFailedChunks) {
    console.error(
      `[backfill] ${summary.reStampFailedDocuments} documents were not fully re-stamped ` +
      `(${summary.reStampFailedChunks} chunk operations rejected; a document whose patch threw ` +
      'reports none) — those chunks still answer the old filter. Run ' +
      'backfill-chunk-parent-fields.js --live to repair.'
    );
  }
  if (summary.reStampSkipped) {
    console.error(
      `[backfill] ${summary.reStampSkipped} documents had their chunk re-stamp SKIPPED because ` +
      'the row write was rejected. Re-run this script; the rows and their chunks land together.'
    );
  }
  if (summary.pendingRaised) {
    console.log(
      `[backfill] ${summary.pendingRaised} documents were flagged parentFieldsPending; ` +
      `${summary.pendingCleared} cleared after their chunks landed, ` +
      `${summary.pendingConflicts} left to a newer write, ${summary.pendingMissed} row gone`
    );
  }
  if (summary.pendingLeftRaised.length) {
    console.error(
      `[backfill] ${summary.pendingLeftRaised.length} documents are still flagged ` +
      `parentFieldsPending (${summary.pendingLeftRaised.slice(0, 20).join(', ')}). They stay on ` +
      'the reconcile line until backfill-chunk-parent-fields.js --pending --live takes them off.'
    );
  }
  if (summary.failed) {
    console.error(`[backfill] statuses: ${JSON.stringify(summary.statusCounts)}`);
  }

  return summary;
}

/** Non-zero on a partial run: a rejected write, or a walk that missed a partition. */
function exitCodeFor(summary) {
  const incomplete = summary.expected !== undefined && summary.scanned !== summary.expected;
  return summary.failed || incomplete ? 1 : 0;
}

module.exports = {
  parseArgs, listFieldsFor, planPatch, backfill, exitCodeFor, DEFAULT_BATCH
};

if (require.main === module) {
  const { initCosmosClient } = require('../db/cosmos-nosql');
  initCosmosClient();

  backfill(process.argv.slice(2))
    .then(summary => {
      process.exit(exitCodeFor(summary));
    })
    .catch(err => {
      console.error('[backfill] Fatal:', err);
      process.exit(1);
    });
}
