'use strict';

// Purge chunks and clear extraction flags so documents re-enter the work list. Dry run unless --live.
// Flags: --errors-only, --error-like STR (implies it), --page-size N. Run on the devbox via demi-run.

const documents = require('../repositories/documents');
const chunks = require('../repositories/chunks');
const aiSearch = require('../search/ai-search');
const { systemAccess } = require('../helpers/access-sql');

const DEFAULT_PAGE_SIZE = 200;

function parseArgs(argv) {
  const args = { live: false, errorsOnly: false, errorLike: '', pageSize: DEFAULT_PAGE_SIZE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--errors-only') args.errorsOnly = true;
    // Implies --errors-only: a substring to match only makes sense over failures.
    else if (a === '--error-like') { args.errorLike = String(argv[++i] ?? ''); args.errorsOnly = true; }
    else if (a === '--page-size') args.pageSize = parseInt(argv[++i], 10);
    else throw new Error(`[purge] unknown argument: ${a}`);
  }
  // An empty substring matches every error: the operator asked to narrow and would get it all.
  if (argv.includes('--error-like') && !args.errorLike) {
    throw new Error('[purge] --error-like needs a non-empty substring');
  }
  if (!Number.isInteger(args.pageSize) || args.pageSize < 1) {
    throw new Error(`[purge] --page-size must be a positive integer, got: ${args.pageSize}`);
  }
  return args;
}

/** The flags `ingestChunks` writes on success, inverted; `contentExtracted: false` requeues the document. */
const CLEARED_EXTRACTION = {
  contentExtracted: false,
  contentExtractedAt: null,
  contentPageCount: 0,
  contentExtractionError: null,
  extractionMethod: null,
  extraction: null,
  // A purge is a fresh start: old ingest failures would hold the rebuilt extraction back.
  chunkIngestFailures: 0,
  chunkIngestFailedAt: null,
  // Nulled: the chunks these described are being deleted.
  pageNumbered: null,
  pageCount: null
};

/** Yield matching documents a page at a time, by continuation token: Cosmos has no cheap offset. */
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

  // systemAccess() is required: a scoped context would delete only the chunks it can see and
  // orphan the rest while the document reads as unextracted.
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

  let selector = 'contentExtracted=true';
  if (args.errorsOnly) selector += ' AND contentExtractionError set';
  if (args.errorLike) selector += ` AND error contains ${JSON.stringify(args.errorLike)}`;
  console.log(`[purge] ${summary.mode}: documents with ${selector}`);

  for await (const page of pageAll(documentsRepo, access, { extracted: true, pageSize: args.pageSize })) {
    for (const doc of page) {
      summary.scanned++;

      // Filtered here: --error-like has no query form. Matching failures still get chunk removal,
      // since a partial write can record an error over an earlier good extraction.
      if (args.errorsOnly && !doc.contentExtractionError) continue;
      // Substring: the error tail carries a URL, filename or byte count, so no two match exactly.
      if (args.errorLike && !String(doc.contentExtractionError).includes(args.errorLike)) continue;

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

      // Best-effort: deleteChunksForDocument logs and returns 0. Nothing else removes index rows,
      // so a failure here leaves searchable text until the purge is re-run.
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
  // Even a dry run reads Cosmos.
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
