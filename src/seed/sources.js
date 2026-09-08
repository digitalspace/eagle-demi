'use strict';

/**
 * Upstream source loaders for the seed.
 *
 * All I/O lives here so `transform.js` and `merge/project.js` stay pure and testable. Nothing
 * here writes anywhere — these functions only read.
 *
 * Sources, verified 2026-07-30:
 *
 *   Track       ${TRACK_API_BASE}/api/v1/projects (live, bearer)          384 projects
 *               src/data/track_projects_enriched.json — offline fallback  382 projects
 *               ${TRACK_API_BASE}/api/v1/works + /works/<id>/phases       work phases, live only
 *   Eagle       eagle-api /api/public/search                           359 projects, 60,661 docs, 213 List items
 *   Boundaries  frontend/public/assets/geojson/*.geojson (checked in)   281 features
 */

const fs = require('fs');
const path = require('path');

const config = require('../config');
const { logger } = require('../utils/logger');

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
 * Being throttled gets its own, longer budget than an ordinary failure.
 *
 * eagle-api allows 200 requests a minute (`ratelimit-policy: 200;w=60`) and a comment sweep spends
 * that inside a minute, so the whole run used to die on `HTTP 429` a few minutes in. Waiting the
 * window out is the fix; three one-second retries are not, and they cost the run its budget.
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
 * How long to wait out a 429.
 *
 * `retry-after` wins because it is the server's own instruction, then `ratelimit-reset` (seconds
 * left in the current window), then the window length off `ratelimit-policy` (`200;w=60`). A
 * response carrying none of them falls back to a 5/15/60 second ladder.
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
 * The body AND the response headers, retried.
 *
 * `/api/public/comment` reports its total in `x-total-count` rather than in the body, so the
 * comment backfill needs the header. Everything else wants the body alone — see `fetchJson`.
 *
 * A 429 is not counted as one of those attempts: it means the request was never served, so it is
 * waited out against its own budget and the ordinary retries stay for real failures.
 *
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
 * One page of an EPIC-style search endpoint.
 *
 * The response shape is `[{ meta: [{searchResultsTotal}], searchResults: [...] }]` — an array
 * wrapping a single object. Guarded rather than assumed: an upstream shape change would
 * otherwise read as "zero results" and seed an empty database.
 */
function unwrapSearchResponse(body, url) {
  const envelope = Array.isArray(body) ? body[0] : body;
  if (!envelope || !Array.isArray(envelope.searchResults)) {
    throw new Error(`[seed] unexpected search response shape from ${url}`);
  }
  const total = envelope.meta && envelope.meta[0] && envelope.meta[0].searchResultsTotal;
  return { items: envelope.searchResults, total: typeof total === 'number' ? total : null };
}

/**
 * Every page of a dataset.
 *
 * Stops on a short or empty page and then VERIFIES the count against the reported total. A
 * mismatch throws: seeding a silently truncated corpus is worse than not seeding at all, because
 * the result looks complete.
 *
 * `opts.accumulate: false` returns only the count and never builds the full array. The document
 * stage uses it to transform page by page: holding all 60,661 raw payloads AND their transformed
 * forms peaked at ~250 MB for 45,000 documents in a dry run, and the API runs on a Consumption
 * plan with 1.5 GB. Streaming keeps peak flat at one page.
 *
 * @param {function} [opts.onPage]           (items, fetchedSoFar, total) — progress or a handler
 * @param {boolean}  [opts.accumulate=true]  false returns {count, total} instead of the items
 */
async function fetchAllPages(base, dataset, opts = {}) {
  // Historically this took a bare callback as the third argument.
  const options = typeof opts === 'function' ? { onPage: opts } : opts;
  const { onPage, accumulate = true } = options;

  const items = [];
  let count = 0;
  let total = null;

  for (let pageNum = 0; ; pageNum++) {
    const url = `${base}/search?dataset=${encodeURIComponent(dataset)}` +
      `&pageSize=${PAGE_SIZE}&pageNum=${pageNum}`;
    const page = unwrapSearchResponse(await fetchJson(url), url);
    if (total === null) total = page.total;

    count += page.items.length;
    if (accumulate) items.push(...page.items);
    if (onPage) await onPage(page.items, count, total);

    if (page.items.length < PAGE_SIZE) break;
    // A total of exactly N*PAGE_SIZE would otherwise cost one extra empty request.
    if (total !== null && count >= total) break;
  }

  if (total !== null && count !== total) {
    throw new Error(
      `[seed] ${dataset}: fetched ${count} but upstream reports ${total} — refusing to ` +
      'seed a truncated corpus'
    );
  }

  return accumulate ? items : { count, total };
}

/** Track sends these either nested (`{name}`) or as a bare string, depending on the endpoint. */
const nameOf = (v) => (v && typeof v === 'object' ? v.name : v);

/**
 * One live Track project in the flat shape `merge/project.js` reads.
 *
 * The API nests what the checked-in export flattened and calls the id `id`; every other column
 * keeps its name. Kept as a plain literal so the two shapes can be diffed by eye.
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
    ea_certificate: project.ea_certificate
  };
}

/** Client-credentials bearer for a confidential realm client. */
async function clientToken(clientId, clientSecret) {
  const res = await fetch(
    `${config.keycloakUrl}/realms/${config.keycloakRealm}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret
      })
    });
  if (!res.ok) throw new Error(`[seed] token for ${clientId}: HTTP ${res.status}`);
  return (await res.json()).access_token;
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

/** Track's `WorkTypeEnum.ASSESSMENT` (models/work_type.py). The EA work whose phases are the rail. */
const ASSESSMENT_WORK_TYPE_ID = 6;

/** Track sends timestamps with a zone; anything unparseable lands as null rather than a bad date. */
function isoOrNull(value) {
  if (!value) return null;
  const at = new Date(value);
  return isNaN(at.getTime()) ? null : at.toISOString();
}

/**
 * One `GET /works/<id>/phases` row, in the public shape a project document carries.
 *
 * `work_phase.name` wins over the phase code's: Track lets a work rename its own phase, and the
 * renamed one is what its staff and its reports use.
 */
function trackPhaseToPublic(row) {
  const wp = (row && row.work_phase) || {};
  const phase = wp.phase || {};
  const eaAct = phase.ea_act || {};
  return {
    name: wp.name || phase.name || null,
    eaActId: phase.ea_act_id ?? eaAct.id ?? null,
    eaActName: eaAct.name || null,
    workType: (phase.work_type || {}).name || null,
    startDate: isoOrNull(wp.start_date),
    endDate: isoOrNull(wp.end_date),
    numberOfDays: wp.number_of_days ?? null,
    legislated: wp.legislated ?? null,
    sortOrder: wp.sort_order ?? null,
    isCompleted: wp.is_completed === true
  };
}

/**
 * The one Assessment work per project whose phases DEMI mirrors, keyed by Track project id.
 *
 * A project also carries amendments, extensions and post-EAC reviews; only the assessment is the
 * progress rail. Between two assessment works the live one wins, then the most recent.
 */
function assessmentWorkByProject(works) {
  const preferred = (candidate, held) =>
    (candidate.is_active === true) !== (held.is_active === true)
      ? candidate.is_active === true
      : Number(candidate.id) > Number(held.id);

  const byProject = new Map();
  for (const work of works || []) {
    const workType = work.work_type_id ?? (work.work_type || {}).id;
    if (Number(workType) !== ASSESSMENT_WORK_TYPE_ID) continue;
    const projectId = work.project_id ?? (work.project || {}).id;
    if (projectId === undefined || projectId === null) continue;

    const key = String(projectId);
    const held = byProject.get(key);
    if (!held || preferred(work, held)) byProject.set(key, work);
  }
  return byProject;
}

/**
 * Track work phases, `trackProjectId -> phases[]` sorted by `sortOrder`.
 *
 * CALL PLAN: one `GET /works` for the work list, then one `GET /works/<id>/phases` per assessment
 * work — about one request per project a night. `GET /work-phases` cannot replace the pair: its
 * rows carry no project id, and it filters to completed, legislated, over- or under-budget phases
 * (it is the insights report, api/services/work_phase.py). `GET /projects?with_works=true` only
 * FILTERS the project list — its response schema carries no works at all.
 *
 * One work's phases failing is logged and skipped rather than thrown: the other ~400 projects'
 * phases are worth more than an all-or-nothing run.
 *
 * @param {function} [get] test seam, and the sync's own `deps.fetchJson`
 */
async function fetchTrackWorkPhases(token, get = fetchJson) {
  const headers = { Authorization: `Bearer ${token}` };
  const works = await get(`${config.trackApiBase}/api/v1/works`, headers);

  const byProject = new Map();
  for (const [projectId, work] of assessmentWorkByProject(works)) {
    try {
      const rows = await get(`${config.trackApiBase}/api/v1/works/${work.id}/phases`, headers);
      const phases = (rows || []).map(trackPhaseToPublic)
        .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
      if (phases.length) byProject.set(projectId, phases);
    } catch (err) {
      logger.error(`[seed] work ${work.id} phases`, { error: err.message });
    }
  }
  return byProject;
}

/**
 * Track work phases when a reader client is configured, an EMPTY MAP otherwise — the checked-in
 * export carries none, and a caller that has no Track credentials must still finish its run.
 */
async function loadTrackWorkPhases() {
  if (!trackFeedConfigured()) return new Map();
  return fetchTrackWorkPhases(await clientToken(config.trackClientId, config.trackClientSecret));
}

/**
 * Track projects: the live API when a reader client is configured, the checked-in export
 * otherwise. Authoritative for project identity either way.
 *
 * NO FALLBACK BETWEEN THE TWO. A stale file standing in for a failed fetch would seed the
 * 2026-07-29 registry and report success; `fetchJson` already retries three times.
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

/** Already flat: the search endpoint hoists the current `legislation_*` block to the root. */
function fetchEagleProjects(onPage) {
  return fetchAllPages(EAGLE_API_BASE, 'Project', { onPage });
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
 * Organization `_id` -> `{_id, name, province}` — the three fields eagle-api's push resolves
 * `pins` to. The public search returns `pins` as bare ObjectIds, so without this lookup the seed
 * would store a different pin shape than the push does. 733 organizations, so it loads once.
 */
async function fetchOrganizationLookup() {
  const orgs = await fetchAllPages(EAGLE_API_BASE, 'Organization');
  return new Map(orgs.filter(o => o && o._id).map(o => [
    String(o._id), { _id: String(o._id), name: o.name || null, province: o.province || null }
  ]));
}

/**
 * The checked-in boundary exports.
 *
 * Read from the frontend asset directory because that is where the export script already writes
 * them and where the frontend already reads them — a second copy would drift.
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
  clientToken,
  trackApiToExtract,
  trackFeedConfigured,
  fetchTrackProjects,
  loadTrackProjects,
  fetchTrackWorkPhases,
  loadTrackWorkPhases,
  fetchEagleProjects,
  streamEagleDocuments,
  fetchListLookup,
  fetchOrganizationLookup,
  loadBoundaries
};
