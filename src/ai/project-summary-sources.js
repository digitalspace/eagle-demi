'use strict';

/**
 * Where the generator reads its inputs and writes its output.
 *
 * The generator runs from a workstation, and Cosmos and AI Search are both private-endpoint only —
 * unreachable from anywhere but the VNet. The DEMI API is not: it is behind the proxy and answers a
 * staff token. So the generator talks to the API rather than to the data stores, and the ACL that
 * applies is the one on the caller's token, exactly as it would be for a page request.
 *
 * One adapter, one interface: `{project, documents, chunksForDocument, organizations, summary,
 * save}`. A later in-VNet caller (a timer, the devbox) can add a second implementation of the same
 * methods without the generator changing.
 */

const { logger } = require('../utils/logger');

/** Rows a document list asks for per request. The API caps an authenticated caller at 1,000. */
const DOCUMENT_PAGE_SIZE = 1000;
/** Organization rows in one page. There are 246 on test; this is one request with room to spare. */
const ORGANIZATION_PAGE_SIZE = 1000;

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
    // One or the other, never both: `helpers/auth.js` prefers `X-Api-Key` and would ignore a
    // bearer token silently, so a request carrying both would authenticate as something other than
    // what the operator thinks they passed.
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
     * Every document of one project, following the continuation token.
     *
     * The header is what carries it (`x-continuation-token`), so a caller that reads only the body
     * stops at the first 1,000 — Site C has 2,158 documents, so that is not a theoretical limit and
     * a truncated list would silently drop the Inspection Records the compliance counts come from.
     */
    async documents(projectId) {
      const all = [];
      let continuationToken;
      do {
        const query = new URLSearchParams({
          project: String(projectId), pageSize: String(DOCUMENT_PAGE_SIZE)
        });
        if (continuationToken) query.set('continuationToken', continuationToken);

        const res = await doFetch(`${base}/documents?${query}`, { headers });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`GET /documents -> ${res.status} ${text.slice(0, 200)}`);
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
     * The Indigenous Group Organization rows, which is what nation names are joined to.
     *
     * Through `/search`, not a repository: it is the read the plan confirmed against test, and it
     * is the only route that answers this container.
     */
    async organizations() {
      const query = new URLSearchParams({
        dataset: 'Organization',
        'and[companyType]': 'Indigenous Group',
        pageSize: String(ORGANIZATION_PAGE_SIZE)
      });
      const body = await call(`/search?${query}`);
      const first = Array.isArray(body) ? body[0] : body;
      return (first && first.searchResults) || [];
    },

    /** The record already stored, or null. What `--section` merges its one fresh section into. */
    summary: id => call(`/projects/${encodeURIComponent(id)}/summary`),

    save: record =>
      call(`/projects/${encodeURIComponent(record.id)}/summary`, { method: 'PUT', body: record })
  };
}

/**
 * The adapter for the current environment.
 *
 * Only one exists today. `DEMI_API_URL` unset is an error rather than a fallback: there is no
 * second path, and defaulting to one that cannot work would fail as a connection timeout to a
 * private endpoint rather than as a missing setting.
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
