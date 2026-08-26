'use strict';

/**
 * Diff the published Eagle id sets against the rows the Eagle push mirrored into DEMI.
 *
 * eagle-api hard-deletes (`findOneAndDelete`) and leaves no tombstone, so the push can never tell
 * DEMI a row is gone. DEMI-only ids are the purge candidates; Eagle-only ids are pushes that never
 * landed and are only ever reported — fixing those is the push's job.
 *
 *   node src/scripts/reconcile-eagle.js [--live] [--max-purge N] [--json]
 *
 * Report-only by default, exit 0 either way. Runs inside the app container over the SSH tunnel —
 * same recipe as the other database scripts, see README "Running anything against the database".
 * Alert contract: the one `[reconcile] … drift=<total>` line, clean is `drift=0`.
 */

const sources = require('../seed/sources');
const projects = require('../repositories/projects');
const documents = require('../repositories/documents');
const purgeHelpers = require('../helpers/purge');
const auditHelpers = require('../utils/audit');
const aiSearch = require('../search/ai-search');
const { systemAccess } = require('../helpers/access-sql');
const { logger } = require('../utils/logger');

/** Most rows one live run may purge before it refuses. Same shape as seed-nosql's --max-surplus. */
const DEFAULT_MAX_PURGE = 100;

function parseArgs(argv) {
  const args = { live: false, json: false, maxPurge: DEFAULT_MAX_PURGE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--json') args.json = true;
    else if (a === '--max-purge') args.maxPurge = Number(argv[++i]);
    else throw new Error(`[reconcile] unknown argument: ${a}`);
  }
  if (!Number.isInteger(args.maxPurge) || args.maxPurge <= 0) {
    throw new Error('[reconcile] --max-purge needs a positive integer');
  }
  return args;
}

/**
 * Both directions in one pass over the DEMI rows.
 *
 * `purgeable` is why projects need every row carrying an `eagleId` and not just the
 * `sourceSystem: 'eagle'` ones: a Track-sourced row also holds an `eagleId`, so reading only the
 * Eagle-sourced rows would compute ~350 matched projects as Eagle-only drift. It is in the
 * membership test and out of the purge set.
 *
 * @param {Array}    rows       DEMI rows
 * @param {function} keyOf      row -> the Eagle id it mirrors
 * @param {Set}      eagleIds   ids Eagle currently publishes
 * @param {function} purgeable  row -> may this row be purged when Eagle no longer has it
 */
function diff(rows, keyOf, eagleIds, purgeable = () => true) {
  const inDemi = new Set();
  const demiOnly = [];
  const kept = [];
  for (const row of rows) {
    const key = keyOf(row);
    inDemi.add(key);
    if (eagleIds.has(key)) continue;
    if (purgeable(row)) demiOnly.push(row);
    else kept.push(row);
  }
  return { demiOnly, kept, eagleOnly: [...eagleIds].filter(id => !inDemi.has(id)) };
}

/** The line a log alert matches. `drift=0` is clean. */
function summaryLine(summary) {
  const { projects: p, documents: d } = summary;
  return `[reconcile] projects: demiOnly=${p.demiOnly.length} eagleOnly=${p.eagleOnly.length} ` +
    `documents: demiOnly=${d.demiOnly.length} eagleOnly=${d.eagleOnly.length} drift=${summary.drift}`;
}

/** 1 only when a live run refused or a purge threw. A report never fails. */
function exitCodeFor(summary) {
  return summary.mode === 'live' && summary.failures.length ? 1 : 0;
}

/**
 * @param {string[]} argv
 * @param {object} [deps] test seam: {sources, projects, documents, purge, audit, searchReady}
 */
async function reconcile(argv = [], deps = {}) {
  const args = parseArgs(argv);
  const src = deps.sources || sources;
  const projectsRepo = deps.projects || projects;
  const documentsRepo = deps.documents || documents;
  const purge = deps.purge || purgeHelpers;
  const audit = deps.audit || auditHelpers;
  // A purge deletes the index entry too, and `deleteFromIndex` returns 0 rather than throwing when
  // SEARCH_ENDPOINT is unset — the row would stay searchable with no indexer to notice.
  const searchReady = deps.searchReady !== undefined
    ? deps.searchReady
    : aiSearch.config().configured;

  // systemAccess(), because a scoped context lists only what it can see: every row it cannot read
  // would compute as Eagle-only drift, and every unpublished row as a purge candidate.
  const access = systemAccess();

  const summary = {
    mode: args.live ? 'live' : 'report',
    eagle: src.EAGLE_API_BASE,
    projects: {}, documents: {}, drift: 0, failures: []
  };

  // Eagle first: `fetchAllPages` throws when a fetch falls short of the reported
  // `searchResultsTotal`, so a truncated read can never be mistaken for a shrunken corpus.
  const eagleProjectIds = new Set((await src.fetchEagleProjects()).map(p => String(p._id)));
  const eagleDocumentIds = new Set();
  await src.streamEagleDocuments(page => {
    for (const doc of page) eagleDocumentIds.add(String(doc._id));
  });

  const projectRows = await projectsRepo.listWithEagleId(access);
  const documentRows = await documentsRepo.listSeededIds(access);

  // A cross-partition enumeration that stopped early is indistinguishable from a container that
  // shrank: every row it missed reads as Eagle-only. A COUNT of the same predicate catches it.
  for (const [label, rows, expected] of [
    ['projects', projectRows, await projectsRepo.countWithEagleId(access)],
    ['documents', documentRows, await documentsRepo.countSeededIds(access)]
  ]) {
    if (rows.length !== expected) {
      summary.failures.push(`${label} enumerated ${rows.length} rows but the container holds ` +
        `${expected} — the diff below is computed off a truncated read`);
    }
  }

  const projectDiff = diff(projectRows, row => String(row.eagleId), eagleProjectIds,
    row => row.sourceSystem === 'eagle');
  const documentDiff = diff(documentRows, row => String(row.id), eagleDocumentIds);

  summary.projects = {
    inDemi: projectRows.length, inEagle: eagleProjectIds.size,
    demiOnly: projectDiff.demiOnly, eagleOnly: projectDiff.eagleOnly,
    trackOnly: projectDiff.kept.length, purged: 0
  };
  summary.documents = {
    inDemi: documentRows.length, inEagle: eagleDocumentIds.size,
    demiOnly: documentDiff.demiOnly, eagleOnly: documentDiff.eagleOnly, purged: 0
  };
  summary.drift = projectDiff.demiOnly.length + projectDiff.eagleOnly.length +
    documentDiff.demiOnly.length + documentDiff.eagleOnly.length;

  if (args.live) {
    // Both containers sized BEFORE either delete, so a breach in one stops the other too.
    const breached = [
      ['projects', projectDiff.demiOnly.length],
      ['documents', documentDiff.demiOnly.length]
    ].filter(([, n]) => n > args.maxPurge);

    if (breached.length) {
      summary.failures.push('refused before any purge — nothing removed from either container: ' +
        breached.map(([label, n]) => `${label} ${n} exceeds --max-purge ${args.maxPurge}`).join('; ') +
        '. Re-run with a higher --max-purge if the loss really is that large.');
    } else if (!searchReady) {
      summary.failures.push('refused before any purge — SEARCH_ENDPOINT is not set, so every ' +
        'index delete would be a silent no-op and the purged rows would stay searchable');
    }

    if (!summary.failures.length) {
      // Documents first: a project whose documents are already gone cannot orphan any.
      for (const [label, rows, remove] of [
        ['documents', documentDiff.demiOnly, row => purge.purgeDocument(row)],
        ['projects', projectDiff.demiOnly, row => purge.purgeProject(row)]
      ]) {
        const singular = label.replace(/s$/, '');
        for (const row of rows) {
          try {
            await remove(row);
            summary[label].purged++;
            // The DELETE controllers' own event, so a purge is traceable however it was issued.
            audit.auditEvent(null, {
              action: `${singular}.delete`,
              targetType: singular,
              targetId: row.id,
              projectId: row.projectId || row.id,
              detail: { source: 'reconcile-eagle --live' }
            });
          } catch (err) {
            summary.failures.push(`${singular} ${row.id} purge failed: ${err.message}`);
          }
        }
      }
    }
  }

  return summary;
}

function report(summary, { json } = {}) {
  const lines = [`[reconcile] mode=${summary.mode} eagle=${summary.eagle}`];
  for (const label of ['projects', 'documents']) {
    const s = summary[label];
    lines.push(`${label}: ${s.inDemi} mirrored in DEMI, ${s.inEagle} published in Eagle`);
    // Capped: a real drift can carry thousands of ids and --json is where the full set lives.
    const preview = ids => ids.slice(0, 20).join(', ') + (ids.length > 20 ? ', …' : '');
    lines.push(`  demiOnly (gone from Eagle, ${summary.mode === 'live' ? 'purged' : 'purge'} ` +
      `candidates): ${s.demiOnly.length}${s.demiOnly.length ? ` — ${preview(s.demiOnly.map(r => r.id))}` : ''}`);
    lines.push(`  eagleOnly (the push missed these, reported only): ${s.eagleOnly.length}` +
      `${s.eagleOnly.length ? ` — ${preview(s.eagleOnly)}` : ''}`);
    if (s.purged) lines.push(`  purged: ${s.purged}`);
    if (s.trackOnly) {
      lines.push(`  ${s.trackOnly} Track-sourced project(s) also have no Eagle counterpart — not ` +
        'purgeable here, that is close-unpublished-track-projects.js');
    }
  }
  for (const f of summary.failures) lines.push(`  ✗ ${f}`);
  if (json) {
    lines.push(JSON.stringify({
      projects: { demiOnly: summary.projects.demiOnly.map(r => r.id), eagleOnly: summary.projects.eagleOnly },
      documents: { demiOnly: summary.documents.demiOnly.map(r => r.id), eagleOnly: summary.documents.eagleOnly }
    }, null, 2));
  }
  return lines.join('\n');
}

module.exports = { DEFAULT_MAX_PURGE, parseArgs, diff, summaryLine, exitCodeFor, reconcile, report };

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

  reconcile(process.argv.slice(2))
    .then(async summary => {
      logger.info(report(summary, { json: args.json }));
      // Its own record, so a log alert matches this line and not the report body around it.
      logger.info(summaryLine(summary));
      // Audit rows buffer behind an unref'd timer, so process.exit would drop the purge trail.
      await auditHelpers.flush().catch(err => logger.error(`[reconcile] audit flush: ${err.message}`));
      process.exit(exitCodeFor(summary));
    })
    .catch(err => {
      logger.error(`[reconcile] ${err.stack || err.message}`);
      process.exit(1);
    });
}
