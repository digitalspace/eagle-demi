#!/usr/bin/env node
'use strict';

// Public-API checks for a prod -> test re-seed. Runbook: wiki Runbook-Test-Reseed-from-Prod (S1, S6, S8).
const USAGE = `usage: reseed-public-check.js <command>
  snapshot --out DIR --keep-ids FILE
  residue  --out DIR --keep-ids FILE
  residue  --live --kind updates|comment-periods --ids FILE --out DIR [--keep-ids FILE]   (needs STAFF_TOKEN)
  verify   --out DIR --baseline DIR [--seed-summary FILE]`;

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { logger } = require('../src/utils/logger');
const { readKeepIds } = require('../src/utils/keep-ids');

const PROD_API = 'https://projects.eao.gov.bc.ca/api/public';
const TEST_ORIGIN = 'https://test.projects.eao.gov.bc.ca';
const TEST_SEARCH = `${TEST_ORIGIN}/demi-search`;
const TEST_STAFF_API = `${TEST_ORIGIN}/demi/api`;

const RESIDUE_DATASETS = ['RecentActivity', 'ProjectNotification', 'CommentPeriod'];
const COUNT_DATASETS = ['Project', 'Document', ...RESIDUE_DATASETS];
const KEEP_FIELDS = ['tags', 'shortUrl', 'shortLinkCustom', 'name'];
// Notifications have no delete route, so they stay as known residue.
const LIVE_KINDS = { updates: 'RecentActivity', 'comment-periods': 'CommentPeriod' };
// Test refuses an anonymous pageSize above 100 on some datasets (CommentPeriod); prod caps at 1000.
const PAGE_SIZE = 100;
const DOWNLOAD_COUNT = 3;
const TITLE_MAX = 120;

const CHECKLIST = [
  ['/', 'The Updates feed holds prod\'s latest items and no test titles'],
  ['/projects, /projects-list', 'Count equals prod\'s public Project count; list each difference by id with its cause'],
  ['/project-notifications, /pn/:projId', 'One prod notification project opens with its documents'],
  ['/p/:projId/overview', 'For 5 projects the business names, name, proponent and phase match prod, or the difference is a Track test value'],
  ['/p/:projId/documents', 'Count equals prod\'s count'],
  ['/p/:projId/updates, /p/:projId/engagement', 'Match prod'],
  ['/p/:projId/decisions', 'Regulation link present; empty for projects new to test unless S7 ran'],
  ['/p/:projId/cp/:commentPeriodId/details', 'One prod comment period shows its public comments'],
  ['/search', 'Finds a recent prod document by title'],
  ['/search/content', 'Works only for documents extracted before the seed; write that scope in the demo notes (A8)'],
  ['/p/<keep id>', 'Kept project page renders: masthead, tabs, route map with corridors loaded. Unchanged from the S1 snapshot'],
  ['downloads', 'One 2-document bulk download completes'],
  ['map', 'Map pins render']
].map(([route, check]) => ({ route, check }));

/**
 * The only way this tool reaches the network. Prod is read only: anything but GET is refused
 * unless it targets the test site, before a request leaves the process.
 */
function makeRequest(fetchImpl = globalThis.fetch) {
  return async function request(url, { method = 'GET', headers = {} } = {}) {
    const target = new URL(url);
    if (method !== 'GET' && target.origin !== TEST_ORIGIN) {
      throw new Error(`refused ${method} to ${target.origin}: only ${TEST_ORIGIN} takes anything but GET`);
    }
    return fetchImpl(target.href, { method, headers });
  };
}

async function getJson(request, url) {
  const res = await request(url);
  if (!res.ok) {
    const u = new URL(url);
    throw new Error(`GET ${u.host}${u.pathname}${u.search} answered ${res.status}`);
  }
  return res.json();
}

/** Both search APIs answer `[{searchResults, meta:[{searchResultsTotal}]}]`. */
function searchPayload(body) {
  const page = Array.isArray(body) ? body[0] : body;
  const rows = (page && page.searchResults) || [];
  const total = page && Array.isArray(page.meta) && page.meta[0] ? page.meta[0].searchResultsTotal : rows.length;
  return { rows, total: Number(total) };
}

function searchUrl(base, dataset, { pageSize = PAGE_SIZE, pageNum = 0, fields, sortBy } = {}) {
  const params = new URLSearchParams({ dataset, pageSize: String(pageSize), pageNum: String(pageNum) });
  if (fields) params.set('fields', fields);
  if (sortBy) params.set('sortBy', sortBy);
  return `${base}/search?${params}`;
}

/** Every row of a dataset, page by page. */
async function searchRows(request, base, dataset, opts) {
  const byId = new Map();
  let total;
  for (let pageNum = 0; ; pageNum++) {
    const page = searchPayload(await getJson(request, searchUrl(base, dataset, { ...opts, pageNum })));
    total = page.total;
    for (const row of page.rows) byId.set(String(row._id), row);
    if (!page.rows.length || byId.size >= total) break;
  }
  // A missed row would read as a false "missing" or "test-only" id, so a short read is an error.
  if (byId.size !== total) throw new Error(`${dataset} at ${new URL(base).host}: read ${byId.size} distinct rows of ${total}`);
  return [...byId.values()];
}

async function searchTotal(request, base, dataset) {
  return searchPayload(await getJson(request, searchUrl(base, dataset, { pageSize: 1, fields: '_id' }))).total;
}

const bare = (id) => (id == null ? null : String(id).replace(/^eagle-/, ''));

/** Test rows carry `project` as an id or `{_id, name}`; prod as an id; notifications as `associatedProjectId`. */
function rowProject(row) {
  const p = row.project;
  if (p && typeof p === 'object') return bare(p._id);
  return bare(p ?? row.associatedProjectId ?? row.projectId);
}

function describeRow(row) {
  const title = row.headline || row.name || row.informationLabel || row.instructions || row.displayName || '';
  return {
    _id: String(row._id),
    demiId: String(row.id ?? row._id),
    sourceSystem: row.sourceSystem ?? null,
    project: rowProject(row),
    projectName: (row.project && row.project.name) || row.projectName || row.associatedProjectName || null,
    title: String(title).slice(0, TITLE_MAX)
  };
}

function touchesKept(row, keep) {
  const ids = [row._id, row.id, row.eagleId, row.projectId, row.associatedProjectId, rowProject(row)].map(bare);
  return ids.some(id => id && keep.has(id));
}

async function snapshot({ request, keepIds }) {
  const keepRows = {};
  for (const id of keepIds) {
    const res = await request(`${TEST_ORIGIN}/demi-projects/${encodeURIComponent(id)}`);
    keepRows[id] = res.ok ? await res.json() : null;
  }
  // Only this key: the config also carries values that do not belong in a scratch file.
  const config = await getJson(request, `${TEST_SEARCH}/config`);
  const counts = { prod: {}, test: {} };
  for (const ds of COUNT_DATASETS) {
    counts.prod[ds] = await searchTotal(request, PROD_API, ds);
    counts.test[ds] = await searchTotal(request, TEST_SEARCH, ds);
  }
  return { takenAt: new Date().toISOString(), keepIds, keepRows, extendedProjectPages: config.EXTENDED_PROJECT_PAGES ?? null, counts };
}

async function residue({ request, keepIds }) {
  const keep = new Set(keepIds.map(bare));
  const datasets = {};
  for (const ds of RESIDUE_DATASETS) {
    const prod = await searchRows(request, PROD_API, ds, { fields: '_id' });
    const test = await searchRows(request, TEST_SEARCH, ds);
    const prodIds = new Set(prod.map(r => String(r._id)));
    const testOnly = test.filter(r => !prodIds.has(String(r._id)));
    const kept = testOnly.filter(r => touchesKept(r, keep));
    datasets[ds] = {
      prod: prodIds.size,
      test: test.length,
      keptSkipped: kept.map(r => String(r._id)),
      testOnly: testOnly.filter(r => !touchesKept(r, keep)).map(describeRow)
    };
  }
  return { takenAt: new Date().toISOString(), keepIds, datasets };
}

async function residueLive({ request, kind, ids, token, keepIds = [] }) {
  const dataset = LIVE_KINDS[kind];
  if (!dataset) throw new Error(`--kind must be one of ${Object.keys(LIVE_KINDS).join(', ')}`);
  if (!token) throw new Error('residue --live needs STAFF_TOKEN in the environment');
  const keep = new Set(keepIds.map(bare));
  const listedKept = ids.filter(id => keep.has(bare(id)));
  if (listedKept.length) throw new Error(`refused: --ids lists kept ids ${listedKept.join(', ')}`);

  const auth = { Authorization: `Bearer ${token}` };
  const results = [];
  for (const id of ids) {
    const url = `${TEST_STAFF_API}/${kind}/${encodeURIComponent(id)}`;
    const del = await request(url, { method: 'DELETE', headers: auth });
    const read = await request(url, { headers: auth });
    results.push({ id, deleteStatus: del.status, readStatus: read.status });
  }
  const stillPublic = new Set((await searchRows(request, TEST_SEARCH, dataset))
    .flatMap(r => [String(r._id), String(r.id ?? r._id)]));
  for (const r of results) r.stillPublic = stillPublic.has(String(r.id));
  const failed = results.filter(r => r.deleteStatus < 200 || r.deleteStatus > 299 || r.stillPublic);
  return { kind, ranAt: new Date().toISOString(), results, failed: failed.map(r => r.id) };
}

function missingFrom(source, target) {
  return [...source].filter(id => !target.has(id));
}

function sameValue(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

async function verify({ request, baseline, seedSummary = null }) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });
  const keep = new Set((baseline.keepIds || []).map(bare));

  const prodProjects = new Set((await searchRows(request, PROD_API, 'Project', { fields: '_id' })).map(r => String(r._id)));
  const testProjectRows = await searchRows(request, TEST_SEARCH, 'Project');
  const testProjects = new Set(testProjectRows.map(r => String(r._id)));
  const missing = missingFrom(prodProjects, testProjects);
  add('prodProjectsOnTest', missing.length === 0, { prod: prodProjects.size, test: testProjects.size, missing });

  const unexplained = testProjectRows
    .filter(r => !prodProjects.has(String(r._id)))
    .filter(r => !keep.has(bare(r._id)) && !keep.has(bare(r.id)) && r.trackProjectId == null)
    .map(r => ({ _id: String(r._id), name: r.name ?? null }));
  add('testOnlyProjectsExplained', unexplained.length === 0, { unexplained });

  const dropped = Number(seedSummary?.stages?.documents?.droppedUnresolvable ?? 0);
  const prodDocs = await searchTotal(request, PROD_API, 'Document');
  const testDocs = await searchTotal(request, TEST_SEARCH, 'Document');
  add('documentTotal', testDocs >= prodDocs - dropped, { prod: prodDocs, test: testDocs, droppedUnresolvable: dropped });

  for (const ds of RESIDUE_DATASETS) {
    const prodIds = new Set((await searchRows(request, PROD_API, ds, { fields: '_id' })).map(r => String(r._id)));
    const testIds = new Set((await searchRows(request, TEST_SEARCH, ds)).map(r => String(r._id)));
    const absent = missingFrom(prodIds, testIds);
    add(`prodSubsetOfTest:${ds}`, absent.length === 0, { prod: prodIds.size, test: testIds.size, missing: absent });
  }

  for (const id of baseline.keepIds || []) {
    const res = await request(`${TEST_ORIGIN}/demi-projects/${encodeURIComponent(id)}`);
    const now = res.ok ? await res.json() : null;
    const before = (baseline.keepRows || {})[id] ?? null;
    const changed = now && before ? KEEP_FIELDS.filter(f => !sameValue(now[f], before[f])) : KEEP_FIELDS;
    add(`keepRow:${id}`, changed.length === 0, { status: res.status, changed });
  }

  const config = await getJson(request, `${TEST_SEARCH}/config`);
  add('extendedProjectPages', sameValue(config.EXTENDED_PROJECT_PAGES, baseline.extendedProjectPages),
    { baseline: baseline.extendedProjectPages ?? null, now: config.EXTENDED_PROJECT_PAGES ?? null });

  // The newest prod documents are the ones most likely posted after the last object backfill.
  const newest = await getJson(request, searchUrl(PROD_API, 'Document',
    { pageSize: DOWNLOAD_COUNT, fields: '_id,datePosted', sortBy: '-datePosted' }));
  const downloads = [];
  for (const row of searchPayload(newest).rows) {
    const res = await request(`${TEST_SEARCH}/documents/${encodeURIComponent(row._id)}/download?redirect=1`, { headers: { Range: 'bytes=0-0' } });
    downloads.push({ _id: String(row._id), datePosted: row.datePosted ?? null, status: res.status });
  }
  add('downloads', downloads.length === DOWNLOAD_COUNT && downloads.every(d => d.status === 200 || d.status === 206), { downloads });

  return { ranAt: new Date().toISOString(), ok: checks.every(c => c.pass), checks, checklist: CHECKLIST };
}

function writeJson(dir, name, value) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function writeIds(dir, name, ids) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, ids.length ? `${ids.join('\n')}\n` : '');
  return file;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const OPTIONS = {
  out: { type: 'string' },
  'keep-ids': { type: 'string' },
  baseline: { type: 'string' },
  'seed-summary': { type: 'string' },
  live: { type: 'boolean', default: false },
  kind: { type: 'string' },
  ids: { type: 'string' }
};

function need(values, name) {
  if (!values[name]) throw new Error(`--${name} is required`);
  return values[name];
}

async function main(argv, { fetchImpl = globalThis.fetch, env = process.env, log = (m) => logger.info(m) } = {}) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const [command] = positionals;
  if (!['snapshot', 'residue', 'verify'].includes(command)) throw new Error(USAGE);
  const request = makeRequest(fetchImpl);
  const out = need(values, 'out');

  if (command === 'snapshot') {
    const snap = await snapshot({ request, keepIds: readKeepIds(need(values, 'keep-ids')) });
    const file = writeJson(out, 'snapshot.json', snap);
    log(`[reseed-check] snapshot ${file} keep=${Object.keys(snap.keepRows).length} ` +
      COUNT_DATASETS.map(ds => `${ds}=${snap.counts.prod[ds]}/${snap.counts.test[ds]}`).join(' ') + ' (prod/test)');
    return 0;
  }

  if (command === 'residue' && values.live) {
    const ids = readKeepIds(need(values, 'ids'));
    const keepIds = values['keep-ids'] ? readKeepIds(values['keep-ids']) : [];
    const result = await residueLive({ request, kind: values.kind, ids, token: env.STAFF_TOKEN, keepIds });
    const file = writeJson(out, `residue-live-${values.kind}.json`, result);
    log(`[reseed-check] residue live kind=${values.kind} ids=${ids.length} failed=${result.failed.length} ${file}`);
    return result.failed.length ? 1 : 0;
  }

  if (command === 'residue') {
    const result = await residue({ request, keepIds: readKeepIds(need(values, 'keep-ids')) });
    const file = writeJson(out, 'residue.json', result);
    writeIds(out, 'ids-updates.txt', result.datasets.RecentActivity.testOnly.map(r => r.demiId));
    // The staff route refuses ENGAGE-owned periods (409), so they stay in residue.json only.
    writeIds(out, 'ids-comment-periods.txt', result.datasets.CommentPeriod.testOnly
      .filter(r => r.sourceSystem !== 'engage').map(r => r.demiId));
    log(`[reseed-check] residue ${file} ` + RESIDUE_DATASETS.map(ds =>
      `${ds} testOnly=${result.datasets[ds].testOnly.length} keptSkipped=${result.datasets[ds].keptSkipped.length}`).join(' '));
    return 0;
  }

  const baseline = readJson(path.join(need(values, 'baseline'), 'snapshot.json'));
  const seedSummary = values['seed-summary'] ? readJson(values['seed-summary']) : null;
  const result = await verify({ request, baseline, seedSummary });
  const file = writeJson(out, 'verify.json', result);
  for (const c of result.checks) log(`[reseed-check] ${c.pass ? 'pass' : 'FAIL'} ${c.name}`);
  log(`[reseed-check] verify ${result.ok ? 'passed' : 'failed'} ${file}. Browser checklist:`);
  for (const row of CHECKLIST) log(`  ${row.route}: ${row.check}`);
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, (err) => {
    logger.error('[reseed-check] failed', { error: err.message, stack: err.stack });
    process.exitCode = 2;
  });
}

module.exports = { PROD_API, TEST_ORIGIN, makeRequest, readKeepIds, snapshot, residue, residueLive, verify, main };
