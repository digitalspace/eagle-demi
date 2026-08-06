'use strict';

/**
 * Remove the phantom projects the NRPTI sync used to invent, and the records pointing at them.
 *
 * Why this exists: until the auto-seed was deleted from `sync-nrpti.js`, an unmatched compliance
 * record caused a project to be CREATED from `item.projectName || item.location` — a synthetic id
 * `8000000 + hash(name) % 1000000`, `projectState: 'Compliance Record Ingest'`, a centroid
 * hardcoded to Victoria, and `read: ['public', …]` so it listed publicly alongside real Track
 * projects. Many of those strings are facilities, locations or record titles. Track owns the
 * registry; nothing else may add to it, and nothing ever removed these.
 *
 * Deleting the records too is REQUIRED, not tidiness. `projectId` is the `records` container's
 * PARTITION KEY, so when the sync runs again and re-ingests the same NRPTI `_id` under a different
 * `projectId`, Cosmos writes a NEW item and the old one is orphaned in the dead partition. Leaving
 * them duplicates every record rather than merely stranding it.
 *
 * The AI Search delete is the half that is easy to skip and expensive to skip. Indexers work off a
 * `_ts` high-water mark and NEVER see deletes, so a phantom project stays searchable forever even
 * once Cosmos is clean.
 *
 * **DRY RUN BY DEFAULT.** `--live` is required to delete anything.
 *
 * Usage:
 *   node src/scripts/purge-nrpti-seeded.js [--live]
 *
 * Cosmos is private-endpoint-only and keyless, so a live run must execute INSIDE the app container
 * over the App Service SSH tunnel — not Kudu's /api/command, whose SCM container has no
 * managed-identity endpoint. See README.md for the full recipe.
 */

const projects = require('../repositories/projects');
const records = require('../repositories/records');
const documents = require('../repositories/documents');
const aiSearch = require('../search/ai-search');
const { systemAccess } = require('../helpers/access-sql');

/** The partition unmatched records used to land in. Swept alongside the seeded projects. */
const UNLINKED_PARTITION = '';

function parseArgs(argv) {
  const args = { live: false };
  for (const a of argv) {
    if (a === '--live') args.live = true;
    else throw new Error(`[purge-nrpti] unknown argument: ${a}`);
  }
  return args;
}

/**
 * Both markers must agree before anything is deleted.
 *
 * `sourceSystem: 'nrpti'` alone is what the query selects on, but it is a provenance field a
 * future importer could legitimately set. `metadata.seededFromNrpti` was written only by the
 * auto-seed. Requiring the pair means a hand-created or differently-sourced NRPTI project is
 * reported and left alone rather than deleted on a name match.
 */
function isSeeded(project) {
  return project.sourceSystem === 'nrpti' && project.metadata?.seededFromNrpti === true;
}

/**
 * @param {string[]} argv
 * @param {object} [opts]  test seam: {projects, records, documents, index}
 */
async function purgeSeeded(argv = [], opts = {}) {
  const args = parseArgs(argv);
  const projectsRepo = opts.projects || projects;
  const recordsRepo = opts.records || records;
  const documentsRepo = opts.documents || documents;
  const index = opts.index || aiSearch;

  // systemAccess() is mandatory. A seeded project carries `read: ['public', …]` today, but a
  // scoped or public context would silently purge only what it can SEE and report a clean run.
  const access = systemAccess();

  const summary = {
    mode: args.live ? 'live' : 'dry-run',
    scanned: 0,
    projectsRemoved: 0,
    recordsRemoved: 0,
    unlinkedRecordsRemoved: 0,
    indexEntriesRemoved: 0,
    notSeeded: [],
    failures: []
  };

  console.log(`[purge-nrpti] ${summary.mode}: projects with sourceSystem='nrpti'`);

  // `listBySourceSystem` fetches all — no continuation token, and the seeded set is small by
  // construction. Reused rather than adding SQL: this is the whole set, since the auto-seed always
  // wrote the top-level field.
  const { items: candidates } = await projectsRepo.listBySourceSystem(access, 'nrpti');

  for (const project of candidates) {
    summary.scanned++;

    if (!isSeeded(project)) {
      // Reported, not deleted. See isSeeded().
      summary.notSeeded.push({ id: project.id, name: project.name });
      continue;
    }

    // A seeded project should own no documents — it was invented to hold compliance records. If
    // one does, something linked real content to a phantom, and deleting it would take that
    // content's project row with it. Refuse and let a human look.
    let documentCount;
    try {
      const { items: docs } = await documentsRepo.listVisible(access, { projectId: project.id });
      documentCount = docs.length;
    } catch (err) {
      summary.failures.push({ id: project.id, stage: 'documents', message: err.message });
      continue;
    }
    if (documentCount > 0) {
      summary.failures.push({
        id: project.id,
        stage: 'documents',
        message: `${documentCount} document(s) belong to this project — not a phantom, refusing to delete`
      });
      continue;
    }

    let recordIds;
    try {
      const { items } = await recordsRepo.listVisible(access, { projectId: project.id });
      recordIds = items.map(r => r.id);
    } catch (err) {
      summary.failures.push({ id: project.id, stage: 'records', message: err.message });
      continue;
    }

    if (!args.live) {
      // Count what WOULD go, so the dry run reports a real record count rather than a project one.
      summary.projectsRemoved++;
      summary.recordsRemoved += recordIds.length;
      continue;
    }

    // Records BEFORE the project. The other order leaves records whose partition names a project
    // that no longer exists, and a failure halfway through would be invisible — nothing lists
    // records by a dead project id.
    let recordFailure = null;
    let removedHere = 0;
    for (const recordId of recordIds) {
      try {
        await recordsRepo.deleteById(recordId, project.id);
        removedHere++;
      } catch (err) {
        recordFailure = err;
        break;
      }
    }
    summary.recordsRemoved += removedHere;
    if (recordFailure) {
      // Leave the project standing: a partition with records in it must keep the row that names
      // it, or the leftovers become unreachable by every list in the app.
      summary.failures.push({ id: project.id, stage: 'records', message: recordFailure.message });
      continue;
    }

    try {
      await projectsRepo.deleteById(project.id);
      summary.projectsRemoved++;
    } catch (err) {
      summary.failures.push({ id: project.id, stage: 'project', message: err.message });
      continue;
    }

    // Best-effort, like the DELETE /projects/:id path: the row is already gone from Cosmos, so an
    // index failure must not turn a successful purge into a failed one. `deleteFromIndex` logs and
    // returns 0 rather than throwing. Nothing reconciles it afterwards — the `_ts` high-water mark
    // cannot see a delete — so a failure here leaves the phantom searchable until the purge is
    // re-run. Records are not indexed; `indexes()` covers chunks, projects and documents only.
    summary.indexEntriesRemoved += await index.deleteFromIndex(index.indexes().projects, project.id);
  }

  // The empty-string partition: where unmatched records landed before the sync stopped writing
  // them. The records repository header claims 0 of 4,045 were unlinked — confirm rather than
  // trust it, because a stale count here is a set of records no per-project read can reach.
  try {
    const { items: unlinked } = await recordsRepo.listVisible(access, { projectId: UNLINKED_PARTITION });
    if (unlinked.length) {
      console.log(`[purge-nrpti] ${unlinked.length} record(s) in the unlinked ('') partition`);
    }
    for (const record of unlinked) {
      if (!args.live) {
        summary.unlinkedRecordsRemoved++;
        continue;
      }
      await recordsRepo.deleteById(record.id, UNLINKED_PARTITION);
      summary.unlinkedRecordsRemoved++;
    }
  } catch (err) {
    summary.failures.push({ id: '(unlinked partition)', stage: 'records', message: err.message });
  }

  const suffix = args.live ? '' : ' (dry run, nothing written)';
  console.log(
    `[purge-nrpti] ${summary.projectsRemoved} of ${summary.scanned} scanned projects, ` +
    `${summary.recordsRemoved} records, ${summary.unlinkedRecordsRemoved} unlinked records, ` +
    `${summary.indexEntriesRemoved} index entries${suffix}`
  );
  if (summary.notSeeded.length) {
    console.log(
      `[purge-nrpti] ${summary.notSeeded.length} project(s) source NRPTI but lack ` +
      'metadata.seededFromNrpti — left alone:'
    );
    for (const p of summary.notSeeded.slice(0, 20)) {
      console.log(`  ${p.id} ${p.name || ''}`);
    }
  }
  if (summary.failures.length) {
    console.error(`[purge-nrpti] ${summary.failures.length} failure(s):`);
    for (const f of summary.failures.slice(0, 20)) {
      console.error(`  ${f.id} [${f.stage}] ${f.message}`);
    }
  }

  return summary;
}

module.exports = { parseArgs, purgeSeeded, isSeeded, UNLINKED_PARTITION };

if (require.main === module) {
  // Always connect: even a dry run reads from Cosmos. It still writes nothing without --live.
  const { initCosmosClient } = require('../db/cosmos-nosql');
  initCosmosClient();

  purgeSeeded(process.argv.slice(2))
    .then(summary => {
      // A partial purge must not exit 0 — a wrapper would read that as "safe to re-run the sync".
      process.exit(summary.failures.length ? 1 : 0);
    })
    .catch(err => {
      console.error('[purge-nrpti] Fatal:', err);
      process.exit(1);
    });
}
