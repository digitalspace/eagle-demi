'use strict';

/**
 * Patch the List ObjectIds back onto documents that were seeded before the seed kept them.
 *
 * WHY THEY ARE MISSING. `seed/transform.js` resolved `type` / `milestone` / `projectPhase` to their
 * List LABEL and threw the ObjectId away, and never read `documentAuthorType` at all. eagle-public's
 * document filter panel sends List ObjectIds, never labels (`documents-tab.component.ts:47`), so a
 * row holding only the label has nothing for those values to compare against — the filter matches
 * zero rows under a 200, which reads as "no results" rather than as a broken filter. The transform
 * now keeps both; the ~60,578 rows already in Cosmos predate that and are what this fixes.
 *
 * WHERE THE IDS COME FROM. eagle-api's PUBLIC search — `/api/public/search?dataset=Document`, the
 * same endpoint `src/seed/sources.js` already reads, no Mongo access and no credentials. Confirmed
 * against eagle-dev 2026-08-22: the payload carries `type`, `milestone`, `projectPhase` AND
 * `documentAuthorType` as raw ObjectIds, and `totalCount` is 60,661. So this is recoverable
 * WITHOUT Eagle Mongo. `EAGLE_API_BASE` must point at the SAME eagle-api the seed read, or the ids
 * are from a different corpus; the label lookup (`fetchListLookup`) comes from there too.
 *
 * WHY NOT JUST RE-SEED. A re-seed is idempotent on identity but not on state: `transformDocument`
 * resets `contentExtracted` to false, which would put every extracted document back on the
 * extraction work list and send the whole corpus back through the GPU. A patch touches five fields
 * and nothing else.
 *
 * ORDER OF OPERATIONS. Widened index and widened data-source projection FIRST, then this, THEN a
 * reset + run of `documents-indexer`. Run it the other way round and rows are re-pulled into an
 * index with no field to put them in — silently, since the indexer ignores unmapped source fields.
 * The reset is the part that is easy to skip and expensive to skip: the high-water mark is `_ts`,
 * so a schema-only widening re-pulls NOTHING, and a row this script leaves alone — ids already
 * right, or no List refs at all — never gets a new `_ts` either. Those rows would keep a null
 * `datePosted` in the index and sort last under eagle-public's default `-datePosted` forever. A
 * reset re-pulls all ~60,578; the `current` count below is exactly the population that depends on
 * it.
 *
 * AND THE APP IS LAST OF ALL. `src/controllers/search.js` routes a keywordless search carrying a
 * filter or a sort to the index. Deployed after the index PUT but before this script has run, every
 * such filter answers ZERO rows under a 200 — quieter than the unfiltered-corpus bug it fixes, and
 * therefore easier to ship without noticing. Full order: index, data source, indexer reset, THIS,
 * then the app.
 *
 * **DRY RUN BY DEFAULT.** `--live` is the mutating flag, matching apply-search-definitions.js and
 * purge-extraction.js.
 *
 *   node src/scripts/backfill-document-list-ids.js [--live] [--page-size N] [--batch N]
 *
 * Cosmos is private-endpoint-only and keyless, so a live run must execute INSIDE the app container
 * over the App Service SSH tunnel — not Kudu's /api/command, whose SCM container has no
 * managed-identity endpoint. See README.md for the recipe. It needs no search-service grant: this
 * writes to Cosmos only and the indexer does the rest.
 */

const documents = require('../repositories/documents');
const projects = require('../repositories/projects');
const cosmos = require('../db/cosmos-nosql');
const sources = require('../seed/sources');
const { resolveListLabel, listRefId } = require('../seed/transform');
const { systemAccess } = require('../helpers/access-sql');

const DEFAULT_PAGE_SIZE = 200;

/**
 * Operations per bulk request. 100 is `cosmos-nosql.js`'s `BULK_MAX_OPERATIONS`, which is the
 * Cosmos hard limit, and `bulkVerified` already retries the 429s a smaller batch is meant to
 * avoid — so the code, not the 50 in `.claude/skills/eagle-cosmosdb/SKILL.md`, is what this
 * follows. `--batch` exists to drop to 50 if a run reports a lot of 429s; it can never go above
 * 100, because Cosmos rejects the request outright rather than splitting it.
 */
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
  // The upper bound is not decoration: `_sql.pageOptions` clamps maxItemCount to MAX_PAGE_SIZE, so
  // a larger value is accepted, ignored, and then reported in the summary as the page size that
  // ran — a figure the operator uses to reason about RU cost and progress.
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

/**
 * What an Eagle document says these five fields should be — the same expressions
 * `transformDocument` now uses, called through the same helpers so the two cannot drift.
 */
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
 * Patch operations for one row, or null when it already agrees.
 *
 * `??` rather than a bare `!==`: a seeded row has no `typeId` PROPERTY at all, and a document with
 * no milestone upstream wants `null` — comparing `undefined` to `null` as different would rewrite
 * every row in the corpus with a page of nulls, paying full RU to change nothing. Skipping those
 * is also what makes a re-run after a partial failure cheap.
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
 * @param {object} [opts]  test seam: {documents, sources, bulkVerified, now}
 */
async function backfill(argv = [], opts = {}) {
  const args = parseArgs(argv);
  const documentsRepo = opts.documents || documents;
  const projectsRepo = opts.projects || projects;
  const src = opts.sources || sources;
  // documentsRepo, not the module: a caller who injects a repository seam and not a write seam
  // would otherwise read from the injected container and write to the real one.
  const write = opts.bulkVerified ||
    ((operations) => cosmos.bulkVerified(documentsRepo.CONTAINER, operations));
  const now = opts.now || new Date().toISOString();

  // systemAccess() is mandatory, not a convenience: a scoped or public context would list only the
  // documents it can SEE, and the unlisted ones would be silently left unfilterable — a partial
  // backfill that reports success is worse than none, because nobody re-runs it.
  const access = systemAccess();

  const summary = {
    mode: args.live ? 'live' : 'dry-run',
    scanned: 0,
    unmatched: 0,
    current: 0,
    planned: 0,
    patched: 0,
    failed: 0,
    statusCounts: {},
    requestCharge: 0
  };

  const listLookup = await src.fetchListLookup();

  // PASS A: the ids, keyed by Eagle _id — which IS the Cosmos row id for everything the seed
  // wrote, so the join needs no lookup table. Five short strings per document rather than the raw
  // payload: the seed streams because holding 60,661 raw payloads peaked near 250 MB on a 1.5 GB
  // plan, and this trimmed map is ~25 MB.
  const byEagleId = new Map();
  const eagle = await src.streamEagleDocuments((items) => {
    for (const d of items) {
      if (d && d._id) byEagleId.set(String(d._id), listFieldsFor(d, listLookup));
    }
  });
  console.log(`[backfill] ${byEagleId.size} eagle documents read (upstream reports ${eagle.total})`);

  // PASS B: page Cosmos and patch. Grouped by partition because a bulk request cannot span
  // partition keys, and flushed at `--batch` so one busy project does not accumulate unboundedly.
  const pending = new Map();
  const flush = async (projectId) => {
    const operations = pending.get(projectId) || [];
    pending.delete(projectId);
    if (operations.length === 0) return;
    const result = await write(operations);
    summary.patched += result.succeeded || 0;
    summary.failed += result.failed || 0;
    summary.requestCharge += result.requestCharge || 0;
    for (const [status, n] of Object.entries(result.statusCounts || {})) {
      summary.statusCounts[status] = (summary.statusCounts[status] || 0) + n;
    }
  };

  // ONE QUERY PER PARTITION, not one paged query over all of them. MEASURED 2026-08-22 against
  // demi-cosmos-test: the cross-partition `ORDER BY c.id ASC` read returns its first page with
  // **no continuation token at all**, so a `do … while (continuationToken)` loop stops after
  // `--page-size` rows and reports success — 200 of 60,578 patched, and nothing says so. That is
  // the exact failure mode this script's own `unmatched` counter exists to prevent, one level up.
  //
  // A partition read needs no token: it is pinned to one project, so `listVisible` fetches it whole
  // (`cosmos.query` runs `fetchAll` when no `maxItemCount` is given) and the largest partition here
  // is ~850 documents. It is also the cheaper query — a pinned read never fans out — and the writes
  // were already grouped this way, because a bulk request cannot span partition keys.
  //
  // `''` is a real partition, not a guard: documents with no project live there.
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
        // In Cosmos, absent from Eagle — deleted upstream since the seed, or seeded from a
        // different eagle-api. Counted rather than guessed at: fabricating nulls here would erase
        // ids a later run could still recover.
        summary.unmatched++;
        continue;
      }
      const ops = planPatch(doc, fields, now);
      if (!ops) { summary.current++; continue; }
      summary.planned++;
      if (!args.live) continue;

      const pk = String(doc.projectId);
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

  // THE COVERAGE CHECK, and it is the point of this script having a summary at all. A partial run
  // that reports success is worse than no run, because nobody re-runs it — so compare what was
  // walked against the same predicate counted directly, and say so loudly when they disagree.
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
    `${summary.requestCharge.toFixed(0)} RU${suffix}`
  );
  if (summary.failed) {
    console.error(`[backfill] statuses: ${JSON.stringify(summary.statusCounts)}`);
  }

  return summary;
}

module.exports = { parseArgs, listFieldsFor, planPatch, backfill, BACKFILLED, DEFAULT_BATCH };

if (require.main === module) {
  const { initCosmosClient } = require('../db/cosmos-nosql');
  initCosmosClient();

  backfill(process.argv.slice(2))
    .then(summary => {
      // A partial backfill must not exit 0 — a wrapper would read that as "every filter works now".
      process.exit(summary.failed ? 1 : 0);
    })
    .catch(err => {
      console.error('[backfill] Fatal:', err);
      process.exit(1);
    });
}
