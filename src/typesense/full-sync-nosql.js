'use strict';

/**
 * Full sync: Cosmos NoSQL -> Typesense, zero-downtime via collection aliases.
 *
 * Replaces full-sync.js (MongoDB driver) during the migration; both exist until the cutover.
 *
 * Per schema:
 *   1. create a new timestamped collection (e.g. `documents_20260730020000`)
 *   2. page every item out of Cosmos with a continuation token and import in batches
 *   3. refuse the swap if the new collection is dramatically smaller than the live one
 *   4. point the alias at the new collection, then drop the old one
 *
 * WHAT WAS DELETED RATHER THAN PORTED, and why each would have broken the first real sync:
 *
 *   - **The `List` lookup and `MIN_LOOKUP_SIZE` guard.** DEMI has no `List` collection; labels are
 *     resolved at seed time. The guard demands >= 50 entries in production, so it would have
 *     hard-aborted every production sync.
 *   - **The PCP lookup**, plus `transformRecentActivity` and `transformProjectNotification`. Those
 *     transforms are in TRANSFORMS but not in SCHEMAS, and the sync iterates SCHEMAS — they were
 *     unreachable, and the lookup existed only for them.
 *   - **The `epic` collection fallbacks.** Each schema probed `projects`/`documents`, and on a zero
 *     count re-queried a catch-all `epic` collection by `_schemaName`. There is no `epic`
 *     container, and a fallback that fires on an empty result turns "the seed failed" into
 *     "silently indexed something else".
 *   - **The three-way chunk probe** (`document_chunks` -> `documentchunks` -> `epic`), a workaround
 *     for two writers disagreeing on a collection name.
 *   - **The `test`-database fallback.** Connecting to a *different database* because the
 *     configured one looked empty is how a dev sync ends up indexing another environment's data.
 *
 * Kept, because each earns its place: the alias swap, the orphan purge, the disk pre-flight, the
 * 80%-of-previous count guard, and the import retry.
 */

require('dotenv').config();

const { getClient } = require('./typesenseClient');
const { SCHEMAS } = require('./collections');
const { transformItem, buildProjectLookup } = require('./transform-nosql');
const { systemAccess } = require('../helpers/access-sql');

const projectsRepo = require('../repositories/projects');
const documentsRepo = require('../repositories/documents');
const recordsRepo = require('../repositories/records');
const chunksRepo = require('../repositories/chunks');

/** Cosmos page size. Chunks carry a large `content` field, so they page smaller. */
const PAGE_SIZES = { DocumentChunk: 100, default: 500 };

/**
 * Typesense import batch size.
 *
 * Chunks import in 500s, not 100s: at ~1.9M rows the difference is ~3,800 requests instead of
 * ~19,000, and the run has to fit a manual session rather than the 10-minute Y1 function timeout.
 * 500 chunks is ~1.25 MB per request, which is comfortable inside the 224 MB heap the app
 * container runs with.
 */
const BATCH_SIZES = { DocumentChunk: 500, default: 500 };

/** Where each schema's items come from. */
const SOURCES = {
  Project: { repo: projectsRepo },
  Document: { repo: documentsRepo },
  Record: { repo: recordsRepo },
  DocumentChunk: { repo: chunksRepo }
};

/** Projects must be indexed first: children denormalise the project name, region and ACL. */
const SYNC_ORDER = ['Project', 'Document', 'Record', 'DocumentChunk'];

async function importBatch(typesense, collectionName, docs, maxRetries = 3) {
  if (docs.length === 0) return 0;

  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const results = await typesense.collections(collectionName).documents()
        .import(docs, { action: 'upsert' });
      const failures = results.filter(r => !r.success);
      if (failures.length > 0) {
        console.warn(`  ${failures.length} import failures in ${collectionName}:`,
          failures.slice(0, 3).map(f => f.error));
      }
      return docs.length - failures.length;
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        const wait = attempt * 10000;
        console.warn(`  [importBatch] attempt ${attempt} failed: ${err.message}. ` +
          `Retrying in ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

/**
 * Drop timestamped collections left behind by previous failed syncs.
 * They otherwise accumulate in Typesense memory and slow server startup.
 */
async function purgeOrphanCollections(typesense, alias, keepNames) {
  try {
    const all = await typesense.collections().retrieve();
    const orphans = all.map(c => c.name)
      .filter(name => (name === alias || name.startsWith(alias + '_')) && !keepNames.has(name));
    if (orphans.length === 0) return;

    console.log(`  purging ${orphans.length} orphan collection(s) for "${alias}"...`);
    for (const name of orphans) {
      try {
        await typesense.collections(name).delete();
      } catch (err) {
        console.warn(`  could not purge ${name}: ${err.message}`);
      }
    }
  } catch (err) {
    console.warn(`  orphan purge failed (non-fatal): ${err.message}`);
  }
}

/**
 * Page every item out of a repository, yielding one page at a time.
 *
 * Continuation tokens, not skip/take: Cosmos has no efficient offset, so page N would cost as
 * much as pages 1..N combined. Nothing is accumulated — a full document sync is 60,578 items and
 * the API runs on a 1.5 GB Consumption plan.
 */
async function* pageAll(repo, access, pageSize) {
  let continuationToken;
  do {
    const result = await repo.listVisible(access, { pageSize, continuationToken });
    if (result.items.length > 0) yield result.items;
    continuationToken = result.continuationToken;
  } while (continuationToken);
}

/**
 * Parent metadata and ACL for every document, keyed by id.
 *
 * Only the six fields transformDocumentChunk actually reads are retained — holding whole document
 * items would multiply the footprint for no gain. Reuses documentsRepo.listVisible and the existing
 * pageAll generator, so nothing accumulates beyond the Map itself.
 */
async function buildDocumentLookup(repo, access) {
  const lookup = new Map();
  for await (const items of pageAll(repo, access, PAGE_SIZES.default)) {
    for (const doc of items) {
      lookup.set(String(doc.id), {
        type: doc.type,
        milestone: doc.milestone,
        datePosted: doc.datePosted,
        region: doc.region,
        displayName: doc.displayName || doc.documentFileName,
        read: doc.read
      });
    }
  }
  return lookup;
}

async function syncSchema(typesense, schemaName, schema, ctx) {
  const source = SOURCES[schemaName];

  if (!source || !source.repo) {
    console.log(`\n[${schemaName}] skipped — ${source ? source.reason : 'no source configured'}`);
    return { schemaName, skipped: true, imported: 0 };
  }

  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const newCollection = `${schema.name}_${timestamp}`;
  const alias = schema.name;

  console.log(`\n[${schemaName}] creating collection: ${newCollection}`);
  await typesense.collections().create({ ...schema, name: newCollection });

  let oldCollection = null;
  try {
    oldCollection = (await typesense.aliases(alias).retrieve()).collection_name;
  } catch {
    // First run — no alias yet.
  }

  await purgeOrphanCollections(
    typesense, alias, new Set([oldCollection, newCollection].filter(Boolean))
  );

  try {
    return await buildAndSwap(typesense, schemaName, { alias, newCollection, oldCollection }, ctx);
  } catch (err) {
    // Drop the half-built collection on the way out. The entry purge above only reconciles on the
    // NEXT run of this schema, so without this a failed chunk sync leaves a multi-GB collection
    // resident in Typesense RAM until someone runs the sync again — and RAM is the binding
    // resource here. The 80%-guard below already did this for its own case; this covers the rest.
    //
    // This cannot help a SIGKILL (a Y1 function timeout runs no JS). The entry purge remains the
    // backstop for that, which is why both exist.
    try {
      await typesense.collections(newCollection).delete();
      console.warn(`[${schemaName}] sync failed — dropped partial collection ${newCollection}`);
    } catch { /* best effort: the throw below is the real outcome */ }
    throw err;
  }
}

/**
 * Fill `newCollection` and swap the alias onto it. Split out of syncSchema only so a failure has
 * somewhere to catch — the partial collection has to be dropped, and wrapping fifty lines in a
 * try block to say that reads worse than a named function.
 */
async function buildAndSwap(typesense, schemaName, { alias, newCollection, oldCollection }, ctx) {
  const source = SOURCES[schemaName];
  const pageSize = PAGE_SIZES[schemaName] ?? PAGE_SIZES.default;
  const batchSize = BATCH_SIZES[schemaName] ?? BATCH_SIZES.default;

  let batch = [];
  let total = 0;
  let skipped = 0;

  for await (const items of pageAll(source.repo, ctx.access, pageSize)) {
    for (const item of items) {
      const transformed = transformItem(schemaName, item, ctx.lookups);
      if (!transformed) { skipped++; continue; }
      batch.push(transformed);

      if (batch.length >= batchSize) {
        total += await importBatch(typesense, newCollection, batch);
        batch = [];
        process.stdout.write(`  imported ${total}...\r`);
        // Yield so V8 can GC between batches.
        await new Promise(r => setImmediate(r));
      }
    }
  }
  if (batch.length > 0) total += await importBatch(typesense, newCollection, batch);

  console.log(`\n[${schemaName}] imported ${total} into ${newCollection}` +
    (skipped ? ` (${skipped} skipped by the transform)` : ''));

  // Refuse the swap if the new collection is dramatically smaller than the live one. This catches
  // a partial read: swapping would replace good data with an incomplete index, and search would
  // silently start missing results.
  if (oldCollection) {
    let oldCount = 0;
    try {
      oldCount = (await typesense.collections(oldCollection).retrieve()).num_documents || 0;
    } catch {
      // Old collection may be gone — treat as first run.
    }
    if (oldCount > 0 && total < oldCount * 0.8) {
      try { await typesense.collections(newCollection).delete(); } catch { /* best effort */ }
      throw new Error(
        `[${schemaName}] new collection has ${total} docs but the live one has ${oldCount}. ` +
        'Refusing to swap the alias — under 80% of the previous size. Check Cosmos connectivity ' +
        'and that the seed completed.'
      );
    }
  }

  await typesense.aliases().upsert(alias, { collection_name: newCollection });
  console.log(`[${schemaName}] alias "${alias}" -> "${newCollection}"`);

  if (oldCollection && oldCollection !== newCollection) {
    try {
      await typesense.collections(oldCollection).delete();
      console.log(`[${schemaName}] dropped old collection: ${oldCollection}`);
    } catch (err) {
      console.warn(`[${schemaName}] could not drop ${oldCollection}: ${err.message}`);
    }
  }

  return { schemaName, skipped: false, imported: total, transformSkipped: skipped };
}

/**
 * Verify Typesense has room for a swap, which holds the old and new collections at once — so peak
 * usage is roughly twice the current data.
 */
async function diskPreflight(typesense) {
  try {
    const metrics = await typesense.metrics.retrieve();
    const total = Number(metrics.system_disk_total_bytes);
    const used = Number(metrics.system_disk_used_bytes);
    if (!Number.isFinite(total) || !Number.isFinite(used) || total <= 0) {
      console.warn('Disk pre-flight skipped (metrics unusable)');
      return;
    }

    const freeGiB = (total - used) / (1024 ** 3);
    const minFreeGiB = parseFloat(process.env.TYPESENSE_MIN_FREE_GIB || '20');
    console.log(`Disk pre-flight: ${freeGiB.toFixed(1)} GiB free ` +
      `(${((used / total) * 100).toFixed(1)}% used)`);

    if (freeGiB < minFreeGiB) {
      throw new Error(
        `Pre-flight disk check failed: ${freeGiB.toFixed(1)} GiB free, need >= ${minFreeGiB} GiB ` +
        'for a zero-downtime collection swap. Expand the PVC or run POST /operations/db/compact.'
      );
    }
  } catch (err) {
    if (err.message.startsWith('Pre-flight')) throw err;
    // Older Typesense builds do not expose system_disk_* — warn, do not abort.
    console.warn(`Disk pre-flight skipped (metrics unavailable): ${err.message}`);
  }
}

/**
 * Verify Typesense has RAM for a swap. Disk is not the binding resource — Typesense holds every
 * INDEXED field in memory, so a chunk corpus runs out of RAM long before it runs out of disk, and
 * `diskPreflight` above will happily wave that through.
 *
 * **`system_memory_total_bytes` is the wrong number and must not be used here.** Measured on the
 * live dev container it reports **16.77 GB** — the underlying Container Apps node, not the 4 GiB
 * the container is actually limited to. A guard built on it is wrong by 4x in the unsafe
 * direction. `typesense_memory_resident_bytes` is what Typesense itself holds; the ceiling has to
 * be supplied, because nothing in the metrics endpoint exposes the cgroup limit.
 *
 * The 2x factor is the same one diskPreflight uses and for the same reason: an alias swap holds
 * the old and new collections at once.
 */
async function memoryPreflight(typesense) {
  const limitGiB = parseFloat(process.env.TYPESENSE_MEMORY_LIMIT_GIB || '');
  if (!Number.isFinite(limitGiB) || limitGiB <= 0) {
    console.warn(
      'Memory pre-flight SKIPPED: set TYPESENSE_MEMORY_LIMIT_GIB to the container memory limit ' +
      '(azure/modules/container-apps.bicep). It cannot be inferred — system_memory_total_bytes ' +
      'reports the host node, not the container, and would overstate headroom several times over.'
    );
    return;
  }

  try {
    const metrics = await typesense.metrics.retrieve();
    const resident = Number(metrics.typesense_memory_resident_bytes);
    if (!Number.isFinite(resident) || resident <= 0) {
      console.warn('Memory pre-flight skipped (metrics unusable)');
      return;
    }

    const residentGiB = resident / (1024 ** 3);
    const peakGiB = residentGiB * 2;
    console.log(`Memory pre-flight: ${residentGiB.toFixed(2)} GiB resident, ` +
      `~${peakGiB.toFixed(2)} GiB peak during swap, limit ${limitGiB} GiB`);

    if (peakGiB > limitGiB) {
      throw new Error(
        `Pre-flight memory check failed: ${residentGiB.toFixed(2)} GiB resident implies ` +
        `~${peakGiB.toFixed(2)} GiB during the alias swap, over the ${limitGiB} GiB limit. ` +
        'An OOM here kills the container mid-sync with no error in the log. Raise the container ' +
        'memory, or cut the row count with TARGET_CHUNK_SIZE — more disk will not help.'
      );
    }
  } catch (err) {
    if (err.message.startsWith('Pre-flight')) throw err;
    console.warn(`Memory pre-flight skipped (metrics unavailable): ${err.message}`);
  }
}

async function fullSync(opts = {}) {
  const typesense = opts.typesense || getClient();
  const repos = opts.repos || {};
  if (repos.projects) SOURCES.Project.repo = repos.projects;
  if (repos.documents) SOURCES.Document.repo = repos.documents;
  if (repos.records) SOURCES.Record.repo = repos.records;
  if (repos.chunks) SOURCES.DocumentChunk.repo = repos.chunks;

  console.log('Starting full sync (Cosmos NoSQL -> Typesense):', new Date().toISOString());

  await diskPreflight(typesense);
  await memoryPreflight(typesense);

  // The one access context that reads every item regardless of ACL. It resolves through
  // readClause like any other caller rather than bypassing the predicate — see systemAccess.
  const access = systemAccess();

  // ~393 projects, so this is cheap. The document lookup is NOT built here — it is ~60,578
  // entries and only the chunk sync needs it, so it is built lazily below and dropped after.
  const projectPage = await SOURCES.Project.repo.listVisible(access, { pageSize: 1000 });
  const lookups = { projects: buildProjectLookup(projectPage.items), documents: new Map() };
  console.log(`Project lookup: ${lookups.projects.size} entries`);

  if (lookups.projects.size === 0) {
    // The Mongo version responded to an empty result by querying a different collection, and then
    // a different database. Both turned "the data is missing" into "index something else".
    throw new Error(
      'Project lookup is empty — refusing to sync. Every child document denormalises the project ' +
      'name and ACL, so an empty lookup would index the whole corpus with no project context. ' +
      'Check COSMOS_ENDPOINT and that the seed completed.'
    );
  }

  const results = [];
  for (const schemaName of SYNC_ORDER) {
    const schema = SCHEMAS[schemaName];
    if (!schema) continue;

    // Chunks denormalise their parent document's metadata AND inherit its ACL, which is read
    // LIVE here rather than snapshotted onto each chunk — that is what makes an unpublish
    // propagate for free instead of needing a fan-out patch across every chunk.
    // Built lazily so ~40 MB is not held during the much heavier Document pass.
    if (schemaName === 'DocumentChunk' && SOURCES.DocumentChunk.repo) {
      lookups.documents = await buildDocumentLookup(SOURCES.Document.repo, access);
      const heapMb = Math.round(process.memoryUsage().heapUsed / 1048576);
      console.log(`\nDocument lookup: ${lookups.documents.size} entries (heap ${heapMb} MB)`);

      if (lookups.documents.size === 0) {
        // Same reasoning as the project guard: every chunk inherits its parent's ACL from this
        // map, so an empty one would index document text with no visibility constraint at all.
        throw new Error(
          'Document lookup is empty — refusing to sync chunks. Every chunk inherits its parent ' +
          "document's ACL and metadata from this lookup, so an empty lookup would index " +
          'extracted text with no parent constraint.'
        );
      }
    }

    results.push(await syncSchema(typesense, schemaName, schema, { access, lookups }));

    // Release the lookup as soon as the only consumer is done with it.
    if (schemaName === 'DocumentChunk') lookups.documents = new Map();
  }

  console.log('\nFull sync complete:', new Date().toISOString());
  for (const r of results) {
    console.log(`  ${r.schemaName}: ${r.skipped ? 'skipped' : `${r.imported} indexed`}`);
  }
  return results;
}

module.exports = {
  fullSync,
  SOURCES,
  SYNC_ORDER,
  PAGE_SIZES,
  BATCH_SIZES,
  pageAll,
  importBatch,
  purgeOrphanCollections,
  memoryPreflight,
  diskPreflight,
  syncSchema
};

if (require.main === module) {
  const { initCosmosClient } = require('../db/cosmos-nosql');
  initCosmosClient();
  fullSync().catch(err => {
    console.error('Full sync failed:', err);
    process.exit(1);
  });
}
