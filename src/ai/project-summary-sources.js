'use strict';

// The generator runs outside the VNet, where Cosmos and AI Search (private endpoints) cannot be
// reached, so it reads and writes through the DEMI API under the caller token's ACL.

const { logger } = require('../utils/logger');

/** Rows a document list asks for per request. The API caps an authenticated caller at 1,000. */
const DOCUMENT_PAGE_SIZE = 1000;
/** Organization rows in one page. `and[companyType]` is a filter, so `/search` caps this at 500. */
const ORGANIZATION_PAGE_SIZE = 500;
/** Documents per page of a chunk search: `pageSize` there is a window of chunks, ten per document. */
const CHUNK_SEARCH_PAGE_SIZE = 20;

/** The rows of a `/search` answer, which is always `[{searchResults, count}]`. */
function searchResults(body) {
  const first = Array.isArray(body) ? body[0] : body;
  return (first && first.searchResults) || [];
}

/**
 * The DEMI API over HTTP.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl  the API base — everything below is appended to it, so this must be
 *   the path `/projects` and `/documents` hang off, whatever the proxy exposes them under
 * @param {string} [opts.token]  a staff bearer token
 * @param {string} [opts.apiKey] an API key, for the `X-Api-Key` header the auth helper accepts
 * @param {Function} [opts.fetchImpl]  test seam
 */
function apiSource({ baseUrl, token, apiKey, fetchImpl } = {}) {
  if (!baseUrl) throw new Error('apiSource requires a baseUrl');
  const base = String(baseUrl).replace(/\/$/, '');
  const doFetch = fetchImpl || fetch;

  if (!token && !apiKey) throw new Error('apiSource requires a token or an API key');

  const headers = {
    'Content-Type': 'application/json',
    // One or the other, never both: `helpers/auth.js` prefers `X-Api-Key` and silently ignores a
    // bearer token sent beside it.
    ...(apiKey ? { 'X-Api-Key': apiKey } : { Authorization: `Bearer ${token}` })
  };

  async function call(path, { method = 'GET', body } = {}) {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  return {
    project: id => call(`/projects/${encodeURIComponent(id)}`),

    /**
     * Every document of one project. The continuation token is in the `x-continuation-token`
     * header; reading only the body stops at 1,000 and silently drops documents past that.
     */
    async documents(projectId) {
      const all = [];
      let continuationToken;
      do {
        const query = new URLSearchParams({
          project: String(projectId), pageSize: String(DOCUMENT_PAGE_SIZE)
        });
        if (continuationToken) query.set('continuationToken', continuationToken);

        const res = await doFetch(`${base}/documents/scan?${query}`, { headers });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`GET /documents/scan -> ${res.status} ${text.slice(0, 200)}`);
        }
        const page = await res.json();
        for (const row of page || []) all.push(row);
        continuationToken = res.headers && res.headers.get
          ? res.headers.get('x-continuation-token')
          : null;
      } while (continuationToken);

      logger.info('[project-summary] documents read', {
        projectId: String(projectId), count: all.length
      });
      return all;
    },

    /** Every chunk of one document, in page order. Paged, for the same reason documents are. */
    async chunksForDocument(documentId) {
      const items = [];
      for (let page = 1; ; page++) {
        const query = new URLSearchParams({ page: String(page), pageSize: '500' });
        const body = await call(
          `/documents/${encodeURIComponent(documentId)}/chunks?${query}`);
        const rows = (body && body.items) || [];
        for (const row of rows) items.push(row);
        if (rows.length < 500) break;
      }
      return { items, count: items.length };
    },

    /**
     * The project's documents whose text matches `keywords`, best first. Rows carry a display
     * snippet and empty `content`, so the caller reads the chunks to ground and cite.
     */
    async chunkSearch({ projectId, keywords, pageSize = CHUNK_SEARCH_PAGE_SIZE }) {
      const query = new URLSearchParams({
        dataset: 'DocumentChunk',
        'and[projectId]': String(projectId),
        keywords: String(keywords),
        pageSize: String(pageSize)
      });
      return searchResults(await call(`/search?${query}`));
    },

    /**
     * The Indigenous Group Organization rows that nation names are joined to. Through `/search`:
     * it is the only route that answers this container.
     */
    async organizations() {
      const all = [];
      for (let pageNum = 0; ; pageNum++) {
        const query = new URLSearchParams({
          dataset: 'Organization',
          'and[companyType]': 'Indigenous Group',
          pageSize: String(ORGANIZATION_PAGE_SIZE),
          pageNum: String(pageNum)
        });
        const page = searchResults(await call(`/search?${query}`));
        for (const row of page) all.push(row);
        if (page.length < ORGANIZATION_PAGE_SIZE) break;
      }
      return all;
    },

    /** The record already stored, or null. What `--section` merges its one fresh section into. */
    summary: id => call(`/projects/${encodeURIComponent(id)}/summary`),

    save: record =>
      call(`/projects/${encodeURIComponent(record.id)}/summary`, { method: 'PUT', body: record })
  };
}

/**
 * The adapter for the current environment. `DEMI_API_URL` unset throws: any fallback would fail
 * later as a connection timeout to a private endpoint.
 */
function sourceFor(env = process.env) {
  if (!env.DEMI_API_URL) {
    throw new Error(
      'DEMI_API_URL is not set. The generator reads and writes through the DEMI API — Cosmos and ' +
      'AI Search are private-endpoint only.');
  }
  return apiSource({
    baseUrl: env.DEMI_API_URL,
    token: env.DEMI_TOKEN,
    apiKey: env.DEMI_API_KEY
  });
}

module.exports = { apiSource, sourceFor };
