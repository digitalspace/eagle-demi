'use strict';

// NRPTI mines and regulatory records into DEMI, linked by EPIC project id only. Dry run by default;
// --live writes only when ENRICHMENT_SOURCES lists nrpti; --clear-only removes every sources.nrpti.

const config = require('../config');
const mines = require('../repositories/mines');
const records = require('../repositories/regulatory-records');
const projectNrpti = require('../repositories/project-nrpti');
const { MINE_DATASET, DATASETS, REASONS, mapRecord, mapMine } = require('../domain/nrpti-map');
const { logger } = require('../utils/logger');

const TAG = '[nrpti-sync]';
const SEARCH_URL = 'https://nrpti-api-f00029-prod.apps.silver.devops.gov.bc.ca/api/public/search';
const PAGE_SIZE = 1000;
const USAGE = 'usage: node src/scripts/sync-nrpti.js [--live] [--clear-only]';

async function fetchPage(dataset, pageNum) {
  const params = new URLSearchParams({ dataset, pageNum: String(pageNum), pageSize: String(PAGE_SIZE) });
  if (dataset !== MINE_DATASET) params.set('populate', 'true');
  const res = await fetch(`${SEARCH_URL}?${params}`);
  if (!res.ok) throw new Error(`${TAG} ${dataset} page ${pageNum}: HTTP ${res.status}`);
  const rows = (await res.json())?.[0]?.searchResults;
  if (!Array.isArray(rows)) throw new Error(`${TAG} ${dataset} page ${pageNum}: no searchResults`);
  return rows;
}

function mapOne(item, dataset, map, syncedAt) {
  if (dataset === MINE_DATASET) return mapMine(item, map, syncedAt);
  const { row, reason } = mapRecord(item, dataset, map, syncedAt);
  return reason ? { reason } : { rows: [row] };
}

/** Every page of one dataset, mapped as it arrives so unlinked rows are not held. */
async function collectDataset(dataset, map, syncedAt) {
  const counts = { fetched: 0, linked: 0, reasons: Object.fromEntries(Object.values(REASONS).map(r => [r, 0])) };
  const rows = [];
  for (let pageNum = 0; ; pageNum++) {
    const page = await fetchPage(dataset, pageNum);
    counts.fetched += page.length;
    for (const item of page) {
      const out = mapOne(item, dataset, map, syncedAt);
      if (out.reason) counts.reasons[out.reason]++;
      else rows.push(...out.rows);
    }
    if (page.length < PAGE_SIZE) break;
  }
  counts.linked = rows.length;
  logger.info(`${TAG} ${dataset}`, counts);
  return { counts, rows };
}

/** The `sources.nrpti` block for every project a mine or record links to. */
function summariesByProject(mineRows, recordRows, syncedAt) {
  const byProject = new Map();
  const entry = (id) => {
    if (!byProject.has(id)) byProject.set(id, { mines: [], recordCounts: {}, lastRecordDate: null, lastCalculatedAt: syncedAt });
    return byProject.get(id);
  };
  for (const mine of mineRows) {
    entry(mine.projectId).mines.push({ mineId: mine.mineId, name: mine.name, status: mine.status, commodities: mine.commodities });
  }
  for (const record of recordRows) {
    const summary = entry(record.projectId);
    summary.recordCounts[record.kind] = (summary.recordCounts[record.kind] || 0) + 1;
    if (record.issuedAt && (!summary.lastRecordDate || record.issuedAt > summary.lastRecordDate)) {
      summary.lastRecordDate = record.issuedAt;
    }
  }
  return byProject;
}

async function clearSummaries(ids) {
  for (const id of ids) await projectNrpti.removeSummary(id);
  return ids.length;
}

async function clearOnly(summary, live) {
  const ids = await projectNrpti.listIdsWithSummary();
  summary.staleSummaries = ids.length;
  if (live) summary.cleared = await clearSummaries(ids);
  return summary;
}

async function sync(summary, live) {
  const syncedAt = new Date().toISOString();
  const map = await projectNrpti.eagleIdMap();
  const mineRows = [];
  const recordRows = [];
  // Every page is fetched before anything is written, so a failed page leaves DEMI untouched.
  for (const dataset of DATASETS) {
    const { counts, rows } = await collectDataset(dataset, map, syncedAt);
    summary.datasets[dataset] = counts;
    summary.linked += counts.linked;
    (dataset === MINE_DATASET ? mineRows : recordRows).push(...rows);
  }
  const byProject = summariesByProject(mineRows, recordRows, syncedAt);
  const stale = (await projectNrpti.listIdsWithSummary()).filter(id => !byProject.has(String(id)));
  summary.projects = byProject.size;
  summary.staleSummaries = stale.length;
  if (!live) return summary;
  for (const row of mineRows) await mines.upsert(row);
  for (const row of recordRows) await records.upsert(row);
  for (const [id, block] of byProject) await projectNrpti.patchSummary(id, block);
  summary.cleared = await clearSummaries(stale);
  return summary;
}

async function run({ live = false, clearOnly: onlyClear = false } = {}) {
  const summary = {
    mode: onlyClear ? 'clear-only' : live ? 'live' : 'dry',
    result: live ? 'written' : 'dry',
    datasets: {},
    linked: 0,
    projects: 0,
    staleSummaries: 0,
    cleared: 0
  };
  if (onlyClear) return clearOnly(summary, live);
  if (live && !config.enrichmentSources.includes('nrpti')) {
    logger.warn(`${TAG} live run skipped: ENRICHMENT_SOURCES does not list nrpti`);
    summary.result = 'skipped:disabled';
    return summary;
  }
  const done = await sync(summary, live);
  logger.info(`${TAG} done`, { mode: done.mode, linked: done.linked, projects: done.projects, stale: done.staleSummaries, cleared: done.cleared });
  return done;
}

function parseArgs(argv) {
  const args = { live: false, clearOnly: false };
  for (const a of argv) {
    if (a === '--live') args.live = true;
    else if (a === '--clear-only') args.clearOnly = true;
    else throw new Error(`${TAG} unknown argument: ${a}\n${USAGE}`);
  }
  return args;
}

const resultLine = (s) =>
  `nrpti: mode=${s.mode} result=${s.result} linked=${s.linked} projects=${s.projects} stale=${s.staleSummaries} cleared=${s.cleared}`;

module.exports = { run, PAGE_SIZE };

if (require.main === module) {
  Promise.resolve()
    .then(() => run(parseArgs(process.argv.slice(2))))
    .then((summary) => {
      console.log(resultLine(summary));
      process.exit(0);
    })
    .catch((err) => {
      logger.error(`${TAG} failed`, { error: err.message, stack: err.stack });
      console.log(`nrpti: result=failed error=${err.message.split('\n')[0]}`);
      process.exit(1);
    });
}
