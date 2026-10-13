'use strict';

/**
 * `GET /counts?kind=<kind>[,<kind>...]&<filters>&q=`: how many rows each kind's list would hold for
 * this caller, as a plain object `{ <kind>: <count> }`.
 *
 * Each count is the kind's own list spec read through `count`, so it takes the list's filters,
 * `q` and `ids`, the same visibility predicate, and the same refusal of a filter on a field the
 * caller cannot see. A count may never answer what its list would hide.
 *
 * No `kind` counts every registered kind; a filter then has to be one every kind declares.
 */

const { resolveAccess } = require('../../helpers/access-sql');
const { parseNativeQuery, nativeCriteria } = require('../../helpers/native-query');
const { serverError } = require('../../helpers/response');
const { NO_STORE } = require('../nosql/mirror-reads');

/**
 * Kind name -> its list's kind spec, loaded on first use so a kind's controller loads only when
 * counted. A new native kind adds its line here.
 */
const KINDS = {
  projects: () => require('../nosql/project').projectsKind
};

// These shape a page, and a count has none: refused, not ignored.
const PAGE_PARAMS = Object.freeze(['page', 'pageSize', 'sort', 'count']);

function requestedKinds(raw) {
  if (raw === undefined) return { kinds: Object.keys(KINDS) };
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
      const parsed = parseNativeQuery(spec, query, access);
      if (parsed.error) return res.status(400).json({ error: `${name}: ${parsed.error}` });
      reads.push({ name, spec, parsed, criteria: nativeCriteria(spec, parsed, access).criteria });
    }

    const totals = await Promise.all(reads.map(({ spec, criteria, parsed }) =>
      spec.repository.count(access, { criteria, parsed })));
    return res.json(Object.fromEntries(reads.map(({ name }, i) => [name, totals[i]])));
  } catch (err) {
    return serverError(res, err, 'counts failed');
  }
};

exports.KINDS = KINDS;
