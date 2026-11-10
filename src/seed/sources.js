'use strict';

/**
 * Read-only upstream loaders for the seed: Track, eagle-api, checked-in boundaries.
 * All I/O lives here so `transform.js` and `merge/project.js` stay pure and testable.
 */

const fs = require('fs');
const path = require('path');

const config = require('../config');
const { logger } = require('../utils/logger');
const { clientCredentialsToken } = require('../services/keycloak-client-token');
const { mapLimit } = require('../utils/worker-pool');
const { pickAssessmentWork } = require('../merge/assessment-work');
const {
  nameOf, workTypeIdOf, isMirrored, projectKeyOf, isoOrNull, trackWorkToPublic, orderedPhases, shownEvents,
  phaseEventsOf
} = require('./track-mappers');

const EAGLE_API_BASE = process.env.EAGLE_API_BASE ||
  'https://eagle-dev.apps.silver.devops.gov.bc.ca/api/public';

/**
 * The API caps pageSize at 100 regardless of what is requested — asking for 1000 silently
 * returns 100, which makes a naive loop appear to work while reading a tenth of the data.
 */
const PAGE_SIZE = 100;

const FETCH_TIMEOUT_MS = parseInt(process.env.SEED_FETCH_TIMEOUT_MS || '120000', 10);
const FETCH_RETRIES = 3;

/**
 * 429s get their own budget: eagle-api allows 200 requests a minute and a comment sweep spends that
 * inside a minute, so the window must be waited out rather than retried three times a second apart.
 */
const RATE_LIMIT_RETRIES = 5;

/** Used only when the response names no window of its own. */
const RATE_LIMIT_BACKOFF_MS = [5000, 15000, 60000];

/** A header asking for longer than this must not park a nightly run; at the cap we ask again. */
const RATE_LIMIT_MAX_WAIT_MS = 120000;

const sleepMs = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** One header as a non-negative number of seconds, or null when it is absent or unparseable. */
function headerSeconds(headers, name) {
  const raw = headers && typeof headers.get === 'function' ? headers.get(name) : null;
  const seconds = Number(raw);
  return raw === null || raw === '' || !Number.isFinite(seconds) || seconds < 0 ? null : seconds;
}

/**
 * How long to wait out a 429: `retry-after`, else `ratelimit-reset`, else the `ratelimit-policy`
 * window (`200;w=60`), else the 5/15/60 second ladder.
 */
function rateLimitWaitMs(headers, attempt) {
  const policy = headers && typeof headers.get === 'function' ? headers.get('ratelimit-policy') : null;
  const window = policy && String(policy).match(/(?:^|[;,])\s*w=(\d+)/);
  const seconds = headerSeconds(headers, 'retry-after')
    ?? headerSeconds(headers, 'ratelimit-reset')
    ?? (window ? Number(window[1]) : null);

  const ladder = RATE_LIMIT_BACKOFF_MS[Math.min(attempt, RATE_LIMIT_BACKOFF_MS.length) - 1];
  const waitMs = seconds === null ? ladder : seconds * 1000;
  // Floored because a `ratelimit-reset: 0` would otherwise retry instantly and spend the budget on
  // nothing; capped so one bad header cannot hold the run for an hour.
  return Math.min(Math.max(waitMs, 1000), RATE_LIMIT_MAX_WAIT_MS);
}

/**
 * Body and headers, retried; `/api/public/comment` puts its total in `x-total-count`.
 * A 429 was never served, so it spends the rate-limit budget, not an ordinary retry.
 * @param {object} [headers]    request headers — the Track team feed needs a bearer token.
 * @param {function} [deps.sleep] test seam, so a backoff costs a test no wall-clock time.
 * @returns {Promise<{body: *, headers: Headers}>}
 */
async function fetchJsonWithHeaders(url, headers, deps = {}) {
  const sleep = deps.sleep || sleepMs;
  let lastError;
  let attempt = 1;
  let throttled = 0;

  while (attempt <= FETCH_RETRIES) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal, headers });
      if (res.status === 429) {
        throttled++;
        if (throttled > RATE_LIMIT_RETRIES) {
          lastError = new Error(
            `HTTP 429 Too Many Requests, still throttled after ${RATE_LIMIT_RETRIES} waits`);
          break;
        }
        const waitMs = rateLimitWaitMs(res.headers, throttled);
        logger.warn(`[seed] 429 from ${url}: waiting ${Math.round(waitMs / 1000)}s ` +
          `(${throttled}/${RATE_LIMIT_RETRIES})`);
        await sleep(waitMs);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return { body: await res.json(), headers: res.headers };
    } catch (err) {
      lastError = err;
      // A transient failure mid-seed would otherwise truncate the corpus silently, so retry
      // rather than letting a partial page count as the end of the data.
      if (attempt < FETCH_RETRIES) {
        await sleep(1000 * attempt);
      }
      attempt++;
    } finally {
      clearTimeout(timer);
    }
  }
  // `attempt` counts ordinary failures, `throttled` the 429s: the sum is the requests actually made.
  throw new Error(
    `[seed] failed to fetch ${url} after ${attempt - 1 + throttled} attempts: ${lastError.message}`);
}

/**
 * @param {object} [headers] request headers — the Track team feed needs a bearer token.
 * @param {object} [deps]    see `fetchJsonWithHeaders`.
 */
async function fetchJson(url, headers, deps) {
  return (await fetchJsonWithHeaders(url, headers, deps)).body;
}

/**
 * One page of `[{ meta: [{searchResultsTotal}], searchResults: [...] }]`. Throws on another
 * shape, which would otherwise read as zero results and seed an empty database.
 */
function unwrapSearchResponse(body, url) {
  const envelope = Array.isArray(body) ? body[0] : body;
  if (!envelope || !Array.isArray(envelope.searchResults)) {
    throw new Error(`[seed] unexpected search response shape from ${url}`);
  }
  const total = envelope.meta && envelope.meta[0] && envelope.meta[0].searchResultsTotal;
  return { items: envelope.searchResults, total: typeof total === 'number' ? total : null };
}

/** One page of an eagle-api `/search` dataset, unauthenticated. */
const searchPage = async (url) => unwrapSearchResponse(await fetchJson(url), url);

/**
 * Rows of `items` whose key is not yet in `seen`, which they are added to. A row with no key throws:
 * every caller's rows carry one, so a missing key is a projection bug, not a row to count.
 */
function freshById(items, seen, keyOf = row => row._id ?? row.id) {
  return items.filter((item) => {
    const raw = item == null ? null : keyOf(item);
    if (raw == null) throw new Error('[seed] a fetched row has no id, so a repeat cannot be told apart');
    const key = String(raw);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The re-read total, or null when `count` unique rows fall short of the first page's total. Not
 * the lower total: a delete before the offset cursor skips a row and lowers both alike.
 */
function settledTotal(count, first, reread, label) {
  const final = typeof reread === 'number' ? reread : first;
  if (count < first) return null;
  if (count !== first || final !== first) {
    logger.info(`[seed] ${label}: fetched ${count}, upstream reported ${first} then ${final} — ` +
      'the corpus changed during the fetch');
  }
  return final;
}

/**
 * Every page of a dataset, each row once; fewer unique rows than the first total throws, more is
 * growth, its total re-read after the last page. `accumulate: false` streams: all docs overran 1.5 GB.
 * @param {function} [opts.onPage]           (newItems, uniqueSoFar, total) — progress or a handler
 * @param {function} [opts.onTotal]          (total) once at the end: the settled total; the first total on a capped read
 * @param {boolean}  [opts.accumulate=true]  false returns {count, total} instead of the items
 * @param {function} [opts.pageUrl]   (pageNum, pageSize) -> url; default the dataset's `/search` page
 * @param {function} [opts.fetchPage] url -> {items, total}; default an unauthenticated search fetch
 * @param {function} [opts.keyOf]     row -> its id, for the repeat check; default `_id`, else `id`
 * @param {number}   [opts.maxPages]  stop after this many pages; the total is then not verified
 */
async function fetchAllPages(base, dataset, opts = {}) {
  // A bare function is the onPage handler.
  const options = typeof opts === 'function' ? { onPage: opts } : opts;
  const {
    onPage, onTotal, keyOf, accumulate = true, maxPages = Infinity,
    pageUrl = (pageNum, pageSize) => `${base}/search?dataset=${encodeURIComponent(dataset)}` +
      `&pageSize=${pageSize}&pageNum=${pageNum}`,
    fetchPage = searchPage
  } = options;

  const items = [];
  const seen = new Set();
  let count = 0;
  let total = null;

  // Pages from `start` until a short page, `goal` unique rows (default the first total) or the cap.
  const readFrom = async (start, goal) => {
    for (let pageNum = start; ; pageNum++) {
      const page = await fetchPage(pageUrl(pageNum, PAGE_SIZE));
      if (total === null) total = page.total;
      const target = goal ?? total;

      // Offset paging repeats a row across a page boundary when one is inserted before the cursor.
      const fresh = freshById(page.items, seen, keyOf);
      count += fresh.length;
      if (accumulate) items.push(...fresh);
      if (onPage) await onPage(fresh, count, target);

      if (page.items.length < PAGE_SIZE) return { last: pageNum, capped: false };
      // A total of exactly N*PAGE_SIZE would otherwise cost one extra empty request.
      if (target !== null && count >= target) return { last: pageNum, capped: false };
      if (pageNum + 1 >= maxPages) return { last: pageNum, capped: true };
    }
  };
  // Re-read, so a caller that verifies the count (seed reconcile) compares it with the corpus as it
  // stood after the last page, not before the first.
  const reread = async () => (await fetchPage(pageUrl(0, 1))).total;

  let { last, capped } = await readFrom(0, null);
  if (!capped && total !== null) {
    let final = await reread();
    if (typeof final === 'number' && final > count && last + 1 < maxPages) {
      // Rows published mid-fetch sort last by _id, past where the cursor stopped. Restarted on the
      // last page read, since a short page grows in place. One pass only.
      ({ capped } = await readFrom(last, final));
      if (!capped) final = await reread();
    }
    // A pass the cap cut short leaves the total unverified, but still never below the first one.
    const settled = capped ? (count < total ? null : total) : settledTotal(count, total, final, dataset);
    if (settled === null) {
      throw new Error(
        `[seed] ${dataset}: fetched ${count} but upstream reports ${total} — refusing to ` +
        `seed a truncated corpus (re-read total ${final})`
      );
    }
    total = settled;
  }

  if (onTotal) onTotal(total);
  return accumulate ? items : { count, total };
}

/**
 * Whether the public search still serves row `id` of `dataset`, through the paged fetch's own
 * endpoint and filters: a surplus row it serves was skipped by the paging, not removed upstream.
 */
async function eagleRowLive(dataset, id, fetchPage = searchPage) {
  const url = `${EAGLE_API_BASE}/search?dataset=${encodeURIComponent(dataset)}&pageSize=1&pageNum=0` +
    `&and[_id]=${encodeURIComponent(id)}`;
  const { items, total } = await fetchPage(url);
  const found = items.some(row => row && String(row._id) === String(id));
  // A dropped filter answers with page 0 of the whole dataset: every surplus row would read as gone.
  if ((items.length && !found) || (typeof total === 'number' && total > (found ? 1 : 0))) {
    throw new Error(`eagle-api ignored the id filter for ${dataset} ${id}`);
  }
  return found;
}

/**
 * One live Track project in the flat shape of the checked-in export that `merge/project.js` reads.
 * A plain literal, so the two shapes can be diffed by eye.
 */
function trackApiToExtract(project) {
  return {
    track_project_id: project.id,
    name: project.name,
    description: project.description,
    epic_guid: project.epic_guid,
    latitude: project.latitude,
    longitude: project.longitude,
    address: project.address,
    abbreviation: project.abbreviation,
    is_active: project.is_active,
    proponent_name: nameOf(project.proponent),
    sub_type_name: nameOf(project.sub_type),
    type_name: nameOf(project.type),
    project_state_name: nameOf(project.project_state),
    ea_certificate: project.ea_certificate,
    eac_signed: project.eac_signed,
    eac_expires: project.eac_expires
  };
}

/** Client-credentials bearer for a confidential realm client. */
async function clientToken(clientId, clientSecret) {
  try {
    return (await clientCredentialsToken({ issuer: config.keycloakIssuer, clientId, clientSecret })).accessToken;
  } catch (err) {
    throw new Error(`[seed] ${err.message}`, { cause: err });
  }
}

const trackFeedConfigured = () =>
  Boolean(config.trackApiBase && config.trackClientId && config.trackClientSecret);

/**
 * Track's project list, RAW. The nightly sync reads `is_project_closed` off these rows as well as
 * the columns the mapper takes, so the two callers share one fetch rather than one shape.
 *
 * @param {function} [get] test seam, and the sync's own `deps.fetchJson`
 */
function fetchTrackProjects(token, get = fetchJson) {
  return get(`${config.trackApiBase}/api/v1/projects`, { Authorization: `Bearer ${token}` });
}

/**
 * The one Assessment work per Track project id whose phases are the progress rail, picked by
 * `pickAssessmentWork` so the derived fields read the same work.
 */
function assessmentWorkByProject(works) {
  const byProject = new Map();
  for (const work of works || []) {
    const key = projectKeyOf(work);
    if (key === null) continue;
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push({
      trackWorkId: work.id, workTypeId: workTypeIdOf(work), isActive: work.is_active === true,
      startDate: isoOrNull(work.start_date), eaAct: nameOf(work.ea_act) || null, work
    });
  }
  const picked = new Map();
  for (const [key, candidates] of byProject) {
    const chosen = pickAssessmentWork(candidates);
    if (chosen) picked.set(key, chosen.work);
  }
  return picked;
}

/** No new project's works are read once the works pull has run this long. */
const worksBudgetMs = 10 * 60 * 1000;

/** Projects whose works are read at once. */
const WORKS_CONCURRENCY = 8;

/**
 * Assessment phases and, with `opts.works`, every mirrored work, keyed by Track project id: `works` in the
 * row's public shape, `nested` as Track's `phases[].events[]`. A failed read leaves only that project out.
 * @param {function} [get] test seam, and the sync's own `deps.fetchJson`
 * @param {object} [opts] {works} pull works too, {now} clock seam, {budgetMs}
 */
async function fetchTrackWorks(token, get = fetchJson, opts = {}) {
  const { works: withWorks = false, now = Date.now, budgetMs = worksBudgetMs } = opts;
  const base = `${config.trackApiBase}/api/v1`;
  const headers = { Authorization: `Bearer ${token}` };
  // Not `GET /work-phases`: its rows carry no project id and it returns report-filtered phases.
  const workList = await get(`${base}/works`, headers);

  // Shared by both passes, so the assessment work's phases are read once.
  const phaseRows = new Map();
  let requests = 0;
  const phaseRowsOf = (workId) => {
    if (!phaseRows.has(workId)) {
      requests++;
      phaseRows.set(workId, get(`${base}/works/${workId}/phases`, headers));
    }
    return phaseRows.get(workId);
  };

  const phases = new Map();
  for (const [projectId, work] of assessmentWorkByProject(workList)) {
    try {
      const mapped = orderedPhases(await phaseRowsOf(work.id)).map(p => p.phase);
      if (mapped.length) phases.set(projectId, mapped);
    } catch (err) {
      logger.error(`[seed] work ${work.id} phases`, { error: err.message, stack: err.stack });
    }
  }

  const works = new Map();
  const nested = new Map();
  const stats = { projects: 0, works: 0, requests: 0, elapsedMs: 0, failures: 0, budgetHit: false };
  if (!withWorks) return { phases, works, nested, stats };

  const counted = (url) => { requests++; return get(url, headers); };
  // Track refuses `/outcome-configurations/` without `configuration_id`: one read per config.
  const outcomeNames = new Map();
  const outcomeNamesFor = (configurationId) => {
    if (!outcomeNames.has(configurationId)) {
      outcomeNames.set(configurationId,
        counted(`${base}/outcome-configurations/?configuration_id=${configurationId}`)
          .then(rows => new Map((rows || []).map(o => [o.id, o.name]))));
    }
    return outcomeNames.get(configurationId);
  };

  const eventsOf = async (workPhaseId) => {
    const events = await counted(`${base}/milestones/workphases/${workPhaseId}/events`);
    return Promise.all(shownEvents(events).map(async (e) => {
      const configurationId = e.event_configuration_id ?? (e.event_configuration || {}).id;
      const outcome = e.outcome_id == null ? null
        : (await outcomeNamesFor(configurationId)).get(e.outcome_id);
      return { ...e, outcome_name: outcome ?? null };
    }));
  };

  // The same nested shape Track's push sends, so one mapper serves both.
  const workOf = async (work) => {
    const phases = [];
    for (const { row } of orderedPhases(await phaseRowsOf(work.id))) {
      const wp = row.work_phase || {};
      phases.push({ ...wp, events: await eventsOf(wp.id) });
    }
    return { ...work, phases };
  };

  const byProject = new Map();
  for (const work of workList || []) {
    const key = projectKeyOf(work);
    if (!isMirrored(work) || key === null) continue;
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(work);
  }

  const started = now();
  const requestsBefore = requests;
  let skipped = 0;
  await mapLimit([...byProject], WORKS_CONCURRENCY, async ([projectId, projectWorks]) => {
    if (now() - started > budgetMs) { stats.budgetHit = true; skipped++; return; }
    try {
      const rows = [];
      for (const work of projectWorks.sort((a, b) => a.id - b.id)) rows.push(await workOf(work));
      nested.set(projectId, rows);
      works.set(projectId, rows.map(work => trackWorkToPublic(work, phaseEventsOf(work))));
      stats.works += rows.length;
    } catch (err) {
      stats.failures++;
      logger.error(`[seed] project ${projectId} works`, { error: err.message, stack: err.stack });
    }
  });
  stats.projects = works.size;
  stats.requests = requests - requestsBefore;
  stats.elapsedMs = now() - started;
  if (stats.budgetHit) {
    logger.warn(`[seed] works budget hit: projects=${works.size} skipped=${skipped} ` +
      `requests=${stats.requests}`);
  }
  logger.info(`[seed] works pull: projects=${stats.projects} works=${stats.works} ` +
    `requests=${stats.requests} elapsedMs=${stats.elapsedMs} failures=${stats.failures}`);
  return { phases, works, nested, stats };
}

/**
 * Track projects from the live API when a reader client is configured, else the checked-in export.
 * No fallback between the two: a stale file standing in for a failed fetch would report success.
 */
async function loadTrackProjects() {
  if (trackFeedConfigured()) {
    const rows = await fetchTrackProjects(
      await clientToken(config.trackClientId, config.trackClientSecret));
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error(`[seed] no Track projects returned by ${config.trackApiBase}`);
    }
    return rows.map(trackApiToExtract);
  }

  const file = path.join(__dirname, '../data/track_projects_enriched.json');
  const projects = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(projects) || projects.length === 0) {
    throw new Error(`[seed] no Track projects loaded from ${file}`);
  }
  return projects;
}

/**
 * Already flat: the search endpoint hoists the current `legislation_*` block to the root.
 * @param {object|function} [opts] `fetchAllPages` options
 */
function fetchEagleProjects(opts) {
  return fetchAllPages(EAGLE_API_BASE, 'Project', opts);
}

/**
 * Stream Eagle documents page by page. `onPage` handles each page and nothing is accumulated, so
 * peak memory is one page rather than the whole 60,661-document corpus.
 *
 * @returns {Promise<{count: number, total: number|null}>}
 */
function streamEagleDocuments(onPage) {
  return fetchAllPages(EAGLE_API_BASE, 'Document', { onPage, accumulate: false });
}

/**
 * List `_id` -> name, for resolving the `type` / `milestone` / `projectPhase` ObjectId refs on
 * documents. 213 items, so it is loaded once and held in memory.
 */
async function fetchListLookup() {
  const items = await fetchAllPages(EAGLE_API_BASE, 'List');
  return new Map(items.filter(l => l && l._id).map(l => [String(l._id), l.name || '']));
}

/**
 * The checked-in boundary exports, read from the frontend asset directory the export script
 * writes and the frontend reads, because a second copy would drift.
 */
function loadBoundaries() {
  const dir = path.join(__dirname, '../../frontend/public/assets/geojson');
  const files = ['regional_districts.geojson', 'municipalities.geojson', 'electoral_districts.geojson'];

  const all = [];
  for (const name of files) {
    const file = path.join(dir, name);
    const items = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error(`[seed] no boundaries loaded from ${file}`);
    }
    all.push(...items);
  }
  return all;
}

module.exports = {
  EAGLE_API_BASE,
  PAGE_SIZE,
  RATE_LIMIT_RETRIES,
  rateLimitWaitMs,
  fetchJson,
  fetchJsonWithHeaders,
  unwrapSearchResponse,
  fetchAllPages,
  eagleRowLive,
  freshById,
  settledTotal,
  clientToken,
  trackApiToExtract,
  trackFeedConfigured,
  fetchTrackProjects,
  loadTrackProjects,
  fetchTrackWorks,
  fetchEagleProjects,
  streamEagleDocuments,
  fetchListLookup,
  loadBoundaries
};
