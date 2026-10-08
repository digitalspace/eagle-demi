'use strict';

/**
 * Check ENGAGE-owned comment periods against the copy Eagle holds and against ENGAGE's public list.
 *
 *   node src/scripts/reconcile-engage.js [--repair] [--store] [--limit N]
 *
 * Reports only by default. `--repair` re-queues every never-synced, missing and drifted row through
 * sync-out, so DEMI's copy wins; this script never writes to Eagle itself. The ENGAGE half is report
 * only. `--store` keeps the report under `REPORT_ID` in the cache container. `--limit` caps the rows
 * checked against Eagle. Runs on the devbox via `demi-run`, like reconcile-eagle.js.
 */

const commentPeriods = require('../repositories/comment-periods');
const cache = require('../repositories/cache');
const syncOut = require('../sync-out');
const eagle = require('../sync-out/eagle');
const config = require('../config');
const { writeGuarded } = require('../helpers/etag-write');
const { admitParent } = require('../helpers/parent-admit');
const { clientCredentialsToken } = require('../services/keycloak-client-token');
const { logger } = require('../utils/logger');

const REPORT_ID = cache.RECONCILE_ENGAGE_REPORT_ID;
const settings = config.syncOut;
const TIMEOUT_MS = 15000;
const EAGLE_FIELDS = 'dateStarted|dateCompleted|isPublished|metURL';
const ENGAGE_PAGE_SIZE = 100;
const TAG = '[reconcile-engage]';

function parseArgs(argv) {
  const args = { repair: false, store: false, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repair') args.repair = true;
    else if (a === '--store') args.store = true;
    else if (a === '--limit') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error(`${TAG} --limit takes a positive integer`);
      args.limit = n;
    } else throw new Error(`${TAG} unknown argument: ${a}`);
  }
  return args;
}

/** Minutes since the epoch, UTC; an unparseable value compares as itself. */
function minuteOf(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 60000) : String(value);
}

/** The fields where Eagle's copy differs from what sync-out would send for this row. */
function driftFields(expected, actual) {
  const out = [];
  for (const field of ['dateStarted', 'dateCompleted']) {
    if (minuteOf(expected[field]) !== minuteOf(actual[field])) {
      out.push({ field, demi: expected[field] || null, eagle: actual[field] || null });
    }
  }
  if (Boolean(expected.isPublished) !== Boolean(actual.isPublished)) {
    out.push({ field: 'isPublished', demi: Boolean(expected.isPublished), eagle: Boolean(actual.isPublished) });
  }
  if ((expected.metURL || '') !== (actual.metURL || '')) {
    out.push({ field: 'metURL', demi: expected.metURL || '', eagle: actual.metURL || '' });
  }
  return out;
}

/** Same test sync-out's send() applies before it deletes the Eagle copy. */
const isDeletedRow = row => Boolean(row.isDeleted || (row.sources && row.sources.engage && row.sources.engage.isDeleted));

/** GET against eagle-api with a client-credentials token, from the sync-out Eagle settings. */
function eagleReader(get) {
  const s = settings.eagle;
  const missing = [
    ['EAGLE_PROTECTED_API_BASE', s.apiBase], ['EAGLE_KC_CLIENT_ID', s.clientId],
    ['EAGLE_KC_CLIENT_SECRET', s.clientSecret]
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) return { missing };

  let bearer = null;
  const token = async () => {
    bearer = bearer || (await clientCredentialsToken({
      issuer: s.issuer, clientId: s.clientId, clientSecret: s.clientSecret, timeoutMs: TIMEOUT_MS, fetch: get
    })).accessToken;
    return bearer;
  };
  const request = async path => get(`${s.apiBase}${path}`, {
    headers: { Authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  return {
    async getJson(path) {
      let res = await request(path);
      if (res.status === 401) {
        bearer = null;
        res = await request(path);
      }
      return { status: res.status, ok: res.ok, body: res.ok ? await res.json() : null };
    }
  };
}

const rowRef = row => ({ id: String(row.id), engagementId: row.engagementId ?? null, eagleId: row.eagleId || null });

/** DEMI vs Eagle. Returns the rows `--repair` would re-queue. */
async function checkEagle(rows, reader, report) {
  const repairs = [];
  for (const row of rows) {
    report.checked++;
    const deleted = isDeletedRow(row);
    const entry = (row.syncOut && row.syncOut[eagle.name]) || {};
    // Sync-out found the Eagle period on this URL already mirrored as an Eagle-owned row: a re-send meets the same refusal.
    if (!row.eagleId && entry.status === 'conflict') {
      report.conflicts.push({ ...rowRef(row), candidateEagleId: entry.candidateEagleId || null });
      continue;
    }
    if (!row.eagleId) {
      if (!deleted) {
        report.neverSynced.push(rowRef(row));
        repairs.push(row);
      }
      continue;
    }
    const path = `/commentperiod/${encodeURIComponent(row.eagleId)}?fields=${EAGLE_FIELDS}`;
    const res = await reader.getJson(path);
    // eagle-api answers an id it does not hold with 200 and an empty list, not only with 404.
    const record = res.ok ? (Array.isArray(res.body) ? res.body[0] : res.body) : null;
    if (res.status !== 404 && !res.ok) {
      report.warnings.push(`eagle GET ${path}: HTTP ${res.status}, row ${row.id} not checked`);
      continue;
    }
    if (!record) {
      if (!deleted) {
        report.missingInEagle.push(rowRef(row));
        repairs.push(row);
      }
      continue;
    }
    const fields = deleted
      ? [{ field: 'isDeleted', demi: true, eagle: false }]
      : driftFields(eagle.bodyFor(row, settings.eagle), record);
    if (fields.length) {
      report.drift.push({ ...rowRef(row), fields });
      repairs.push(row);
    }
  }
  return repairs;
}

/** More than one Eagle period under one project on the same engagement URL. */
async function checkDuplicates(rows, reader, report) {
  const projects = [...new Set(rows.map(row => row.eagleProjectId).filter(Boolean).map(String))];
  for (const eagleProjectId of projects) {
    const path = `/commentperiod?project=${encodeURIComponent(eagleProjectId)}&fields=metURL`;
    const res = await reader.getJson(path);
    if (!res.ok) {
      report.warnings.push(`eagle GET ${path}: HTTP ${res.status}, duplicates not checked`);
      continue;
    }
    const byUrl = new Map();
    for (const period of Array.isArray(res.body) ? res.body : []) {
      if (!period || !period.metURL) continue;
      byUrl.set(period.metURL, [...(byUrl.get(period.metURL) || []), String(period._id)]);
    }
    for (const [metURL, eagleIds] of byUrl) {
      if (eagleIds.length > 1) report.duplicates.push({ eagleProjectId, metURL, eagleIds });
    }
  }
}

/** Clear the sent version so the sync-out worker sends this row again instead of skipping it. */
async function markUnsent(repo, row) {
  const reread = () => repo.readForWrite(row.id, row.projectId);
  const result = await writeGuarded({
    existing: await reread(),
    reread,
    attempt: async (current) => {
      if (!current) return { status: 'missing' };
      const entry = current.syncOut && current.syncOut[eagle.name];
      if (!entry || !entry.sentVersion) return { status: 'unchanged' };
      await repo.upsert({
        ...current, syncOut: { ...current.syncOut, [eagle.name]: { ...entry, sentVersion: null } }
      }, current);
      return { status: 'saved' };
    }
  });
  if (result.status === 'conflict') throw new Error(`row ${row.id}: every write lost to a concurrent writer`);
}

async function repair(rows, { repo, enqueue }, report) {
  if (!eagle.enabled()) {
    report.warnings.push('SYNC_OUT_EAGLE_ENABLED is not true: --repair queued nothing');
    return;
  }
  for (const row of rows) {
    try {
      await markUnsent(repo, row);
      if ((await enqueue(row)).length) report.queued++;
    } catch (err) {
      report.warnings.push(`could not re-queue row ${row.id}: ${err.message}`);
    }
  }
}

/** Every engagement ENGAGE lists to an anonymous caller: published ones only. */
async function engagementList(base, get) {
  const items = [];
  for (let page = 1; ; page++) {
    const url = `${base}/engagements/?page=${page}&size=${ENGAGE_PAGE_SIZE}`;
    const res = await get(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`ENGAGE GET ${url}: HTTP ${res.status}`);
    const body = await res.json();
    const pageItems = Array.isArray(body.items) ? body.items : [];
    items.push(...pageItems);
    if (!pageItems.length || items.length >= Number(body.total || 0)) return items;
  }
}

/**
 * ENGAGE vs DEMI, report only: published engagements under a project that DEMI holds no row for. One
 * under a notification is skipped, since those still go to Eagle from ENGAGE directly. The reverse check
 * is not made: ENGAGE's anonymous list leaves out internal engagements, so a DEMI row missing from it
 * says nothing.
 */
async function checkEngage(base, rows, get, report, admit) {
  const engagements = await engagementList(base, get);
  const demiByEngagement = new Set(rows.map(row => String(row.engagementId)));
  const unread = new Map();
  for (const engagement of engagements) {
    if (demiByEngagement.has(String(engagement.id))) continue;
    const url = `${base}/engagementsmetadata/${encodeURIComponent(engagement.id)}`;
    const res = await get(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      unread.set(res.status, [...(unread.get(res.status) || []), engagement.id]);
      continue;
    }
    const projectId = (await res.json()).project_id;
    if (!projectId) continue;
    const parent = await admit(projectId);
    if (parent && parent.kind === 'notification') continue;
    report.engageMissingInDemi.push({ engagementId: engagement.id, projectId: String(projectId) });
  }
  for (const [status, ids] of unread) {
    report.warnings.push(`ENGAGE metadata HTTP ${status} for ${ids.length} engagement(s), not checked: ${ids.join(',')}`);
  }
}

/**
 * @param {object} [opts] {repair} re-queue drifted rows, {store} keep the report, {limit} rows
 *   checked against Eagle, {deps} test seam: {commentPeriods, enqueue, fetch, cache, engageApiBase, admitParent}
 */
async function reconcileEngage({ repair: doRepair = false, limit = null, deps = {} } = {}) {
  const repo = deps.commentPeriods || commentPeriods;
  const get = deps.fetch || fetch;
  const report = {
    at: new Date().toISOString(), checked: 0, neverSynced: [], missingInEagle: [], drift: [],
    duplicates: [], conflicts: [], engageMissingInDemi: [], queued: 0, warnings: [],
    engageChecked: false
  };

  const rows = await repo.listEveryEngage();
  const reader = eagleReader(get);
  if (reader.missing) {
    report.warnings.push(`${reader.missing.join(', ')} not set: Eagle side not checked`);
  } else {
    const checked = limit ? rows.slice(0, limit) : rows;
    const repairs = await checkEagle(checked, reader, report);
    await checkDuplicates(checked, reader, report);
    if (doRepair) await repair(repairs, { repo, enqueue: deps.enqueue || syncOut.enqueue }, report);
  }

  const base = (deps.engageApiBase !== undefined ? deps.engageApiBase : config.engageApiBase)
    .replace(/\/+$/, '');
  if (!base) {
    report.warnings.push('ENGAGE_API_BASE is unset: ENGAGE side not checked');
  } else {
    try {
      await checkEngage(base, rows, get, report, deps.admitParent || admitParent);
      report.engageChecked = true;
    } catch (err) {
      report.warnings.push(`ENGAGE side not checked: ${err.message}`);
    }
  }
  return report;
}

function summaryLine(r) {
  const engageCount = n => (r.engageChecked ? n : 'skipped');
  return `${TAG} checked=${r.checked} neverSynced=${r.neverSynced.length} ` +
    `missingInEagle=${r.missingInEagle.length} drift=${r.drift.length} duplicates=${r.duplicates.length} ` +
    `conflicts=${r.conflicts.length} engageMissingInDemi=${engageCount(r.engageMissingInDemi.length)} ` +
    `queued=${r.queued}`;
}

function findingLines(r) {
  const ref = f => `${f.id} engagement=${f.engagementId} eagleId=${f.eagleId}`;
  return [
    ...r.neverSynced.map(f => `${TAG} never-synced ${ref(f)}`),
    ...r.missingInEagle.map(f => `${TAG} missing-in-eagle ${ref(f)}`),
    ...r.drift.map(f => `${TAG} drift ${ref(f)} ` +
      f.fields.map(d => `${d.field} demi=${d.demi} eagle=${d.eagle}`).join(' ')),
    ...r.duplicates.map(f => `${TAG} duplicate eagleProject=${f.eagleProjectId} metURL=${f.metURL} ` +
      `eagleIds=${f.eagleIds.join(',')}`),
    ...r.conflicts.map(f => `${TAG} conflict ${ref(f)} candidateEagleId=${f.candidateEagleId}`),
    ...r.engageMissingInDemi.map(f => `${TAG} engage-missing-in-demi engagement=${f.engagementId} ` +
      `project=${f.projectId}`)
  ];
}

/** One run, as the CLI and a timer both call it. */
async function run({ repair: doRepair = false, store = false, limit = null, deps = {} } = {}) {
  const report = await reconcileEngage({ repair: doRepair, limit, deps });
  logger.info(summaryLine(report));
  for (const line of findingLines(report)) logger.info(line);
  for (const warning of report.warnings) logger.warn(`${TAG} ${warning}`);
  if (store) {
    try {
      await (deps.cache || cache).put(REPORT_ID, { body: report });
    } catch (err) {
      logger.error(`${TAG} report store failed`, { error: err.message, stack: err.stack });
    }
  }
  return report;
}

module.exports = { REPORT_ID, parseArgs, minuteOf, driftFields, reconcileEngage, summaryLine, run };

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
  run(args).catch((err) => {
    logger.error(`${TAG} ${err.stack || err.message}`);
    process.exit(1);
  });
}
