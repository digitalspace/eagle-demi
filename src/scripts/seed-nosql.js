'use strict';

// Projects go first: other containers partition by a project id only the merged registry supplies.
// Run inside the network (`scripts/demi-devbox.sh run`): Cosmos is behind a private endpoint.

const fs = require('fs');
const path = require('path');

const sources = require('../seed/sources');
const transform = require('../seed/transform');
const {
  buildRegistry, buildProjectIndex, carryEagleOnlyFields, carryDemiOnlyFields, notificationShadowedProjects,
  eagleOnlyProjectId, isEagleOnlyProjectId, heldRead
} = require('../merge/project');

const { systemAccess } = require('../helpers/access-sql');
// The parent rule, shared with the push mirrors: which of the two containers claims a child.
const { pickParent } = require('../helpers/parent-admit');
const { refId } = require('../controllers/nosql/eagle-mirror');
const { logger } = require('../utils/logger');
const { readKeepIds } = require('../utils/keep-ids');
const purgeHelpers = require('../helpers/purge');
const auditHelpers = require('../utils/audit');
const aiSearch = require('../search/ai-search');

const projectsRepo = require('../repositories/projects');
const documentsRepo = require('../repositories/documents');
const boundariesRepo = require('../repositories/boundaries');
const linksRepo = require('../repositories/links');
const chunksRepo = require('../repositories/chunks');
const { ensureProjectShortLink, carryShortLink } = require('../helpers/short-links');

/** Every stage `--only` accepts. */
const ALL_STAGES = ['projects', 'documents', 'boundaries'];

/** The stages `--reconcile` needs. Boundaries are a checked-in export with nothing to reconcile. */
const RECONCILED_STAGES = ['projects', 'documents'];

/** What runs when `--only` is not given — every stage there is. */
const DEFAULT_STAGES = ['projects', 'documents', 'boundaries'];

// Streamed per project, never accumulated: holding every raw payload peaked near 250 MB on a
// 1.5 GB plan. 100 is the Cosmos bulk limit, so a full buffer is one request.
const FLUSH_THRESHOLD = 100;

function parseArgs(argv) {
  const args = {
    live: false, only: DEFAULT_STAGES, limitDocuments: Infinity, reconcile: false, maxSurplus: null,
    keepIds: null, summary: null
  };
  let keepIdsFile = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--reconcile') args.reconcile = true;
    else if (a === '--max-surplus') args.maxSurplus = Number(argv[++i]);
    else if (a === '--keep-ids') keepIdsFile = String(argv[++i] || '');
    else if (a === '--summary') args.summary = String(argv[++i] || '');
    else if (a === '--only') {
      args.only = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    } else if (a === '--limit-documents') args.limitDocuments = parseInt(argv[++i], 10);
  }

  const unknown = args.only.filter(s => !ALL_STAGES.includes(s));
  if (unknown.length) {
    throw new Error(`[seed] unknown stage(s): ${unknown.join(', ')}. Valid: ${ALL_STAGES.join(', ')}`);
  }

  if (args.reconcile) {
    // Refused rather than intersected: a narrowed fetch turns the untouched rest into surplus, and a
    // partial reconcile that looks like a full one deletes the corpus.
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

  if (keepIdsFile !== null) {
    if (!args.reconcile) throw new Error('[seed] --keep-ids spares reconcile rows and needs --reconcile');
    if (!keepIdsFile) throw new Error('[seed] --keep-ids needs a file');
    args.keepIds = new Set(readKeepIds(keepIdsFile));
  }
  if (args.summary === '') throw new Error('[seed] --summary needs a file');
  return args;
}

/** Rows in `rows` that this fetch did not produce. Shared with `reconcile-eagle.js`. */
const surplusOf = (rows, keyOf, fetched) => rows.filter(row => !fetched.has(keyOf(row)));

/**
 * A truncated read looks like a container that shrank: every row it missed computes as surplus.
 * @param {Array} pairs  `[label, rows, countOf]`, `countOf` being the COUNT of the same predicate
 */
async function truncatedReads(access, pairs) {
  const short = [];
  for (const [label, rows, countOf] of pairs) {
    const expected = await countOf(access);
    if (rows.length !== expected) {
      short.push(`${label} enumerated ${rows.length} rows but the container holds ${expected}`);
    }
  }
  return short;
}

/**
 * Notification-parented documents partition under the notification's own _id: eagle-public sends
 * it as `project`, and no source field links it to a project. Precedence: `parent-admit.js:pickParent`.
 * @returns {Promise<{admit: function, notificationIds: Set, fetch: object}>} `admit(ref)` gives the canonical parent id, or null when the document has no home
 */
async function documentAdmission(src, projectIndex) {
  let total = null;
  const notifications = await src.fetchAllPages(src.EAGLE_API_BASE, 'ProjectNotification',
    { onTotal: (t) => { total = t; } });
  const notificationIds = new Set(notifications.map(n => String(n._id)));
  return {
    notificationIds,
    fetch: { total, fetched: notifications.length },
    admit: ref => {
      // `refId` on both lookups, so a populated `{_id}` ref resolves as a bare ObjectId does.
      const eagleId = refId(ref);
      if (!eagleId) return null;
      const projectId = projectIndex.resolve(eagleId);
      const parent = pickParent(
        projectId ? { id: projectId } : null,
        notificationIds.has(eagleId) ? { id: eagleId } : null
      );
      return parent ? parent.id : null;
    }
  };
}

// An empty upstream (`searchResults: []`, total 0) passes every completeness gate, so only this cap
// stops it computing the whole corpus as surplus; `--max-surplus` lifts it.
const surplusCeiling = (rowCount, maxSurplus) =>
  Math.max(50, Math.ceil(rowCount * 0.02), maxSurplus || 0);

/**
 * Where every surplus id goes. The console preview is capped at 20 — this file is not, because a
 * real reconcile can carry tens of thousands and "which rows went" has to outlive the run.
 */
function reconcileLogPath(now, dir = '/home') {
  if (process.env.RECONCILE_LOG) return process.env.RECONCILE_LOG;
  const name = `reconcile-${now}.ndjson`;
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return path.join(dir, name);
  } catch {
    // The devbox user cannot write `/home`, so the log lands in the working directory instead.
    return path.resolve(name);
  }
}

/**
 * Deletes through `remove`, the DELETE controllers' helper: a second delete path would forget the
 * search index, which no indexer cleans up.
 * @param {Array}    rows      `{id, ...}` read out of Cosmos
 * @param {function} keyOf     row -> the key to test against `fetched`
 * @param {Set}      fetched   keys the upstream fetch produced
 * @param {function} remove    row -> Promise, called ONLY when live; `{ rowKept: true }` = not deleted
 * @param {string}   [opts.logPath] NDJSON sink for every surplus id, dry run included
 * @param {object}   [opts.audit]   `utils/audit`, called once per row deleted or kept by a failed purge
 * @param {function} [opts.spare]   row -> true to leave a surplus row in place this run; dry runs ask too, so `wouldKeep` and `wouldDelete` match a live run
 * @param {function} [opts.servedUpstream] row -> true when eagle-api still serves it, so never deleted
 * @param {boolean}  [opts.held]    a surplus row still live upstream holds every delete: the rest log held
 * @returns `kept` = rows a failed purge left behind, `wouldKeep` = ids `spare` left in place, `keptLive` = ids eagle-api still serves
 */
async function reconcileContainer(label, rows, keyOf, fetched, remove,
  { live, logPath, audit, spare = () => false, servedUpstream = () => false, held = false }) {
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
  const kept = [];
  const wouldKeep = [];
  const keptLive = [];
  try {
    for (const row of surplus) {
      const upstream = Boolean(servedUpstream(row));
      const spared = !upstream && Boolean(spare(row));
      // A purge that could not clear a row's chunks keeps the row; the next reconcile retries it.
      const failed = live && !spared && !upstream && Boolean((await remove(row))?.rowKept);
      const removed = live && !spared && !upstream && !failed;
      if (spared) wouldKeep.push(row.id);
      if (upstream) keptLive.push(row.id);
      if (failed) kept.push({ id: row.id, partitionKey: partitionOf(row) });
      if (removed) deleted++;
      // The DELETE controllers' own event, so a purge is traceable however it was issued. A failed
      // one is recorded too: its search-index entries are already gone.
      if (audit && (removed || failed)) {
        audit.auditEvent(null, {
          action: `${singular}.delete`,
          ...(failed ? { outcome: 'failure' } : {}),
          targetType: singular,
          targetId: row.id,
          projectId: partitionOf(row),
          detail: { source: 'seed --reconcile', ...(failed ? { rowKept: true } : {}) }
        });
      }
      // Written AFTER the delete lands, so a throw mid-run leaves a file naming exactly what went.
      if (fd !== null) {
        fs.writeSync(fd, JSON.stringify(
          { label, id: row.id, partitionKey: partitionOf(row), deleted: removed,
            ...(spared || failed || upstream ? { kept: true } : {}), ...(upstream ? { keptLive: true } : {}),
            ...(held && !spared && !upstream ? { held: true } : {}) }) + '\n');
      }
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return {
    inCosmos: rows.length, wouldDelete: surplus.length - wouldKeep.length - keptLive.length, deleted,
    ...(wouldKeep.length ? { wouldKeep } : {}), ...(keptLive.length ? { keptLive } : {}),
    ...(kept.length ? { kept } : {})
  };
}

// Checked against the built data before writing, so a dry run catches a regression; failures are
// collected, not thrown, so one run reports every one.
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

function verifyItems(items, label, partitionField, projectRead) {
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

  // Cross-entity: an item may never out-rank its parent. Rows whose partition key is not a project
  // — notification-parented documents — have no parent ACL to compare against and are exempt.
  if (projectRead) {
    const escaped = items.filter(i => {
      const parent = projectRead.get(String(i[partitionField]));
      return parent && Array.isArray(i.read) && i.read.includes('public') && !parent.includes('public');
    });
    if (escaped.length) {
      failures.push(`${escaped.length} ${label} are public under a non-public project — ` +
        escaped.slice(0, 20).map(i => i.id).join(', '));
    }
  }

  return failures;
}

function log(...parts) {
  console.log(...parts);
}

const SUMMARY_MAX_BYTES = 3072;
const SUMMARY_LIST_CAP = 20;

const countsOf = obj => Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => typeof v === 'number'));

const reconcileCounts = r => r && {
  inCosmos: r.inCosmos, wouldDelete: r.wouldDelete, deleted: r.deleted,
  ...(r.wouldKeep ? { wouldKeep: r.wouldKeep.length } : {}),
  ...(r.keptLive ? { keptLive: r.keptLive.length } : {}),
  ...(r.surplusHeld !== undefined ? { surplusHeld: r.surplusHeld } : {}), ceiling: r.ceiling
};

/** The `--summary` file: counts only, failures capped, so a wrapper can fetch and parse it whole. */
function compactSummary(summary) {
  const { projects, ...otherStages } = summary.stages;
  const compact = {
    mode: summary.mode,
    failureCount: summary.failures.length,
    failures: summary.failures.slice(0, SUMMARY_LIST_CAP).map(f => f.slice(0, 200)),
    track: summary.track || null,
    reconcile: summary.reconcile ? {
      log: summary.reconcile.log,
      documents: reconcileCounts(summary.reconcile.documents),
      projects: reconcileCounts(summary.reconcile.projects)
    } : null,
    keep: (summary.keep || []).slice(0, SUMMARY_LIST_CAP),
    stages: {
      ...(projects ? { projects: { ...countsOf(projects), report: countsOf(projects.report) } } : {}),
      ...Object.fromEntries(Object.entries(otherStages).map(([name, stage]) => [name, countsOf(stage)]))
    }
  };
  // One failure always survives, so a trimmed summary can never read as a pass.
  while (JSON.stringify(compact).length > SUMMARY_MAX_BYTES && compact.failures.length > 1) {
    compact.failures.pop();
  }
  return compact;
}

/**
 * Per `--keep-ids` entry: the Cosmos row it names, whether the reconcile computed that row as
 * surplus and spared it, and the Track project the registry matched it to (a match needs review).
 */
async function keepReport(keepIds, { projects, projectRows, documentRows, surplusIds, sparedIds, getProject }) {
  const report = [];
  for (const id of keepIds) {
    const names = row => String(row.id) === id || String(row.eagleId) === id;
    const built = projects.find(names);
    const row = projectRows.find(names) || documentRows.find(r => String(r.id) === id) ||
      await getProject(built ? built.id : id);
    const rowId = row ? String(row.id) : null;
    report.push({
      id, rowId, trackProjectId: built?.trackProjectId ?? null,
      surplus: surplusIds.has(rowId), kept: sparedIds.has(rowId)
    });
  }
  return report;
}

async function seed(argv = [], deps = {}) {
  const args = parseArgs(argv);
  const summary = { mode: args.live ? 'live' : 'dry-run', stages: {}, failures: [] };
  try {
    return await runSeed(args, deps, summary);
  } catch (err) {
    summary.failures.push(`fatal: ${err.message}`);
    throw err;
  } finally {
    if (args.summary) fs.writeFileSync(args.summary, JSON.stringify(compactSummary(summary)) + '\n');
  }
}

async function runSeed(args, deps, summary) {
  const now = deps.now || new Date().toISOString();
  const src = deps.sources || sources;
  const repos = deps.repos || {
    projects: projectsRepo,
    documents: documentsRepo,
    boundaries: boundariesRepo,
    links: linksRepo,
    chunks: chunksRepo
  };
  const purge = deps.purge || purgeHelpers;
  const audit = deps.audit || auditHelpers;
  const access = systemAccess();
  // Reading what is already there needs Cosmos. A live run always has it; a dry run only when the
  // operator is inside the private endpoint and set COSMOS_ENDPOINT.
  const cosmosReady = deps.cosmosReady !== undefined
    ? deps.cosmosReady
    : Boolean(process.env.COSMOS_ENDPOINT);
  // A purge also deletes the index entry, and `deleteFromIndex` returns 0 rather than throwing when
  // SEARCH_ENDPOINT is unset — so a purge would leave the row searchable with nothing to notice it.
  const searchReady = deps.searchReady !== undefined
    ? deps.searchReady
    : aiSearch.config().configured;

  summary.track = { source: src.trackFeedConfigured() ? 'api' : 'file', count: null };
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
  // Always built, even outside --only: every other stage resolves its partition key from this index.
  log('Loading Track projects...');
  const trackProjects = await src.loadTrackProjects();
  log(`  ${trackProjects.length} Track projects from ${summary.track.source === 'api' ? 'the Track API' : 'the checked-in export'}`);
  summary.track.count = trackProjects.length;

  log('Fetching Eagle projects...');
  // The settled upstream total, captured because `--reconcile` refuses to delete unless the fetch
  // passed the searchResultsTotal gate in sources.js — a null total means that gate never ran.
  let projectsTotal = null;
  const eagleProjects = await src.fetchEagleProjects({ onTotal: (total) => { projectsTotal = total; } });
  log(`  ${eagleProjects.length} from eagle-api`);

  // The search returns `pins` as bare ObjectIds; the push sends `{_id, name, province}`. The
  // lookup is what lets the merge land the same shape from either feed.
  const orgs = await src.fetchOrganizationLookup();
  log(`  ${orgs.size} organizations for pin and proponent resolution`);

  const { projects, report } = buildRegistry(trackProjects, eagleProjects, { now, orgs });
  log(`  merged: ${report.matched} matched · ${report.trackOnlyNoGuid} Track without epic_guid · ` +
    `${report.trackOnlyDanglingGuid} dangling · ${report.eagleOnly} Eagle-only = ${report.total}`);
  if (report.danglingGuids.length) {
    log(`  dangling epic_guids: ${report.danglingGuids.slice(0, 5).join(', ')}`);
  }

  const projectIndex = buildProjectIndex(projects);
  // Parent ACLs by canonical id: documents are narrowed against these, and the pre-write gate
  // checks the same invariant.
  const projectRead = new Map(projects.map(p => [String(p.id), p.read]));
  summary.stages.projects = { built: projects.length, report, written: 0, visCarried: 0, shortLinks: 0 };

  const projectFailures = verifyProjects(projects);
  summary.failures.push(...projectFailures);

  if (args.only.includes('projects')) {
    if (args.live) {
      // Projects partition on /id, so every project is its own partition and bulk cannot batch
      // across them. 392 sequential upserts is a few seconds.
      for (const project of projects) {
        // A Cosmos upsert replaces the item, so without this every re-seed wipes vis and any
        // source block the run itself did not rebuild.
        const existing = await repos.projects.getById(access, project.id);
        if (existing) {
          if (existing.vis) {
            project.vis = existing.vis;
            summary.stages.projects.visCarried++;
          }
          // A minted code is printable, so a re-seed must never mint a second one for the project,
          // nor drop the legacy codes that still resolve to it.
          carryShortLink(project, existing);
          project.sources = { ...existing.sources, ...project.sources };
          // The public search lacks applicableRegulation, featuredDocuments and the push bookkeeping; carried
          // over so a re-seed neither blanks them nor lets an applied push land again.
          carryEagleOnlyFields(project, existing);
          carryDemiOnlyFields(project, existing);
        } else if (project.eagleId && !isEagleOnlyProjectId(project.id)) {
          // A Track row built for the first time beside its `eagle-<id>` twin takes the twin's
          // tags, the same as the Track relink.
          const twinId = eagleOnlyProjectId(String(project.eagleId));
          carryDemiOnlyFields(project, await repos.projects.getById(access, twinId));
        }
        // Counted as minted, not as held: the carry above already answered for the rest.
        const heldCode = project.shortCode;
        await ensureProjectShortLink(project, { links: repos.links, projects: repos.projects });
        if (project.shortCode !== heldCode) summary.stages.projects.shortLinks++;
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

    log('Fetching Project Notifications (the other document parent)...');
    const { admit, notificationIds, fetch } = await documentAdmission(src, projectIndex);
    notificationFetch = fetch;
    log(`  ${notificationIds.size} notifications`);

    // Reported, never repaired here: the project row is retained and flagged, and `pickParent`
    // already keeps it from claiming the notification's children.
    const shadowedProjects = notificationShadowedProjects(projects, notificationIds);
    if (shadowedProjects.length) {
      log(`  ${shadowedProjects.length} project row(s) carry a notification id as eagleId — ` +
        `${shadowedProjects.slice(0, 5).map(p => `${p.id}->${p.eagleId}`).join(', ')}; ` +
        'their Eagle children file under the notification, not under the project');
    }

    log('Streaming Eagle documents (60k+, paged at 100)...');

    const buffers = new Map();          // projectId -> pending raw docs
    const perProject = new Map();       // projectId -> total transformed
    const unresolvedRefs = new Set();
    // Complete, not capped: the reconcile gate intersects these against the ids in Cosmos, and a
    // sample would let a dropped row that IS in Cosmos through.
    const droppedIds = [];
    const stats = {
      fetched: 0, built: 0, unresolved: 0, notificationParented: 0,
      noKey: 0, preserved: 0, written: 0, writeFailed: 0,
      // Documents and chunk operations (~19 per document) are counted apart so both stay readable.
      reStamped: 0, reStampFailedDocuments: 0, reStampFailedChunks: 0, reStampSkipped: 0,
      // `pendingRaised` counts flags written (would be, in a dry run); the other three are their fates:
      // cleared, `conflict` (a newer write owns it), `missing` (row gone before the clear).
      pendingRaised: 0, pendingCleared: 0, pendingConflicts: 0, pendingMissed: 0,
      // Documents left flagged because their re-stamp did not land. Capped in the summary, as
      // the dropped ids beside it are.
      pendingLeftRaised: []
    };
    // Run-wide, so a systematic fault names its first few documents and then goes quiet.
    let reStampErrorsLogged = 0;
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

    // The registry's read is Eagle's, so a project DEMI holds caps its documents at the STORED
    // level (dry run and `--only documents` included). Set in place: the pre-write gate reads it.
    const heldChecked = new Set();
    const holdParentRead = async (projectId) => {
      const key = String(projectId);
      if (!cosmosReady || heldChecked.has(key) || !projectRead.has(key)) return;
      heldChecked.add(key);
      projectRead.set(key, heldRead(projectRead.get(key), await repos.projects.getById(access, key)));
    };

    const flush = async (projectId, rawDocs) => {
      // Transformed here, where the partition is known: the extraction state a re-seed carries forward is
      // read per partition, and an upsert without it marks the corpus unextracted.
      const existingRows = await existingFor(projectId);
      await holdParentRead(projectId);
      const docs = [];
      // Chunks keep their own copy of these refs (`chunks.CHUNK_PARENT_FIELDS`); patched only after the
      // write lands, so a row that failed to save never triggers a re-stamp.
      const reStamp = [];
      // Newest token this flush minted: a chunk stamped with it is current for every flag in the batch,
      // so a later repair cannot undo this flush.
      let stampedAt = null;
      for (const raw of rawDocs) {
        const existing = existingRows && existingRows.get(String(raw._id));
        if (existing) stats.preserved++;
        const transformed = transform.transformDocument(raw, projectId, listLookup,
          { now, existing, projectRead: projectRead.get(projectId) });
        // Only against a row DEMI already had: a document being written for the first time has no
        // chunks yet, and the ingest that creates them stamps the fields itself.
        let row = transformed;
        if (existing && repos.chunks.parentFieldsChanged(existing, transformed)) {
          // Flag rides the same upsert as the change (`document.js stampParentFieldsPending`), so a killed
          // run stays visible to the reconcile. No etag: offline, nothing else writes this corpus.
          row = { ...transformed, ...repos.documents.pendingRaiseOps(existing.parentFieldsPendingAt) };
          if (!stampedAt || row.parentFieldsPendingAt > stampedAt) {
            stampedAt = row.parentFieldsPendingAt;
          }
          reStamp.push(row);
        }
        if (!row.s3Key) stats.noKey++;
        // id is unique per PARTITION in Cosmos, so a repeat within one project silently
        // overwrites. Counted so a shortfall is attributable rather than mysterious.
        const key = `${projectId}|${row.id}`;
        if (fetchedKeys.has(key)) duplicateIds++; else fetchedKeys.add(key);
        docs.push(row);
      }
      // Counted outside the write, so a dry run reports how many rows this seed would put on the
      // reconcile line without writing one of them.
      stats.pendingRaised += reStamp.length;

      // Verify each batch rather than the whole corpus: the gates are per-item, and holding
      // 60,661 documents just to check them is what streaming exists to avoid.
      gateFailures.push(...verifyItems(docs, 'documents', 'projectId', projectRead));
      if (args.live) {
        // Count what landed, not what was sent: Cosmos bulk reports per-operation status and never throws.
        const r = await repos.documents.bulkUpsertForProject(projectId, docs);
        stats.written += r.succeeded;
        stats.writeFailed += r.failed;
        for (const [code, n] of Object.entries(r.statusCounts)) {
          writeStatus[code] = (writeStatus[code] || 0) + n;
        }

        // Best-effort like the API path: a failure stays on the row as `parentFieldsPending` for
        // `backfill-chunk-parent-fields.js --pending`; `failedIds` keeps unlanded rows' chunks untouched.
        if (reStamp.length) {
          const restamp = await repos.chunks.reStampAfterWrite(access, reStamp, r.failedIds || [], {
            // Newer-only: a chunk a later walk already stamped keeps what it has and comes back as
            // `skippedNewer`, so a slow flush cannot put stale values back.
            stampedAt,
            // Fires once per DOCUMENT, so the cap counts documents rather than going quiet after
            // the first document whose chunks all failed.
            onError: (doc, err) => {
              if (++reStampErrorsLogged <= chunksRepo.MAX_LOGGED_RESTAMP_ERRORS) {
                log(`  WARNING: chunk parent-field patch failed for ${doc.id}: ${err.message}`);
              }
            }
          });
          stats.reStamped += restamp.stamped;
          stats.reStampFailedDocuments += restamp.failedDocuments;
          stats.reStampFailedChunks += restamp.failedChunks;
          stats.reStampSkipped += restamp.skipped;

          // Cleared only against this flush's token: a push or edit that landed meanwhile raised a newer
          // flag, and clearing it would hide that drift; a mismatch comes back as `conflict`.
          const stamped = new Map(reStamp.map(d => [String(d.id), d]));
          for (const id of restamp.stampedDocumentIds) {
            // The row's own projectId, never the loop's — `setParentFieldsPending` partitions on
            // it, and it is what the transform wrote onto the row.
            const doc = stamped.get(String(id));
            const outcome = await repos.documents.setParentFieldsPending(
              doc.id, doc.projectId, false, { pendingAt: doc.parentFieldsPendingAt });
            if (outcome.status === 'cleared') stats.pendingCleared++;
            else if (outcome.status === 'conflict') stats.pendingConflicts++;
            else stats.pendingMissed++;
          }
          // Left raised deliberately: their chunks hold a mix of old and new values, which is the
          // state the repair exists for. Named as well as counted — a count cannot say WHICH.
          stats.pendingLeftRaised.push(...restamp.failedDocumentIds);
        }
      }
    };

    const { count, total: documentsTotal } = await src.streamEagleDocuments(async (page, fetched, total) => {
      stats.fetched = fetched;

      for (const doc of page) {
        if (stats.built + stats.unresolved >= args.limitDocuments) break;

        // `documentAdmission` above holds the rule and why it admits a notification id.
        const projectId = admit(doc.project);
        if (projectId && notificationIds.has(projectId)) stats.notificationParented++;

        if (!projectId) {
          // Dropped, not filed under an invented parent; refs go into the summary so a new class of drops
          // shows in the run output.
          stats.unresolved++;
          unresolvedRefs.add(String(doc.project));
          droppedIds.push(String(doc._id));
          continue;
        }

        stats.built++;
        perProject.set(projectId, (perProject.get(projectId) || 0) + 1);

        if (!buffers.has(projectId)) buffers.set(projectId, []);
        buffers.get(projectId).push(doc);
      }

      // _id-ordered pages cluster by project, so a full buffer is usually its last; upserts are
      // idempotent, so splitting a project across batches is safe.
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
    if (stats.reStamped || stats.reStampFailedDocuments) {
      log(`  ${stats.reStamped} documents changed type/milestone/phase/author type — ` +
        `their chunks were re-stamped`);
    }
    if (stats.reStampFailedDocuments || stats.reStampFailedChunks) {
      // NOT a seed failure: the document rows are authoritative and landed. Named so the operator
      // knows to run backfill-chunk-parent-fields.js --live, which is the repair.
      log(`  WARNING: ${stats.reStampFailedDocuments} documents were not fully re-stamped ` +
        `(${stats.reStampFailedChunks} chunk operations rejected; a document whose patch threw ` +
        'reports none) — those chunks answer the OLD document filter; run ' +
        'backfill-chunk-parent-fields.js --live');
    }
    if (stats.reStampSkipped) {
      // Already counted in writeFailed, which is a seed failure on its own. Named separately so
      // the chunk shortfall is not read as a second, independent fault.
      log(`  ${stats.reStampSkipped} documents had their chunk re-stamp skipped: the row write ` +
        'was rejected, so the chunks were left matching the row that is still in Cosmos');
    }
    if (stats.pendingRaised) {
      log(`  ${stats.pendingRaised} documents were written flagged parentFieldsPending; ` +
        `${stats.pendingCleared} cleared after their chunks landed, ` +
        `${stats.pendingConflicts} left to a newer write, ${stats.pendingMissed} row gone`);
    }
    if (stats.pendingLeftRaised.length) {
      // The list the operator repairs from. These rows stay on the reconcile line until a landed
      // re-stamp takes them off, which is what `--pending` is for.
      log(`  ${stats.pendingLeftRaised.length} documents are still flagged parentFieldsPending ` +
        `(${stats.pendingLeftRaised.slice(0, 20).join(', ')}) — run ` +
        'backfill-chunk-parent-fields.js --pending --live');
    }

    summary.stages.documents = {
      fetched: count,
      built: stats.built,
      notificationParented: stats.notificationParented,
      // Which project rows hold a notification id in `eagleId`, and so would have claimed those
      // children before `pickParent` gave the notification precedence.
      notificationShadowedProjects: shadowedProjects,
      droppedUnresolvable: stats.unresolved,
      // Capped: an upstream fault could yield thousands of refs, and the summary prints in full.
      distinctUnresolvedRefs: unresolvedRefs.size,
      unresolvedRefs: [...unresolvedRefs].slice(0, 20),
      droppedIds: droppedIds.slice(0, 20),
      withoutObjectKey: stats.noKey,
      preserved: stats.preserved,
      duplicateIds,
      projects: perProject.size,
      written: stats.written,
      writeFailed: stats.writeFailed,
      documentsReStamped: stats.reStamped,
      reStampFailedDocuments: stats.reStampFailedDocuments,
      reStampFailedChunks: stats.reStampFailedChunks,
      reStampSkipped: stats.reStampSkipped,
      pendingRaised: stats.pendingRaised,
      pendingCleared: stats.pendingCleared,
      pendingConflicts: stats.pendingConflicts,
      pendingMissed: stats.pendingMissed,
      // Capped: a systematic chunk fault flags the whole corpus and the summary is printed whole.
      pendingLeftRaised: stats.pendingLeftRaised.slice(0, 20),
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

    documentFetch = { keys: fetchedKeys, total: documentsTotal, fetched: count, droppedIds };
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
  // A fetch whose re-read total differs from the unique ids that arrived refuses both deletions.
  if (args.reconcile) {
    const unverified = [
      ['Project', projectsTotal, eagleProjects.length],
      ['ProjectNotification', notificationFetch && notificationFetch.total,
        notificationFetch && notificationFetch.fetched],
      ['Document', documentFetch && documentFetch.total, documentFetch && documentFetch.fetched]
    ].filter(([, total, fetched]) => typeof total !== 'number' || total !== fetched);

    // A document the seed could not place is absent from the fetch and reads as surplus, so a drop
    // that IS in Cosmos refuses — matched on id alone, a dropped document having no partition.
    const documentRows = unverified.length ? [] : await repos.documents.listSeededIds(access);
    const projectRows = unverified.length ? [] : await repos.projects.listEagleOnlyIds(access);
    const inCosmos = new Set(documentRows.map(row => String(row.id)));
    const dropped = (documentFetch || {}).droppedIds || [];
    const droppedInCosmos = dropped.filter(id => inCosmos.has(id));

    const surplusIds = new Set();
    const sparedIds = new Set();

    const truncated = await truncatedReads(access, unverified.length ? [] : [
      ['documents', documentRows, repos.documents.countSeededIds],
      ['projects', projectRows, repos.projects.countEagleOnlyIds]
    ]);

    if (unverified.length) {
      summary.failures.push('--reconcile refused before any delete — nothing removed from either ' +
        `container: the ${unverified.map(([label]) => label).join(' and ')} fetch was never ` +
        'verified complete against a searchResultsTotal');
    } else if (droppedInCosmos.length) {
      summary.failures.push('--reconcile refused before any delete — nothing removed from either ' +
        `container: ${droppedInCosmos.length} of the ${dropped.length} document(s) that resolved ` +
        'to neither a project nor a ProjectNotification are in Cosmos, so they are absent from ' +
        'the fetch and would be deleted as surplus');
    } else if (truncated.length) {
      summary.failures.push('--reconcile refused before any delete — nothing removed from either ' +
        `container: ${truncated.join('; ')}`);
    } else if (args.live && !searchReady) {
      summary.failures.push('--reconcile refused before any delete — nothing removed from either ' +
        'container: SEARCH_ENDPOINT is not set, so every index delete would be a silent no-op and ' +
        'the purged rows would stay searchable with no indexer to clean them up');
    } else {
      // Documents first: a project whose documents are already gone cannot orphan any.
      const containers = [
        ['documents', documentRows,
          row => `${row.projectId}|${row.id}`, documentFetch.keys,
          row => purge.purgeDocument(row)],
        ['projects', projectRows,
          row => String(row.eagleId), new Set(eagleProjects.map(p => String(p._id))),
          row => purge.purgeProject(row)]
      ];
      // Both containers sized BEFORE either delete, so a breach in one stops the other too.
      const sized = containers.map(([label, rows, keyOf, fetched]) => ({
        label, surplus: surplusOf(rows, keyOf, fetched), ceiling: surplusCeiling(rows.length, args.maxSurplus)
      }));
      const breached = sized.filter(c => c.surplus.length > c.ceiling);

      if (breached.length) {
        summary.failures.push('--reconcile refused before any delete — nothing removed from ' +
          'either container: ' + breached.map(c =>
            `${c.label} surplus ${c.surplus.length} exceeds the ceiling ${c.ceiling}`).join('; ') +
          '. Re-run with --max-surplus <n> if the deletion really is that large.');
      }

      // Skipped on a breach: nothing is deleted then, and an empty upstream would cost one GET per row.
      const servedIds = { documents: new Set(), projects: new Set() };
      if (!breached.length) {
        const fetchedDocIds = new Set([...documentFetch.keys].map(key => key.slice(key.indexOf('|') + 1)));
        for (const { label, surplus } of sized) {
          for (const row of surplus) {
            // A document fetched under another parent moved: its old row is surplus, not skipped.
            if (label === 'documents' && fetchedDocIds.has(String(row.id))) continue;
            const served = label === 'documents'
              ? await src.eagleRowLive('Document', String(row.id))
              : await src.eagleRowLive('Project', String(row.eagleId));
            if (served) servedIds[label].add(String(row.id));
          }
        }
      }
      const keptLive = servedIds.documents.size + servedIds.projects.size;
      if (keptLive) {
        summary.failures.push(`reconcile: ${keptLive} surplus ids still live upstream, fetch skipped ` +
          'rows — nothing removed from either container');
      }
      const servedUpstream = label => row => servedIds[label].has(String(row.id));

      // Reported either way: a dry run must still show wouldDelete and that it would refuse.
      const live = args.live && !breached.length && !keptLive;
      const logPath = reconcileLogPath(now);
      summary.reconcile = { log: logPath };
      if (!searchReady) summary.reconcile.search = 'unconfigured — live would refuse';
      const keepIds = args.keepIds || new Set();
      const listed = id => keepIds.has(String(id));
      const listedProject = row => listed(row.id) || listed(row.eagleId);
      // A listed project spares its documents too, so the keep file can name projects only.
      const keptProjects = new Set([...keepIds,
        ...[...projectRows, ...projects].filter(listedProject).map(p => String(p.id))]);
      const spareDocument = row => listed(row.id) || keptProjects.has(String(row.projectId));
      summary.reconcile.documents = await reconcileContainer(...containers[0],
        { live, logPath, audit, spare: spareDocument, servedUpstream: servedUpstream('documents'), held: keptLive > 0 });
      // A project still holding a kept or spared document stays too, or that document is orphaned.
      const keptDocs = summary.reconcile.documents.kept || [];
      const failedHolding = new Set(keptDocs.map(k => String(k.partitionKey)));
      const holding = new Set([...failedHolding,
        ...documentRows.filter(spareDocument).map(row => String(row.projectId))]);
      summary.reconcile.projects = await reconcileContainer(...containers[1],
        { live, logPath, audit, spare: row => listedProject(row) || holding.has(String(row.id)),
          servedUpstream: servedUpstream('projects'), held: keptLive > 0 });
      for (const { label, surplus, ceiling } of sized) {
        summary.reconcile[label].ceiling = ceiling;
        // A live row held both containers back, so a dry run must report the 0 a live run deletes.
        if (keptLive) {
          summary.reconcile[label].surplusHeld = summary.reconcile[label].wouldDelete;
          summary.reconcile[label].wouldDelete = 0;
        }
        for (const row of surplus) surplusIds.add(String(row.id));
        for (const id of summary.reconcile[label].wouldKeep || []) sparedIds.add(String(id));
      }
      if (keptDocs.length) {
        const heldProjects = (summary.reconcile.projects.wouldKeep || [])
          .filter(id => failedHolding.has(String(id)));
        const idsOf = ids => ids.slice(0, 20).join(', ');
        summary.failures.push(`--reconcile kept ${keptDocs.length} document row(s) whose chunks ` +
          `could not all be removed (documents: ${idsOf(keptDocs.map(k => k.id))})` +
          (heldProjects.length
            ? ` and ${heldProjects.length} project row(s) holding them (projects: ${idsOf(heldProjects)})`
            : '') +
          '; re-run to retry');
      }
      log(`  surplus ids: ${logPath}`);
    }

    if (args.keepIds) {
      summary.keep = await keepReport(args.keepIds, {
        projects, projectRows, documentRows, surplusIds, sparedIds,
        getProject: id => repos.projects.getById(access, id)
      });
      log(`  keep report: ${JSON.stringify(summary.keep)}`);
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
  surplusOf,
  truncatedReads,
  documentAdmission,
  reconcileContainer,
  reconcileLogPath,
  compactSummary,
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

  // A dry run needs no database, so it runs outside the private endpoint; COSMOS_ENDPOINT enables
  // the `preserved`/`wouldDelete` reads, and `--reconcile` without it refuses.
  if (args.live || process.env.COSMOS_ENDPOINT) initCosmosClient();

  seed(process.argv.slice(2))
    .then(async summary => {
      // Audit rows buffer behind an unref'd timer, so process.exit would drop the purge trail.
      await auditHelpers.flush().catch(err => logger.error(`[seed] audit flush: ${err.message}`));
      // A failed gate must not exit 0 — a wrapper script would read that as success.
      process.exit(summary.failures.length ? 1 : 0);
    })
    .catch(err => {
      console.error('[seed] Fatal:', err);
      process.exit(1);
    });
}
