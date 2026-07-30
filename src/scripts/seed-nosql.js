'use strict';

/**
 * Seed the Cosmos NoSQL account from the upstream sources.
 *
 * This does NOT migrate the existing database. That database is a stale partial import carrying
 * Mongoose legacy (`__v`, ObjectId `_id`s), 3,382 synthetic project rows, and `contentExtracted`
 * flags with no chunks behind them. There is nothing there the sources cannot reproduce better.
 *
 * Order matters: projects first, because every other container partitions by a canonical project
 * id that only the merged registry can supply.
 *
 *   1. Track (382) merged with Eagle (359)   -> projects       393
 *   2. Eagle documents                       -> documents      60,578
 *   3. Static boundary exports               -> boundaries     281
 *
 * `records` (NRPTI) is a valid stage but NOT in the default set — see DEFAULT_STAGES.
 *
 * **DRY RUN BY DEFAULT.** `--live` is required to write anything. Verification gates run in both
 * modes, so a dry run is a genuine pre-flight check and not just a preview.
 *
 * Usage:
 *   node src/scripts/seed-nosql.js [--live] [--only projects,documents,records,boundaries]
 *                                 [--limit-documents N]
 *
 * Without --only, runs DEFAULT_STAGES: projects, documents, boundaries.
 *
 * Run it INSIDE the network via the Kudu command API, detached with a log file — Cosmos is behind
 * a private endpoint, and `/api/command` is synchronous and will time out on a 60k-document seed.
 */

const sources = require('../seed/sources');
const transform = require('../seed/transform');
const { buildRegistry, buildProjectIndex } = require('../merge/project');

const projectsRepo = require('../repositories/projects');
const documentsRepo = require('../repositories/documents');
const recordsRepo = require('../repositories/records');
const boundariesRepo = require('../repositories/boundaries');
const fragmentsRepo = require('../repositories/fragments');

/** Every stage `--only` accepts. */
const ALL_STAGES = ['projects', 'documents', 'records', 'boundaries'];

/**
 * What runs when `--only` is not given.
 *
 * **`records` is deliberately excluded.** DEMI's remit right now is projects and documents, and
 * NRPTI records are neither — they are compliance and enforcement *events* (67,287 Inspections,
 * 29,555 Tickets, 1,086 Orders, 891 AdministrativePenalties, 611 Certificates).
 *
 * They do carry `documents: [...]` references, which would make them worth having, except those
 * ids are not reachable: NRPTI's public API returns nothing for `dataset=Document`, an empty set
 * for `RecordDocument`, and 404 for `/api/public/document/<id>`. Dead ends.
 *
 * And only **2,238 of 99,430 (2.25%)** resolve to a project in the registry at all, because NRPTI
 * covers all BC natural-resource compliance rather than only EA'd projects.
 *
 * So the stage costs ~40 minutes of upstream fetching per seed for data outside the current remit.
 * The code stays and is tested — run `--only records` when compliance data matters.
 */
const DEFAULT_STAGES = ['projects', 'documents', 'boundaries'];

/** Who may see a project's NRPTI compliance aggregate. Its own item, so its own ACL. */
const NRPTI_FRAGMENT_ROLES = ['sysadmin', 'staff', 'demi-admin', 'compliance'];

/**
 * Buffered items per project before a bulk write is issued.
 *
 * Documents and records are STREAMED, not accumulated: a dry run holding all 60,661 raw payloads
 * plus their transformed forms peaked at ~250 MB by document 45,000, and the API runs on a
 * Consumption plan with 1.5 GB. Buffering per project keeps peak flat.
 *
 * Matches the Cosmos bulk limit so a full buffer is exactly one request.
 */
const FLUSH_THRESHOLD = 100;

function parseArgs(argv) {
  const args = { live: false, only: DEFAULT_STAGES, limitDocuments: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--only') {
      args.only = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    } else if (a === '--limit-documents') args.limitDocuments = parseInt(argv[++i], 10);
  }

  const unknown = args.only.filter(s => !ALL_STAGES.includes(s));
  if (unknown.length) {
    throw new Error(`[seed] unknown stage(s): ${unknown.join(', ')}. Valid: ${ALL_STAGES.join(', ')}`);
  }
  return args;
}

/**
 * Assertions that must hold for the seed to be correct.
 *
 * These are the two symptoms of the old NRPTI auto-seeder — synthetic ids and mass duplicate
 * names — plus the ACL invariant that licenses deleting the legacy no-read[] tier. Checked
 * against the built data BEFORE writing, so a dry run catches a regression.
 *
 * Returns a list of failures rather than throwing per-check, so one run reports everything wrong.
 */
function verifyProjects(projects) {
  const failures = [];

  const synthetic = projects.filter(p => Number(p.trackProjectId) >= 8000000);
  if (synthetic.length) {
    failures.push(`${synthetic.length} projects have a synthetic trackProjectId >= 8,000,000 ` +
      '(the old NRPTI hash-id seeder)');
  }

  const byName = new Map();
  for (const p of projects) {
    const key = (p.name || '').trim().toLowerCase();
    if (!key) continue;
    byName.set(key, (byName.get(key) || 0) + 1);
  }
  const dupes = [...byName.entries()].filter(([, n]) => n > 1);
  // A handful of legitimately similar names is plausible; 851 was the auto-seeder signature.
  if (dupes.length > 20) {
    failures.push(`${dupes.length} duplicate project names — e.g. ` +
      dupes.slice(0, 3).map(([n, c]) => `"${n}" x${c}`).join(', '));
  }

  const ids = projects.map(p => p.id);
  if (new Set(ids).size !== ids.length) {
    failures.push('duplicate project ids — a Cosmos upsert would silently overwrite');
  }

  const noAcl = projects.filter(p => !Array.isArray(p.read) || p.read.length === 0);
  if (noAcl.length) failures.push(`${noAcl.length} projects have no read[]`);

  return failures;
}

function verifyItems(items, label, partitionField) {
  const failures = [];

  const noAcl = items.filter(i => !Array.isArray(i.read) || i.read.length === 0);
  if (noAcl.length) failures.push(`${noAcl.length} ${label} have no read[]`);

  const noPartition = items.filter(i => !i[partitionField]);
  if (noPartition.length) {
    failures.push(`${noPartition.length} ${label} have no ${partitionField} — the partition key`);
  }

  // read[] is authoritative and isPublished is its mirror. A drift between them means one of the
  // two views of visibility is wrong, and it is not knowable which.
  const drifted = items.filter(i => i.isPublished !== i.read.includes('public'));
  if (drifted.length) {
    failures.push(`${drifted.length} ${label} have isPublished out of step with read[]`);
  }

  return failures;
}

function log(...parts) {
  console.log(...parts);
}

async function seed(argv = [], deps = {}) {
  const args = parseArgs(argv);
  const now = deps.now || new Date().toISOString();
  const src = deps.sources || sources;
  const repos = deps.repos || {
    projects: projectsRepo,
    documents: documentsRepo,
    records: recordsRepo,
    boundaries: boundariesRepo,
    fragments: fragmentsRepo
  };

  const summary = { mode: args.live ? 'live' : 'dry-run', stages: {}, failures: [] };
  log(`\n=== DEMI seed — ${args.live ? 'LIVE' : 'DRY RUN (nothing will be written)'} ===`);
  log(`Stages: ${args.only.join(', ')}\n`);

  // ── 1. Projects ────────────────────────────────────────────────────────────
  // Always built, even when not in --only: every other stage needs the project index to resolve
  // its partition key, and a stale index would misfile documents.
  log('Loading Track projects...');
  const trackProjects = src.loadTrackProjects();
  log(`  ${trackProjects.length} from the checked-in export`);

  log('Fetching Eagle projects...');
  const eagleProjects = await src.fetchEagleProjects();
  log(`  ${eagleProjects.length} from eagle-api`);

  const { projects, report } = buildRegistry(trackProjects, eagleProjects, { now });
  log(`  merged: ${report.matched} matched · ${report.trackOnlyNoGuid} Track without epic_guid · ` +
    `${report.trackOnlyDanglingGuid} dangling · ${report.eagleOnly} Eagle-only = ${report.total}`);
  if (report.danglingGuids.length) {
    log(`  dangling epic_guids: ${report.danglingGuids.slice(0, 5).join(', ')}`);
  }

  const projectIndex = buildProjectIndex(projects);
  summary.stages.projects = { built: projects.length, report, written: 0 };

  const projectFailures = verifyProjects(projects);
  summary.failures.push(...projectFailures);

  if (args.only.includes('projects')) {
    if (args.live) {
      // Projects partition on /id, so every project is its own partition and bulk cannot batch
      // across them. 392 sequential upserts is a few seconds.
      for (const project of projects) {
        await repos.projects.upsert(project);
        summary.stages.projects.written++;
      }
    }
    log(`  projects ${args.live ? 'written' : 'would write'}: ${projects.length}\n`);
  }

  // ── 2. Documents ───────────────────────────────────────────────────────────
  if (args.only.includes('documents')) {
    log('Fetching the List lookup for type/milestone labels...');
    const listLookup = await src.fetchListLookup();
    log(`  ${listLookup.size} List items`);

    log('Streaming Eagle documents (60k+, paged at 100)...');

    const buffers = new Map();          // projectId -> pending transformed docs
    const perProject = new Map();       // projectId -> total transformed
    const unresolvedRefs = new Set();
    const stats = { fetched: 0, built: 0, unresolved: 0, noKey: 0, written: 0 };
    let gateFailures = [];

    const flush = async (projectId, docs) => {
      // Verify each batch rather than the whole corpus: the gates are per-item, and holding
      // 60,661 documents just to check them is what streaming exists to avoid.
      gateFailures.push(...verifyItems(docs, 'documents', 'projectId'));
      if (args.live) {
        await repos.documents.bulkUpsertForProject(projectId, docs);
        stats.written += docs.length;
      }
    };

    const { count } = await src.streamEagleDocuments(async (page, fetched, total) => {
      stats.fetched = fetched;

      for (const doc of page) {
        if (stats.built + stats.unresolved >= args.limitDocuments) break;

        const projectId = projectIndex.resolve(doc.project);
        if (!projectId) {
          // ~0.1% of documents point at a project absent from the public list — recently created
          // and presumably unpublished. Dropped rather than filed under an invented parent, and
          // COUNTED so the loss is visible instead of silent.
          stats.unresolved++;
          unresolvedRefs.add(String(doc.project));
          continue;
        }

        const transformed = transform.transformDocument(doc, projectId, listLookup, { now });
        if (!transformed.s3Key) stats.noKey++;
        stats.built++;
        perProject.set(projectId, (perProject.get(projectId) || 0) + 1);

        if (!buffers.has(projectId)) buffers.set(projectId, []);
        buffers.get(projectId).push(transformed);
      }

      // Pagination is _id-ordered and documents cluster by project, so a project's docs arrive
      // mostly contiguously and a full buffer is usually its last. Upsert is idempotent, so
      // splitting one project across batches is safe.
      for (const [projectId, docs] of buffers) {
        if (docs.length >= FLUSH_THRESHOLD) {
          await flush(projectId, docs);
          buffers.delete(projectId);
        }
      }

      if (fetched % 5000 === 0) log(`  ${fetched}/${total ?? '?'}`);
    });

    for (const [projectId, docs] of buffers) {
      if (docs.length) await flush(projectId, docs);
    }
    buffers.clear();

    log(`  ${count} fetched · ${stats.built} transformed across ${perProject.size} projects`);
    log(`  dropped ${stats.unresolved} with an unresolvable project ` +
      `(${unresolvedRefs.size} distinct refs: ${[...unresolvedRefs].slice(0, 3).join(', ')})`);
    if (stats.noKey) {
      log(`  WARNING: ${stats.noKey} documents have no object key and cannot be downloaded`);
    }

    summary.stages.documents = {
      fetched: count,
      built: stats.built,
      droppedUnresolvable: stats.unresolved,
      withoutObjectKey: stats.noKey,
      projects: perProject.size,
      written: stats.written
    };
    // Deduplicated: a per-item fault repeats once per batch, which would otherwise print
    // hundreds of identical lines.
    summary.failures.push(...new Set(gateFailures.map(f => f.replace(/^\d+ /, 'some '))));
    gateFailures = [];

    log(`  documents ${args.live ? 'written' : 'would write'}: ${stats.built}\n`);
  }

  // ── 3. Records + 4. NRPTI aggregate fragment ───────────────────────────────
  if (args.only.includes('records')) {
    log('Streaming NRPTI records...');

    const buffers = new Map();     // projectId -> pending transformed records
    const summaries = new Map();   // projectId -> running aggregate (5 counters, not records)
    const perDataset = {};
    // `dropped` is split by REASON, because the two mean opposite things:
    //   noEpicProject  — the record has no _epicProjectId at all. Correct exclusion: NRPTI covers
    //                    all BC natural-resource compliance, most of which was never an EA project.
    //   unresolvable   — it HAS one, pointing at a project absent from the registry. That would
    //                    mean the registry is incomplete, and is worth investigating.
    // Reporting a single total hides which of those is happening at a 97% drop rate.
    const stats = {
      fetched: 0, built: 0, written: 0, fragments: 0,
      droppedNoEpicProject: 0, droppedUnresolvable: 0
    };
    const unresolvableRefs = new Set();
    let gateFailures = [];

    const flush = async (projectId, recs) => {
      gateFailures.push(...verifyItems(recs, 'records', 'projectId'));
      if (args.live) {
        await repos.records.bulkUpsertForProject(projectId, recs);
        stats.written += recs.length;
      }
    };

    await src.streamNrptiRecords(async (page, fetched, total, dataset) => {
      perDataset[dataset] = fetched;
      stats.fetched += page.length;

      for (const record of page) {
        const transformed = transform.transformRecord(record, projectIndex, { now });
        if (!transformed) {
          // No project seeding from NRPTI, ever. The old seeder turned each unmatched location
          // string into a project and produced 3,382 junk rows named after cities and
          // watercourses, with a hash id that collides in the low hundreds.
          if (!record._epicProjectId) {
            stats.droppedNoEpicProject++;
          } else {
            stats.droppedUnresolvable++;
            if (unresolvableRefs.size < 50) unresolvableRefs.add(String(record._epicProjectId));
          }
          continue;
        }
        stats.built++;

        const projectId = transformed.projectId;
        if (!summaries.has(projectId)) summaries.set(projectId, transform.emptySummary());
        // Accumulated incrementally so the records themselves need not be retained.
        transform.accumulateRecord(summaries.get(projectId), transformed);

        if (!buffers.has(projectId)) buffers.set(projectId, []);
        buffers.get(projectId).push(transformed);
      }

      for (const [projectId, recs] of buffers) {
        if (recs.length >= FLUSH_THRESHOLD) {
          await flush(projectId, recs);
          buffers.delete(projectId);
        }
      }

      // Per PAGE, not per dataset: Inspection alone is 673 pages, and a per-dataset callback
      // emits nothing for the ~20 minutes that takes — indistinguishable from hung.
      if (fetched % 5000 === 0) log(`  ${dataset}: ${fetched}/${total ?? '?'}`);
    });

    for (const [projectId, recs] of buffers) {
      if (recs.length) await flush(projectId, recs);
    }
    buffers.clear();

    log(`  fetched ${stats.fetched}: ${JSON.stringify(perDataset)}`);
    log(`  ${stats.built} resolvable across ${summaries.size} projects`);
    log(`  dropped ${stats.droppedNoEpicProject} with NO _epicProjectId ` +
      '(expected — NRPTI covers all BC resource compliance, not only EA projects)');
    log(`  dropped ${stats.droppedUnresolvable} with an UNRESOLVABLE _epicProjectId` +
      (stats.droppedUnresolvable
        ? ` — registry may be incomplete: ${[...unresolvableRefs].slice(0, 3).join(', ')}`
        : ''));

    if (args.live) {
      for (const [projectId, aggregate] of summaries) {
        // Its OWN item in project_fragments, not a field on the project. Both the 2 MB fix (the
        // old code embedded full record payloads into the project twice) and the fragment-ACL
        // mechanism: a caller without the fragment role never fetches it at all.
        await repos.fragments.put(projectId, 'nrpti', aggregate, NRPTI_FRAGMENT_ROLES);
        stats.fragments++;
      }
    }

    summary.stages.records = {
      fetched: stats.fetched,
      perDataset,
      built: stats.built,
      droppedNoEpicProject: stats.droppedNoEpicProject,
      droppedUnresolvable: stats.droppedUnresolvable,
      projects: summaries.size,
      written: stats.written,
      fragmentsWritten: stats.fragments
    };
    summary.failures.push(...new Set(gateFailures.map(f => f.replace(/^\d+ /, 'some '))));
    gateFailures = [];

    log(`  records ${args.live ? 'written' : 'would write'}: ${stats.built} ` +
      `(+ ${summaries.size} nrpti fragments)\n`);
  }

  // ── 5. Boundaries ──────────────────────────────────────────────────────────
  if (args.only.includes('boundaries')) {
    log('Loading static boundary exports...');
    const raw = src.loadBoundaries();
    const boundaries = raw.map(b => transform.transformBoundary(b, { now }));

    const byType = new Map();
    for (const b of boundaries) {
      if (!byType.has(b.type)) byType.set(b.type, []);
      byType.get(b.type).push(b);
    }
    log(`  ${boundaries.length} across ${byType.size} types: ` +
      [...byType.entries()].map(([t, v]) => `${t} ${v.length}`).join(', '));

    summary.stages.boundaries = { built: boundaries.length, types: byType.size, written: 0 };

    if (args.live) {
      for (const [type, items] of byType) {
        await repos.boundaries.bulkUpsertForType(type, items);
        summary.stages.boundaries.written += items.length;
      }
    }
    log(`  boundaries ${args.live ? 'written' : 'would write'}: ${boundaries.length}\n`);
  }

  // ── Gates ──────────────────────────────────────────────────────────────────
  if (summary.failures.length) {
    log('=== VERIFICATION FAILURES ===');
    for (const f of summary.failures) log(`  ✗ ${f}`);
  } else {
    log('=== Verification passed ===');
  }
  log(`\n${JSON.stringify(summary.stages, null, 2)}\n`);

  return summary;
}

module.exports = {
  ALL_STAGES,
  DEFAULT_STAGES,
  NRPTI_FRAGMENT_ROLES,
  FLUSH_THRESHOLD,
  parseArgs,
  verifyProjects,
  verifyItems,
  seed
};

if (require.main === module) {
  const { initCosmosClient } = require('../db/cosmos-nosql');
  const args = parseArgs(process.argv.slice(2));

  // Only connect when actually writing: a dry run is a pure pre-flight check and must work
  // without database access, which is the only way to run it from outside the private endpoint.
  if (args.live) initCosmosClient();

  seed(process.argv.slice(2))
    .then(summary => {
      // A failed gate must not exit 0 — a wrapper script or a Kudu run would read that as success.
      process.exit(summary.failures.length ? 1 : 0);
    })
    .catch(err => {
      console.error('[seed] Fatal:', err);
      process.exit(1);
    });
}
