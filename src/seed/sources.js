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
 *   Eagle       eagle-api /api/public/search                           359 projects, 60,661 docs, 213 List items
 *   Boundaries  frontend/public/assets/geojson/*.geojson (checked in)   281 features
 */

const fs = require('fs');
const path = require('path');

const config = require('../config');

const EAGLE_API_BASE = process.env.EAGLE_API_BASE ||
  'https://eagle-dev.apps.silver.devops.gov.bc.ca/api/public';

/**
 * The API caps pageSize at 100 regardless of what is requested — asking for 1000 silently
 * returns 100, which makes a naive loop appear to work while reading a tenth of the data.
 */
const PAGE_SIZE = 100;

const FETCH_TIMEOUT_MS = parseInt(process.env.SEED_FETCH_TIMEOUT_MS || '120000', 10);
const FETCH_RETRIES = 3;

/** @param {object} [headers] request headers — the Track team feed needs a bearer token. */
async function fetchJson(url, headers) {
  let lastError;
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal, headers });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      // A transient failure mid-seed would otherwise truncate the corpus silently, so retry
      // rather than letting a partial page count as the end of the data.
      if (attempt < FETCH_RETRIES) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`[seed] failed to fetch ${url} after ${FETCH_RETRIES} attempts: ${lastError.message}`);
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
  fetchJson,
  unwrapSearchResponse,
  fetchAllPages,
  clientToken,
  trackApiToExtract,
  trackFeedConfigured,
  fetchTrackProjects,
  loadTrackProjects,
  fetchEagleProjects,
  streamEagleDocuments,
  fetchListLookup,
  loadBoundaries
};
