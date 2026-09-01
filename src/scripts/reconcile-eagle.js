'use strict';

/**
 * Diff the published Eagle id sets against the rows the Eagle push mirrored into DEMI.
 *
 * eagle-api hard-deletes with no tombstone, so the push cannot tell DEMI a row is gone. This
 * reports both directions and CHANGES NOTHING — a DEMI row absent from Eagle's public search may
 * equally be one Eagle merely unpublished, and eagle-api gives an anonymous caller no way to tell
 * the two apart (see `unpublishedOrDeleted` below), so there is nothing here it is safe to delete.
 *
 *   node src/scripts/reconcile-eagle.js [--json]
 *
 * Runs on the devbox via `demi-run` — same recipe as the other database scripts,
 * see README "Running anything against the database". Alert on the one `drift=` line, clean is 0.
 * The API app also runs `run()` nightly on a Functions timer when RECONCILE_SCHEDULE is set — see
 * api/index.js, and azure/modules/observability.bicep for the alert that reads the line.
 *
 * A document only counts as `eagleOnly` when seed-nosql would seed it. That is not a rule
 * restated here: `documentAdmission` IS seed-nosql's own function, run over the same merged
 * project registry. The rest report separately under `unresolvedParent`, since seed-nosql drops
 * them too and they are not push drift.
 */

const sources = require('../seed/sources');
const projects = require('../repositories/projects');
const documents = require('../repositories/documents');
const { buildRegistry, buildProjectIndex } = require('../merge/project');
const { surplusOf, truncatedReads, documentAdmission } = require('./seed-nosql');
const { systemAccess } = require('../helpers/access-sql');
const { logger } = require('../utils/logger');

function parseArgs(argv) {
  const args = { json: false };
  for (const a of argv) {
    if (a === '--json') args.json = true;
    else throw new Error(`[reconcile] unknown argument: ${a}`);
  }
  return args;
}

/**
 * Both directions in one pass.
 *
 * `pushOwned` is why projects need every row carrying an `eagleId` and not just the
 * `sourceSystem: 'eagle'` ones: a Track-sourced row also holds an `eagleId`, so reading only the
 * Eagle-sourced rows would compute ~350 matched projects as missing from DEMI. It is in the
 * membership test and out of the push's own drift.
 *
 * @param {Array}    rows             DEMI rows
 * @param {function} keyOf            row -> the Eagle id it mirrors
 * @param {Set}      eagleIds         ids Eagle currently publishes
 * @param {function} pushOwned        row -> is this row the Eagle push's to keep in step
 * @param {function} parentPublished  eagleId -> is the id's parent project published (default: yes)
 */
function diff(rows, keyOf, eagleIds, pushOwned = () => true, parentPublished = () => true) {
  const inDemi = new Set(rows.map(keyOf));
  const absent = surplusOf(rows, keyOf, eagleIds);
  const missing = [...eagleIds].filter(id => !inDemi.has(id));
  return {
    unpublishedOrDeleted: absent.filter(pushOwned),
    trackOnly: absent.filter(row => !pushOwned(row)),
    eagleOnly: missing.filter(parentPublished),
    unresolvedParent: missing.filter(id => !parentPublished(id))
  };
}

/** The line a log alert matches. `drift=0` is clean. */
function summaryLine(summary) {
  const { projects: p, documents: d } = summary;
  return '[reconcile] ' +
    `projects: unpublishedOrDeleted=${p.unpublishedOrDeleted.length} eagleOnly=${p.eagleOnly.length} ` +
    `documents: unpublishedOrDeleted=${d.unpublishedOrDeleted.length} eagleOnly=${d.eagleOnly.length} ` +
    `unresolvedParent=${d.unresolvedParent.length} ` +
    `drift=${summary.drift}`;
}

/**
 * @param {string[]} argv
 * @param {object} [deps] test seam: {sources, projects, documents}
 */
async function reconcile(argv = [], deps = {}) {
  parseArgs(argv);
  const src = deps.sources || sources;
  const projectsRepo = deps.projects || projects;
  const documentsRepo = deps.documents || documents;

  // systemAccess(), because a scoped context lists only what it can see: every row it cannot read
  // would compute as Eagle-only drift, and every unpublished row as gone from Eagle.
  const access = systemAccess();

  const summary = {
    eagle: src.EAGLE_API_BASE, projects: {}, documents: {}, drift: 0, failures: []
  };

  // Eagle first: `fetchAllPages` throws when a fetch falls short of the reported
  // `searchResultsTotal`, so a truncated read can never be mistaken for a shrunken corpus.
  const eagleProjects = await src.fetchEagleProjects();
  const eagleProjectIds = new Set(eagleProjects.map(p => String(p._id)));
  // The document gate, over the registry seed-nosql builds — a Track row's dangling epic_guid
  // resolves here exactly as it does there, so a document under one is drift, not unresolvable.
  const { admit } = await documentAdmission(src,
    buildProjectIndex(buildRegistry(src.loadTrackProjects(), eagleProjects).projects));
  const eagleDocumentIds = new Set();
  const eagleDocumentProject = new Map(); // doc id -> its Eagle project id
  await src.streamEagleDocuments(page => {
    for (const doc of page) {
      const id = String(doc._id);
      eagleDocumentIds.add(id);
      eagleDocumentProject.set(id, doc.project != null ? String(doc.project) : null);
    }
  });

  const projectRows = await projectsRepo.listWithEagleId(access);
  const documentRows = await documentsRepo.listSeededIds(access);

  summary.failures = (await truncatedReads(access, [
    ['projects', projectRows, projectsRepo.countWithEagleId],
    ['documents', documentRows, documentsRepo.countSeededIds]
  ])).map(short => `${short} — the diff below is computed off a truncated read`);

  const projectDiff = diff(projectRows, row => String(row.eagleId), eagleProjectIds,
    row => row.sourceSystem === 'eagle');
  const documentDiff = diff(documentRows, row => String(row.id), eagleDocumentIds, undefined,
    id => admit(eagleDocumentProject.get(id)) !== null);

  summary.projects = { inDemi: projectRows.length, inEagle: eagleProjectIds.size, ...projectDiff };
  summary.documents = { inDemi: documentRows.length, inEagle: eagleDocumentIds.size, ...documentDiff };
  summary.drift = projectDiff.unpublishedOrDeleted.length + projectDiff.eagleOnly.length +
    documentDiff.unpublishedOrDeleted.length + documentDiff.eagleOnly.length;

  return summary;
}

function report(summary, { json } = {}) {
  const lines = [`[reconcile] eagle=${summary.eagle}`];
  for (const label of ['projects', 'documents']) {
    const s = summary[label];
    // Capped: a real drift can carry thousands of ids and --json is where the full set lives.
    const preview = ids => ids.slice(0, 20).join(', ') + (ids.length > 20 ? ', …' : '');
    const line = (text, ids) =>
      lines.push(`  ${text}: ${ids.length}${ids.length ? ` — ${preview(ids)}` : ''}`);

    lines.push(`${label}: ${s.inDemi} mirrored in DEMI, ${s.inEagle} published in Eagle`);
    // NOT a delete list. eagle-api's `/api/public/{document,project}/{id}` answers `200 []` for a
    // deleted row AND for one that merely lost `public` from its `read[]` — both are what
    // `runDataQuery(..., ['public'], ...)` returns when nothing matches — so an anonymous caller
    // cannot tell an unpublished row from a hard-deleted one. Purging on this set would destroy
    // an unpublished row, its chunks and its index entries.
    // ponytail: report-only until eagle-api offers a tombstone or DEMI holds a credential that
    // can read unpublished rows; then this set can be probed one id at a time and purged.
    line('unpublishedOrDeleted (gone from Eagle\'s public search, NOT purged)',
      s.unpublishedOrDeleted.map(r => r.id));
    line('eagleOnly (the push missed these)', s.eagleOnly);
    if (s.unresolvedParent.length) {
      line('unresolvedParent (Eagle-only, but its own project is unpublished/gone — seed-nosql ' +
        'drops these too, not counted as drift)', s.unresolvedParent);
    }
    if (s.trackOnly.length) {
      lines.push(`  ${s.trackOnly.length} Track-sourced project(s) are also gone from Eagle's ` +
        'public search — that is close-unpublished-track-projects.js, not the push');
    }
  }
  for (const f of summary.failures) lines.push(`  ✗ ${f}`);
  if (json) {
    const ids = s => ({
      unpublishedOrDeleted: s.unpublishedOrDeleted.map(r => r.id), eagleOnly: s.eagleOnly,
      unresolvedParent: s.unresolvedParent
    });
    lines.push(JSON.stringify(
      { projects: ids(summary.projects), documents: ids(summary.documents) }, null, 2));
  }
  return lines.join('\n');
}

/**
 * One run, logging exactly what the CLI logs — the nightly schedule and the CLI must not be able
 * to produce different output, because the log alert matches only one of the two lines.
 *
 * No `live` option: this script changes nothing in any mode. See the header.
 *
 * @param {object} [opts] {json} full id sets, {deps} the same test seam `reconcile` takes
 */
async function run({ json = false, deps } = {}) {
  const summary = await reconcile([], deps);
  logger.info(report(summary, { json }));
  // Its own record, so a log alert matches this line and not the report body around it.
  logger.info(summaryLine(summary));
  return summary;
}

module.exports = { parseArgs, diff, summaryLine, reconcile, report, run };

if (require.main === module) {
  const { initCosmosClient } = require('../db/cosmos-nosql');

  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    logger.error(err.message);
    process.exit(1);
  }
  initCosmosClient();

  run({ json: args.json })
    .catch(err => {
      logger.error(`[reconcile] ${err.stack || err.message}`);
      process.exit(1);
    });
}
