'use strict';

/**
 * Purge extracted chunks and reset the extraction flags that hide their documents from the
 * extraction work list.
 *
 * Why this exists: `demi-api-dev` ran the PRE-accumulation chunker until 2026-07-30, so every
 * chunk written before that redeploy is wrong twice over — split per paragraph (~514 characters
 * measured, against a 2,500 target) and missing every section shorter than MIN_CHUNK_SIZE, which
 * the old splitter dropped BEFORE merging. Re-ingesting those documents with the fixed chunker is
 * the only way to get a correct index, and a document is only re-ingested if it looks unextracted.
 *
 * Re-ingest alone would mostly self-clean — chunk ids are deterministic and `replaceForDocument`
 * deletes surplus ids — but only for documents that actually get re-posted. This covers the rest,
 * and is what makes the reset flags truthful rather than aspirational.
 *
 * **DRY RUN BY DEFAULT.** `--live` is required to delete or write anything.
 *
 * `--errors-only` narrows this to documents that RECORDED AN EXTRACTION FAILURE. The extraction
 * host treats a recorded error as done, so ~1,712 valid PDFs are parked as permanent failures and
 * are silently absent from the index. Requeuing them means clearing `contentExtracted` — but a
 * failure sets that flag too (`ingestChunks`, controllers/nosql/document.js), so without this flag
 * the only lever is a blanket purge that deletes every good chunk alongside them.
 *
 * Usage:
 *   node src/scripts/purge-extraction.js [--live] [--errors-only] [--page-size N]
 *
 * Cosmos is private-endpoint-only and keyless, so a live run must execute INSIDE the app
 * container over the App Service SSH tunnel — not Kudu's /api/command, whose SCM container has no
 * managed-identity endpoint. See MIGRATION.md for the full recipe.
 */

const documents = require('../repositories/documents');
const chunks = require('../repositories/chunks');
const aiSearch = require('../search/ai-search');
const { systemAccess } = require('../helpers/access-sql');

const DEFAULT_PAGE_SIZE = 200;

function parseArgs(argv) {
  const args = { live: false, errorsOnly: false, pageSize: DEFAULT_PAGE_SIZE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--errors-only') args.errorsOnly = true;
    else if (a === '--page-size') args.pageSize = parseInt(argv[++i], 10);
    else throw new Error(`[purge] unknown argument: ${a}`);
  }
  if (!Number.isInteger(args.pageSize) || args.pageSize < 1) {
    throw new Error(`[purge] --page-size must be a positive integer, got: ${args.pageSize}`);
  }
  return args;
}

/**
 * The flags `ingestChunks` writes on a successful run, inverted. `contentExtracted: false` is what
 * puts a document back in the work list; the rest would otherwise be stale claims about an
 * extraction whose output has just been deleted.
 */
const CLEARED_EXTRACTION = {
  contentExtracted: false,
  contentExtractedAt: null,
  contentPageCount: 0,
  contentExtractionError: null,
  extractionMethod: null
};

/**
 * Page through the matching documents, yielding one page at a time.
 *
 * A local pager rather than a shared one: the only other implementation lived in the Typesense
 * full sync, which is deleted, and its signature `(repo, access, pageSize)` had no way to carry
 * the `extracted: true` filter anyway. Continuation tokens rather than skip/take, because Cosmos
 * has no efficient offset — page N would cost as much as pages 1..N combined.
 */
async function* pageAll(repo, access, opts) {
  let continuationToken;
  do {
    const result = await repo.listVisible(access, { ...opts, continuationToken });
    if (result.items.length > 0) yield result.items;
    continuationToken = result.continuationToken;
  } while (continuationToken);
}

/**
 * @param {string[]} argv
 * @param {object} [opts]  test seam: {documents, chunks, index}
 */
async function purge(argv = [], opts = {}) {
  const args = parseArgs(argv);
  const documentsRepo = opts.documents || documents;
  const chunksRepo = opts.chunks || chunks;
  const index = opts.index || aiSearch;

  // systemAccess() is mandatory, not a convenience. removeForDocument enumerates ids via
  // idsForDocument, so a scoped or public context would delete only the chunks it can SEE and
  // leave the rest orphaned — with the document flagged unextracted, which reads as success.
  const access = systemAccess();

  const summary = {
    mode: args.live ? 'live' : 'dry-run',
    errorsOnly: args.errorsOnly,
    scanned: 0,
    documents: 0,
    chunksRemoved: 0,
    indexEntriesRemoved: 0,
    failures: []
  };

  const selector = args.errorsOnly
    ? 'contentExtracted=true AND contentExtractionError set'
    : 'contentExtracted=true';
  console.log(`[purge] ${summary.mode}: documents with ${selector}`);

  for await (const page of pageAll(documentsRepo, access, { extracted: true, pageSize: args.pageSize })) {
    for (const doc of page) {
      summary.scanned++;

      // Filtered here rather than in the query: `buildCriteria` has no error predicate, and adding
      // one means new SQL surface for a one-off admin run over the ~4% of the corpus that is
      // extracted at all. The page is already in hand.
      //
      // Chunk removal still runs for the documents that DO match. A recorded failure usually wrote
      // no chunks, so it is a no-op — but the partial-write path records an error over an earlier
      // successful extraction, and skipping removal there would flag a document unextracted while
      // its chunks are still present. That is the exact state the catch below refuses to create.
      if (args.errorsOnly && !doc.contentExtractionError) continue;

      summary.documents++;

      if (!args.live) {
        // Count what WOULD go, so a dry run reports a real number rather than a document count.
        try {
          const ids = await chunksRepo.idsForDocument(access, doc.id);
          summary.chunksRemoved += ids.length;
        } catch (err) {
          summary.failures.push({ id: doc.id, stage: 'count', message: err.message });
        }
        continue;
      }

      try {
        const result = await chunksRepo.removeForDocument(access, doc.id);
        summary.chunksRemoved += result.succeeded || 0;
        if (result.failed) {
          summary.failures.push({ id: doc.id, stage: 'chunks', message: `${result.failed} bulk operation(s) failed` });
        }
      } catch (err) {
        // Leave the flags alone: a document whose chunks are still present must not be advertised
        // as unextracted, or re-ingest would reconcile against chunks nobody knows are there.
        summary.failures.push({ id: doc.id, stage: 'chunks', message: err.message });
        continue;
      }

      try {
        await documentsRepo.patchExtraction(doc.id, doc.projectId, CLEARED_EXTRACTION);
      } catch (err) {
        summary.failures.push({ id: doc.id, stage: 'flags', message: err.message });
        continue;
      }

      // Best-effort by design, like the DELETE /documents/:id path: the chunks are already gone
      // from Cosmos and the next full sync reconciles via alias swap, so an index failure must not
      // turn a successful purge into a failed one.
      summary.indexEntriesRemoved += await index.deleteChunksForDocument(doc.id);
    }

    console.log(
      `[purge] ${summary.documents} of ${summary.scanned} scanned, ` +
      `${summary.chunksRemoved} chunks so far`
    );
  }

  const suffix = args.live ? '' : ' (dry run, nothing written)';
  console.log(
    `[purge] ${summary.documents} documents of ${summary.scanned} scanned, ` +
    `${summary.chunksRemoved} chunks, ${summary.indexEntriesRemoved} index entries${suffix}`
  );
  if (summary.failures.length) {
    console.error(`[purge] ${summary.failures.length} failure(s):`);
    for (const f of summary.failures.slice(0, 20)) {
      console.error(`  ${f.id} [${f.stage}] ${f.message}`);
    }
  }

  return summary;
}

module.exports = { parseArgs, purge, CLEARED_EXTRACTION };

if (require.main === module) {
  // Always connect: unlike the seed, even a dry run reads from Cosmos, so there is no offline
  // mode to preserve. It still writes nothing without --live.
  const { initCosmosClient } = require('../db/cosmos-nosql');
  initCosmosClient();

  purge(process.argv.slice(2))
    .then(summary => {
      // A partial purge must not exit 0 — a wrapper would read that as "safe to start ingest".
      process.exit(summary.failures.length ? 1 : 0);
    })
    .catch(err => {
      console.error('[purge] Fatal:', err);
      process.exit(1);
    });
}
