'use strict';

/**
 * `GET /counts?kind=<kind>[,...]`: `{ <kind>: <count> }` through each kind's own list spec, so a count
 * never answers what its list would hide. No `kind` counts `DEFAULT_KINDS`; a filter must then fit both.
 */

const { resolveAccess } = require('../../helpers/access-sql');
const { accessFingerprint, createCountsCache } = require('../../helpers/counts-cache');
const { parseNativeQuery, nativeCriteria } = require('../../helpers/native-query');
const { serverError, searchServiceError } = require('../../helpers/response');
const { NO_STORE } = require('../nosql/mirror-reads');

// A count up to 45 s old: the same bound `/search/counts` badges are served under.
const countsCache = createCountsCache();

/**
 * Kind name -> its list's kind spec, loaded on first use so a kind's controller loads only when
 * counted. A new native kind adds its line here.
 */
const KINDS = {
  projects: () => require('../nosql/project').projectsKind,
  documents: () => require('../nosql/document').documentsKind,
  updates: () => require('./updates').SPEC,
  notifications: () => require('./notifications').SPEC
};

// Every other kind is counted only when named, so a no-`kind` call costs no extra reads.
const DEFAULT_KINDS = Object.freeze(['projects', 'documents']);

// These shape a page or its rows, and a count has none: refused, not ignored.
const PAGE_PARAMS = Object.freeze(['page', 'pageSize', 'sort', 'count', 'highlight']);

function requestedKinds(raw) {
  if (raw === undefined) return { kinds: DEFAULT_KINDS };
  if (Array.isArray(raw)) return { error: 'parameter given more than once: kind' };
  const kinds = [...new Set(String(raw).split(',').map(kind => kind.trim()).filter(Boolean))];
  if (kinds.length === 0) return { error: 'kind needs at least one kind' };
  const unknown = kinds.find(kind => !Object.hasOwn(KINDS, kind));
  if (unknown) return { error: `unknown kind: ${unknown}` };
  return { kinds };
}

exports.counts = async (req, res) => {
  try {
    const access = resolveAccess(req);
    if (access.authenticated) res.setHeader('cache-control', NO_STORE);

    const { kind, ...query } = req.query || {};
    const paging = Object.keys(query).find(key => PAGE_PARAMS.includes(key));
    if (paging) return res.status(400).json({ error: `unknown parameter: ${paging}` });

    const { kinds, error } = requestedKinds(kind);
    if (error) return res.status(400).json({ error });

    // Every kind is parsed before any is read, so one refusal sends no query at all.
    const reads = [];
    for (const name of kinds) {
      const spec = KINDS[name]();
      // A count reads no page; one row keeps a paged index store under its page cap.
      const parsed = parseNativeQuery(spec, { ...query, pageSize: '1' }, access);
      if (parsed.error) return res.status(400).json({ error: `${name}: ${parsed.error}` });
      reads.push({ name, spec, parsed, criteria: nativeCriteria(spec, parsed, access).criteria });
    }

    // Keyed only after every kind parsed, so a refusal is never cached.
    const sortedQuery = Object.keys(query).sort().map(key => [key, query[key]]);
    const { promise } = countsCache.read(JSON.stringify([kinds, sortedQuery, accessFingerprint(access)]),
      async () => {
        const totals = await Promise.all(reads.map(({ spec, criteria, parsed }) =>
          spec.repository.count(access, { criteria, parsed })));
        return Object.fromEntries(reads.map(({ name }, i) => [name, totals[i]]));
      });
    return res.json(await promise);
  } catch (err) {
    const searchFailed = searchServiceError(res, err, 'counts');
    if (searchFailed) return searchFailed;
    // An index store refuses a value its column cannot take (`legislation=x`) as the list does.
    if (err && err.status === 400) return res.status(400).json({ error: err.message });
    return serverError(res, err, 'counts failed');
  }
};

exports.KINDS = KINDS;
exports.resetCountsCache = () => countsCache.clear();
