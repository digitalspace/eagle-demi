'use strict';

const cosmos = require('../../src/db/cosmos-nosql');
const updatesRepo = require('../../src/repositories/updates');
const { MAX_PAGE_SIZE } = require('../../src/helpers/access-sql');

/** `n` rows with ids `<prefix>-0` up. */
const ids = (prefix, n) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}` }));

/**
 * A paged read gets `pageSize` rows a fetch, the rest behind a continuation; the first
 * `emptyFetches` answer no rows but a token. Returns the `{container, spec, options}` of every query.
 */
function pagedCosmos(t, rowsOf, { pageSize = MAX_PAGE_SIZE, emptyFetches = 0 } = {}) {
  // The updates parent gate caches its parent rows per process; drop them on both sides.
  updatesRepo.forgetParents();
  t.after(() => updatesRepo.forgetParents());
  const seen = [];
  let empties = emptyFetches;
  t.mock.method(cosmos, 'query', async (container, spec, options = {}) => {
    cosmos.assertQuerySpec(spec, container);
    seen.push({ container, spec, options });
    const rows = rowsOf(container);
    if (/COUNT\(1\)/.test(spec.query)) return { items: [rows.length] };
    if (!options.maxItemCount) return { items: rows.slice(), continuationToken: undefined };
    const start = Number(options.continuationToken || 0);
    if (empties > 0 && start < rows.length) {
      empties--;
      return { items: [], continuationToken: String(start) };
    }
    const end = start + Math.min(options.maxItemCount, pageSize, MAX_PAGE_SIZE);
    return {
      items: rows.slice(start, end),
      continuationToken: end < rows.length ? String(end) : undefined
    };
  });
  return seen;
}

module.exports = { ids, pagedCosmos };
