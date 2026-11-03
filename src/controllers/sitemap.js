'use strict';

/**
 * GET /sitemap.xml: every public project page, for search engines. Port of eagle-api
 * `api/controllers/sitemap.js`. Loc is `/p/<eagleId>`, as eagle-api emitted (docs/eagle-api-port.md, Sitemap).
 */

const projects = require('../repositories/projects');
const { resolveAccess } = require('../helpers/access-sql');
const { redactForAccess } = require('../vis/redact');
const { defaultProjectUrl } = require('../helpers/short-links');
const { onePerEagleId } = require('../helpers/project-twin');
const { serverError } = require('../helpers/response');
const { logger } = require('../utils/logger');

const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_AGE_SECONDS = CACHE_TTL_MS / 1000;
// Sitemap protocol limit per file; past it the fix is a sitemap index, not a bigger file.
const MAX_ENTRIES = 50000;

let cache = null; // { promise, expiresAt }

/** `YYYY-MM-DD`, or null for a missing or unreadable date. */
function lastmodOf(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

/** `[eagleId, lastmod]` per public project page, sorted by Eagle id as eagle-api sorted `_id`. */
async function publicPages() {
  // Anonymous whoever asks: one cached answer serves every caller.
  const access = resolveAccess({});
  const { items } = await projects.listVisible(access, {});
  // The row's own dials can hide `eagleId` or `dateUpdated` from an anonymous reader.
  const visible = items.map(row => redactForAccess('projects', row, access));
  // A Track row and its `eagle-<id>` twin are one page; keep the later date.
  const later = (kept, row) =>
    ((lastmodOf(row.dateUpdated) || '') > (lastmodOf(kept.dateUpdated) || '') ? row : kept);
  return onePerEagleId(visible, later).map(([eagleId, row]) => [eagleId, lastmodOf(row.dateUpdated)]);
}

async function buildSitemap() {
  let pages = await publicPages();
  if (pages.length > MAX_ENTRIES) {
    logger.warn('[sitemap] public projects exceed the entry limit, truncating', { count: pages.length, limit: MAX_ENTRIES });
    pages = pages.slice(0, MAX_ENTRIES);
  }

  const urls = pages.map(([eagleId, lastmod]) => '  <url>\n'
    + `    <loc>${defaultProjectUrl({ eagleId })}</loc>\n`
    + (lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : '')
    + '  </url>\n');

  logger.info('[sitemap] rebuilt', { entries: urls.length });
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + urls.join('')
    + '</urlset>\n';
}

/** Built at most once an hour per instance; concurrent misses share one build. */
exports.getSitemap = async (req, res) => {
  const now = Date.now();
  if (!cache || cache.expiresAt <= now) {
    const entry = { promise: buildSitemap(), expiresAt: now + CACHE_TTL_MS };
    cache = entry;
    // A failed build must not be served for the rest of the hour.
    entry.promise.catch(() => {
      if (cache === entry) cache = null;
    });
  }

  let xml;
  try {
    xml = await cache.promise;
  } catch (err) {
    return serverError(res, err, 'sitemap build failed');
  }
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.set('Cache-Control', `public, max-age=${MAX_AGE_SECONDS}`);
  return res.status(200).send(xml);
};

/** Test seam: module state outlives one request, so a suite must be able to start from empty. */
exports._resetCache = () => {
  cache = null;
};
