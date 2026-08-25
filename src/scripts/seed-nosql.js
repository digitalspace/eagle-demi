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
 * **DRY RUN BY DEFAULT.** `--live` is required to write anything. Verification gates run in both
 * modes, so a dry run is a genuine pre-flight check and not just a preview.
 *
 * Usage:
 *   node src/scripts/seed-nosql.js [--live] [--only projects,documents,boundaries]
 *                                 [--limit-documents N] [--reconcile] [--max-surplus N]
 *
 * Without --only, runs DEFAULT_STAGES: projects, documents, boundaries.
 *
 * `--reconcile` also DELETES the rows the fetch did not produce, through the same helpers the
 * DELETE controllers use. It needs Cosmos even in a dry run, where it only reports the count.
 *
 * Run it INSIDE the network via the Kudu command API, detached with a log file — Cosmos is behind
 * a private endpoint, and `/api/command` is synchronous and will time out on a 60k-document seed.
 */

const fs = require('fs');

const sources = require('../seed/sources');
const transform = require('../seed/transform');
const { buildRegistry, buildProjectIndex } = require('../merge/project');

const { systemAccess } = require('../helpers/access-sql');
const { logger } = require('../utils/logger');
const purgeHelpers = require('../helpers/purge');
const auditHelpers = require('../utils/audit');

const projectsRepo = require('../repositories/projects');
const documentsRepo = require('../repositories/documents');
const boundariesRepo = require('../repositories/boundaries');

/** Every stage `--only` accepts. */
const ALL_STAGES = ['projects', 'documents', 'boundaries'];

/** The stages `--reconcile` needs. Boundaries are a checked-in export with nothing to reconcile. */
const RECONCILED_STAGES = ['projects', 'documents'];

/** What runs when `--only` is not given — every stage there is. */
const DEFAULT_STAGES = ['projects', 'documents', 'boundaries'];

/**
 * Buffered items per project before a bulk write is issued.
 *
 * Documents are STREAMED, not accumulated: a dry run holding all 60,661 raw payloads plus
 * their transformed forms peaked at ~250 MB by document 45,000, and the API runs on a
 * Consumption plan with 1.5 GB. Buffering per project keeps peak flat.
 *
 * Matches the Cosmos bulk limit so a full buffer is exactly one request.
 */
const FLUSH_THRESHOLD = 100;

function parseArgs(argv) {
  const args = {
    live: false, only: DEFAULT_STAGES, limitDocuments: Infinity, reconcile: false, maxSurplus: null
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--reconcile') args.reconcile = true;
    else if (a === '--max-surplus') args.maxSurplus = Number(argv[++i]);
    else if (a === '--only') {
      args.only = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    } else if (a === '--limit-documents') args.limitDocuments = parseInt(argv[++i], 10);
  }

  const unknown = args.only.filter(s => !ALL_STAGES.includes(s));
  if (unknown.length) {
    throw new Error(`[seed] unknown stage(s): ${unknown.join(', ')}. Valid: ${ALL_STAGES.join(', ')}`);
  }

  if (args.reconcile) {
    // Reconcile deletes whatever the fetch did not produce, so anything that narrows the fetch
    // turns the untouched remainder into surplus. Refused rather than intersected: a partial
    // reconcile that looks like a full one is how a corpus disappears.
    const missing = RECONCILED_STAGES.filter(stage => !args.only.includes(stage));
    if (missing.length) {
      throw new Error(`[seed] --reconcile needs the ${RECONCILED_STAGES.join(' and ')} stages; ` +
        `--only excluded: ${missing.join(', ')}`);
    }
    if (Number.isFinite(args.limitDocuments)) {
      throw new Error('[seed] --reconcile cannot run with --limit-documents — every document ' +
        'past the limit would be computed as surplus and deleted');
    }
  }

  if (args.maxSurplus !== null) {
    if (!args.reconcile) {
      throw new Error('[seed] --max-surplus raises the reconcile ceiling and needs --reconcile');
    }
    if (!Number.isInteger(args.maxSurplus) || args.maxSurplus <= 0) {
      throw new Error('[seed] --max-surplus needs a positive integer');
    }
  }
  return args;
}

/** Rows in `rows` that this fetch did not produce. */
const surplusOf = (rows, keyOf, fetched) => rows.filter(row => !fetched.has(keyOf(row)));

/**
 * Most surplus one container may lose before `--reconcile` refuses.
 *
 * An upstream answering `searchResults: [], searchResultsTotal: 0` is internally consistent and
 * passes every completeness gate, so verifying the fetch against itself would still compute the
 * whole corpus as surplus. `--max-surplus` is the operator saying the loss really is that big.
 */
const surplusCeiling = (rowCount, maxSurplus) =>
  Math.max(50, Math.ceil(rowCount * 0.02), maxSurplus || 0);

/**
 * Where every surplus id goes. The console preview is capped at 20 — this file is not, because a
 * real reconcile can carry tens of thousands and "which rows went" has to outlive the run.
 */
function reconcileLogPath(now) {
  if (process.env.RECONCILE_LOG) return process.env.RECONCILE_LOG;
  const name = `reconcile-${now}.ndjson`;
  // `/home` is the only mount that survives a restart on the App Service plan the seed runs from.
  return fs.existsSync('/home') ? `/home/${name}` : `./${name}`;
}

/**
 * Rows in Cosmos that this fetch did not produce.
 *
 * Generic over the container because the two differ only in how a row is keyed: documents by
 * `projectId|id`, Eagle-sourced projects by `eagleId`. Deletion goes through `remove`, which is
 * the same helper the DELETE controllers use — a second delete path would eventually forget the
 * search index, which no indexer ever cleans up.
 *
 * @param {Array}    rows      `{id, ...}` read out of Cosmos
 * @param {function} keyOf     row -> the key to test against `fetched`
 * @param {Set}      fetched   keys the upstream fetch produced
 * @param {function} remove    row -> Promise, called ONLY when live
 * @param {string}   [opts.logPath] NDJSON sink for every surplus id, dry run included
 * @param {object}   [opts.audit]   `utils/audit`, called once per row actually deleted
 */
async function reconcileContainer(label, rows, keyOf, fetched, remove, { live, logPath, audit }) {
  const surplus = surplusOf(rows, keyOf, fetched);
  // Console preview only — capped because a refused run can carry tens of thousands of ids.
  const ids = surplus.slice(0, 20).map(r => r.id).join(', ');
  logger.info(`[seed] reconcile ${label}: ${rows.length} in Cosmos, ${surplus.length} not in the ` +
    `fetch${surplus.length ? ` — ${ids}${surplus.length > 20 ? ', …' : ''}` : ''}`);

  // documents partition on projectId, projects on their own id.
  const partitionOf = row => row.projectId || row.id;
  const singular = label.replace(/s$/, '');
  // One descriptor for the whole container: appendFileSync would reopen the file per row, and a
  // 60k-row reconcile pays that 60,000 times.
  const fd = logPath ? fs.openSync(logPath, 'a') : null;

  let deleted = 0;
  try {
    for (const row of surplus) {
      if (live) {
        await remove(row);
        deleted++;
        // The DELETE controllers' own event, so a purge is traceable however it was issued.
        if (audit) {
          audit.auditEvent(null, {
            action: `${singular}.delete`,
            targetType: singular,
            targetId: row.id,
            projectId: partitionOf(row),
            detail: { source: 'seed --reconcile' }
          });
        }
      }
      // Written AFTER the delete lands, so a throw mid-run leaves a file naming exactly what went.
      if (fd !== null) {
        fs.writeSync(fd, JSON.stringify(
          { label, id: row.id, partitionKey: partitionOf(row), deleted: live }) + '\n');
      }
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return { inCosmos: rows.length, wouldDelete: surplus.length, deleted };
}

/**
 * Assertions that must hold for the seed to be correct.
 *
 * These are the two symptoms of the removed compliance auto-seeder — synthetic ids and mass duplicate
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
      '(the removed hash-id auto-seeder)');
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
    boundaries: boundariesRepo
  };
  const purge = deps.purge || purgeHelpers;
  const audit = deps.audit || auditHelpers;
  const access = systemAccess();
  // Reading what is already there needs Cosmos. A live run always has it; a dry run only when the
  // operator is inside the private endpoint and set COSMOS_ENDPOINT.
  const cosmosReady = deps.cosmosReady !== undefined
    ? deps.cosmosReady
    : Boolean(process.env.COSMOS_ENDPOINT);

  const summary = { mode: args.live ? 'live' : 'dry-run', stages: {}, failures: [] };
  if (args.reconcile && !cosmosReady) {
    summary.failures.push('--reconcile needs COSMOS_ENDPOINT: the surplus set cannot be computed ' +
      'without enumerating the containers');
    log('=== VERIFICATION FAILURES ===');
    for (const f of summary.failures) log(`  \u2717 ${f}`);
    return summary;
  }
  log(`\n=== DEMI seed — ${args.live ? 'LIVE' : 'DRY RUN (nothing will be written)'} ===`);
  log(`Stages: ${args.only.join(', ')}\n`);

  // ── 1. Projects ────────────────────────────────────────────────────────────
  // Always built, even when not in --only: every other stage needs the project index to resolve
  // its partition key, and a stale index would misfile documents.
  log('Loading Track projects...');
  const trackProjects = src.loadTrackProjects();
  log(`  ${trackProjects.length} from the checked-in export`);

  log('Fetching Eagle projects...');
  // The upstream total, captured because `--reconcile` refuses to delete unless the fetch passed
  // the searchResultsTotal gate in sources.js — a null total means that gate never ran.
  let projectsTotal = null;
  const eagleProjects = await src.fetchEagleProjects((_items, _count, total) => {
    projectsTotal = total;
  });
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
  // Reconcile is a final phase, so what the documents stage fetched has to outlive its block.
  let documentFetch = null;
  let notificationFetch = null;
  if (args.only.includes('documents')) {
    log('Fetching the List lookup for type/milestone labels...');
    const listLookup = await src.fetchListLookup();
    log(`  ${listLookup.size} List items`);

    // The OTHER thing a document can hang off. Read through the generic pager rather than a named
    // loader because sources.js has none — nothing but this one carve-out needs the dataset, and
    // the ids are all it needs: 17 rows, held as a Set to test membership per document.
    log('Fetching Project Notifications (the other document parent)...');
    // The total is captured for the same reason the Project fetch captures one: this list decides
    // whether a document has a home, so an unverified one leaves every notification-parented
    // document unresolvable, absent from `fetchedKeys`, and computed as surplus.
    let notificationsTotal = null;
    const notifications = await src.fetchAllPages(src.EAGLE_API_BASE, 'ProjectNotification',
      { onPage: (_items, _count, total) => { notificationsTotal = total; } });
    const notificationIds = new Set(notifications.map(n => String(n._id)));
    notificationFetch = { total: notificationsTotal, fetched: notifications.length };
    log(`  ${notificationIds.size} notifications`);

    log('Streaming Eagle documents (60k+, paged at 100)...');

    const buffers = new Map();          // projectId -> pending raw docs
    const perProject = new Map();       // projectId -> total transformed
    const unresolvedRefs = new Set();
    const stats = {
      fetched: 0, built: 0, unresolved: 0, notificationParented: 0,
      noKey: 0, preserved: 0, written: 0, writeFailed: 0
    };
    const writeStatus = {};
    const fetchedKeys = new Set();
    let duplicateIds = 0;
    let gateFailures = [];

    // projectId -> (documentId -> extraction state already in Cosmos). One partition read per
    // project, not per batch: a project's documents flush more than once.
    const existingByProject = new Map();
    const existingFor = async (projectId) => {
      if (!cosmosReady) return null;
      if (!existingByProject.has(projectId)) {
        const rows = await repos.documents.extractionRowsForProject(access, projectId);
        existingByProject.set(projectId, new Map(rows.map(r => [String(r.id), r])));
      }
      return existingByProject.get(projectId);
    };

    const flush = async (projectId, rawDocs) => {
      // Transformed HERE rather than on the way into the buffer, because the extraction state a
      // re-seed must carry forward is read one partition at a time and this is where the
      // partition is known. A Cosmos upsert replaces the item, so without it every re-seed marks
      // the whole corpus unextracted while its chunks stay behind.
      const existingRows = await existingFor(projectId);
      const docs = [];
      for (const raw of rawDocs) {
        const existing = existingRows && existingRows.get(String(raw._id));
        if (existing) stats.preserved++;
        const transformed = transform.transformDocument(raw, projectId, listLookup, { now, existing });
        if (!transformed.s3Key) stats.noKey++;
        // id is unique per PARTITION in Cosmos, so a repeat within one project silently
        // overwrites. Counted so a shortfall is attributable rather than mysterious.
        const key = `${projectId}|${transformed.id}`;
        if (fetchedKeys.has(key)) duplicateIds++; else fetchedKeys.add(key);
        docs.push(transformed);
      }

      // Verify each batch rather than the whole corpus: the gates are per-item, and holding
      // 60,661 documents just to check them is what streaming exists to avoid.
      gateFailures.push(...verifyItems(docs, 'documents', 'projectId'));
      if (args.live) {
        // Count what LANDED, never what was sent. Cosmos bulk returns a per-operation status and
        // does not throw on partial failure; counting sent operations reported 60,578 written
        // when only 56,317 existed.
        const r = await repos.documents.bulkUpsertForProject(projectId, docs);
        stats.written += r.succeeded;
        stats.writeFailed += r.failed;
        for (const [code, n] of Object.entries(r.statusCounts)) {
          writeStatus[code] = (writeStatus[code] || 0) + n;
        }
      }
    };

    const { count, total: documentsTotal } = await src.streamEagleDocuments(async (page, fetched, total) => {
      stats.fetched = fetched;

      for (const doc of page) {
        if (stats.built + stats.unresolved >= args.limitDocuments) break;

        // A document's parent is USUALLY a project, but 80 of them hang off a ProjectNotification
        // instead — a different entity type in the same Eagle collection, with its own _id space.
        // Those resolve to nothing in the project registry, and used to be dropped on the reasoning
        // that an unresolvable parent meant "recently created and presumably unpublished".
        // Measured 2026-08-24, that reasoning was wrong on every count: all 17 notifications and
        // all 80 documents carry `public` in read[], and prod serves 2-13 documents under each one
        // (63 of the 80 once eagle-public's own `documentSource: PROJECT-NOTIFICATION` filter is
        // applied — the number the Project Notifications tab shows).
        //
        // They are carried under the NOTIFICATION's own _id as the partition key. Nothing else
        // could work: eagle-public sends that _id as its `project` filter
        // (project-notification-documents-table.component.ts:110) and there is nothing to translate
        // it into — `associatedProjectId` is "" on all 17, so the source data holds no link to a
        // real project. `documentSource` already distinguishes these rows, so this needs no new
        // field, no new container, and no change to the documents model.
        //
        // Admitted by KNOWN notification id, never by "the ref resolved to nothing": a parent that
        // is in neither list is still a document with no home, and still gets dropped below.
        let projectId = projectIndex.resolve(doc.project);
        if (!projectId && notificationIds.has(String(doc.project))) {
          projectId = String(doc.project);
          stats.notificationParented++;
        }

        if (!projectId) {
          // Neither a project nor a notification. Dropped rather than filed under an invented
          // parent, and COUNTED — with the distinct refs carried into the summary, not just the
          // log, so the NEXT class of dropped rows shows up in the run output instead of being
          // discovered months later from a user-facing zero.
          stats.unresolved++;
          unresolvedRefs.add(String(doc.project));
          continue;
        }

        stats.built++;
        perProject.set(projectId, (perProject.get(projectId) || 0) + 1);

        if (!buffers.has(projectId)) buffers.set(projectId, []);
        buffers.get(projectId).push(doc);
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

    log(`  ${count} fetched · ${stats.built} transformed across ${perProject.size} parents`);
    log(`  ${stats.notificationParented} filed under a Project Notification rather than a project`);
    log(`  dropped ${stats.unresolved} with an unresolvable parent ` +
      `(${unresolvedRefs.size} distinct refs: ${[...unresolvedRefs].slice(0, 3).join(', ')})`);
    if (stats.noKey) {
      log(`  WARNING: ${stats.noKey} documents have no object key and cannot be downloaded`);
    }

    summary.stages.documents = {
      fetched: count,
      built: stats.built,
      notificationParented: stats.notificationParented,
      droppedUnresolvable: stats.unresolved,
      // The refs themselves, not just the count: a drop is only visible in the output if the run
      // says WHAT it dropped. Capped — an upstream fault could produce thousands of distinct refs
      // and the summary is printed in full.
      distinctUnresolvedRefs: unresolvedRefs.size,
      unresolvedRefs: [...unresolvedRefs].slice(0, 20),
      withoutObjectKey: stats.noKey,
      preserved: stats.preserved,
      duplicateIds,
      projects: perProject.size,
      written: stats.written,
      writeFailed: stats.writeFailed,
      writeStatus
    };
    if (duplicateIds) {
      summary.failures.push(`${duplicateIds} documents share an (projectId, id) pair — ` +
        'later writes silently overwrote earlier ones');
    }
    if (stats.writeFailed) {
      summary.failures.push(`${stats.writeFailed} document writes FAILED after retries ` +
        `(status counts: ${JSON.stringify(writeStatus)})`);
    }
    if (args.live && stats.written !== stats.built) {
      summary.failures.push(
        `document count mismatch: built ${stats.built} but only ${stats.written} were confirmed ` +
        'written');
    }
    // Deduplicated: a per-item fault repeats once per batch, which would otherwise print
    // hundreds of identical lines.
    summary.failures.push(...new Set(gateFailures.map(f => f.replace(/^\d+ /, 'some '))));
    gateFailures = [];

    log(`  extraction state carried forward on ${stats.preserved} existing rows`);
    log(`  documents ${args.live ? 'written' : 'would write'}: ${stats.built}\n`);

    documentFetch = { keys: fetchedKeys, total: documentsTotal, fetched: count };
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

  // ── Reconcile ──────────────────────────────────────────────────────────────
  // ONE phase after every fetch, never per container: an unverified Project fetch used to leave
  // the documents reconcile free to delete, and vice versa. A fetch is verified only when
  // eagle-api reported a searchResultsTotal AND it matches what arrived; either upstream falling
  // short refuses BOTH deletions, since the surplus set is only meaningful off a complete fetch.
  if (args.reconcile) {
    const unverified = [
      ['Project', projectsTotal, eagleProjects.length],
      ['ProjectNotification', notificationFetch && notificationFetch.total,
        notificationFetch && notificationFetch.fetched],
      ['Document', documentFetch && documentFetch.total, documentFetch && documentFetch.fetched]
    ].filter(([, total, fetched]) => typeof total !== 'number' || total !== fetched);

    // An empty-but-consistent notification list passes every completeness gate above, so the drop
    // count is the second half of the same guard: a document the seed could not place is missing
    // from the fetch for a reason that is not "it was removed upstream".
    const dropped = (summary.stages.documents || {}).droppedUnresolvable || 0;

    if (unverified.length) {
      summary.failures.push('--reconcile refused before any delete — nothing removed from either ' +
        `container: the ${unverified.map(([label]) => label).join(' and ')} fetch was never ` +
        'verified complete against a searchResultsTotal');
    } else if (dropped) {
      summary.failures.push('--reconcile refused before any delete — nothing removed from either ' +
        `container: ${dropped} document(s) resolved to neither a project nor a ProjectNotification` +
        ', so they are absent from the fetch and would be deleted as surplus');
    } else {
      // Documents first: a project whose documents are already gone cannot orphan any.
      const containers = [
        ['documents', await repos.documents.listSeededIds(access),
          row => `${row.projectId}|${row.id}`, documentFetch.keys,
          row => purge.purgeDocument(row)],
        ['projects', await repos.projects.listEagleOnlyIds(access),
          row => String(row.eagleId), new Set(eagleProjects.map(p => String(p._id))),
          row => purge.purgeProject(row)]
      ];
      // Both containers sized BEFORE either delete, so a breach in one stops the other too.
      const breached = containers
        .map(([label, rows, keyOf, fetched]) => [label, surplusOf(rows, keyOf, fetched).length,
          surplusCeiling(rows.length, args.maxSurplus)])
        .filter(([, surplus, ceiling]) => surplus > ceiling);

      if (breached.length) {
        summary.failures.push('--reconcile refused before any delete — nothing removed from ' +
          'either container: ' + breached.map(([label, surplus, ceiling]) =>
            `${label} surplus ${surplus} exceeds the ceiling ${ceiling}`).join('; ') +
          '. Re-run with --max-surplus <n> if the deletion really is that large.');
      }

      // Reported either way: a dry run must still show wouldDelete and that it would refuse.
      const live = args.live && !breached.length;
      const logPath = reconcileLogPath(now);
      summary.reconcile = { log: logPath };
      summary.reconcile.documents = await reconcileContainer(...containers[0],
        { live, logPath, audit });
      summary.reconcile.projects = await reconcileContainer(...containers[1],
        { live, logPath, audit });
      log(`  surplus ids: ${logPath}`);
    }
  }

  // ── Gates ──────────────────────────────────────────────────────────────────
  if (summary.failures.length) {
    log('=== VERIFICATION FAILURES ===');
    for (const f of summary.failures) log(`  ✗ ${f}`);
  } else {
    log('=== Verification passed ===');
  }
  if (summary.reconcile) log(`\nreconcile: ${JSON.stringify(summary.reconcile, null, 2)}`);
  log(`\n${JSON.stringify(summary.stages, null, 2)}\n`);

  return summary;
}

module.exports = {
  ALL_STAGES,
  DEFAULT_STAGES,
  FLUSH_THRESHOLD,
  RECONCILED_STAGES,
  parseArgs,
  reconcileContainer,
  verifyProjects,
  verifyItems,
  seed
};

if (require.main === module) {
  const { initCosmosClient } = require('../db/cosmos-nosql');

  // Caught, because winston's handleExceptions swallows a throw here and the process still
  // exits 0 — a rejected argument list would read as a successful seed.
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    logger.error(err.message);
    process.exit(1);
  }

  // A dry run is a pure pre-flight check and must work without database access — that is the only
  // way to run it from outside the private endpoint. Inside it, COSMOS_ENDPOINT turns on the reads
  // that report `preserved` and `wouldDelete`; `--reconcile` without it refuses rather than
  // reporting an empty surplus set.
  if (args.live || process.env.COSMOS_ENDPOINT) initCosmosClient();

  seed(process.argv.slice(2))
    .then(async summary => {
      // Audit rows buffer behind an unref'd timer, so process.exit would drop the purge trail.
      await auditHelpers.flush().catch(err => logger.error(`[seed] audit flush: ${err.message}`));
      // A failed gate must not exit 0 — a wrapper script or a Kudu run would read that as success.
      process.exit(summary.failures.length ? 1 : 0);
    })
    .catch(err => {
      console.error('[seed] Fatal:', err);
      process.exit(1);
    });
}
