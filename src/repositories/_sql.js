'use strict';

/**
 * Shared SQL-building helpers for the repositories.
 *
 * Deliberately small. This is NOT a query builder or an ORM — every repository writes its own
 * SQL so the emitted text is readable at the call site and reviewable in a diff. These helpers
 * only remove the mechanical parts (parameter naming, paging) that would otherwise be
 * copy-pasted nine times and drift.
 */

const { visibilityFor, andClauses } = require('../helpers/access-sql');

/**
 * A criterion is a SQL fragment plus its parameters — the same shape as readClause/scopeClause,
 * so everything composes through andClauses.
 *
 * Values are ALWAYS bound, never interpolated.
 */
function eq(field, value, paramName, alias = 'c') {
  return { clause: `${alias}.${field} = ${paramName}`, params: [{ name: paramName, value }] };
}

function isDefinedAndNotNull(field, alias = 'c') {
  return {
    clause: `(IS_DEFINED(${alias}.${field}) AND NOT IS_NULL(${alias}.${field}))`,
    params: []
  };
}

/**
 * Case-insensitive substring match. Uses CONTAINS with the case-insensitive flag rather than
 * RegexMatch: user input never becomes a pattern, so there is no regex-injection or ReDoS
 * surface, and the intent is clearer.
 */
function contains(field, value, paramName, alias = 'c') {
  return {
    clause: `CONTAINS(${alias}.${field}, ${paramName}, true)`,
    params: [{ name: paramName, value }]
  };
}

/**
 * Build a SELECT with the caller's visibility predicate ANDed to the supplied criteria.
 *
 * The visibility fragment always comes first and is never optional — a repository cannot
 * accidentally emit an unfiltered read by forgetting it.
 *
 * @param {object}   opts
 * @param {object}   opts.access           from resolveAccess()
 * @param {string}   opts.partitionField   'id' on projects, 'projectId' elsewhere
 * @param {Array}    [opts.criteria]       extra fragments
 * @param {string}   [opts.select='*']     projection — use to omit fields a caller may not see
 * @param {string}   [opts.orderBy]        e.g. 'c.name ASC' (the path must be indexed)
 * @returns {{query: string, parameters: Array}}
 */
function selectWhere({ access, partitionField, criteria = [], select = '*', orderBy }) {
  const predicate = andClauses(
    visibilityFor(access, partitionField),
    ...criteria.filter(Boolean)
  );

  let query = `SELECT ${select} FROM c WHERE ${predicate.clause}`;
  if (orderBy) query += ` ORDER BY ${orderBy}`;

  return { query, parameters: predicate.params };
}

/**
 * COUNT using the IDENTICAL predicate as the read.
 * A count built from a different filter leaks the true size of a collection the caller
 * cannot see, which is why this shares selectWhere rather than rebuilding the predicate.
 */
function countWhere({ access, partitionField, criteria = [] }) {
  const spec = selectWhere({ access, partitionField, criteria, select: 'VALUE COUNT(1)' });
  return spec;
}

/**
 * Paging options for the SDK. Continuation tokens rather than skip/take — Cosmos has no
 * efficient offset, so page N would cost the same as pages 1..N combined.
 */
function pageOptions({ pageSize, continuationToken, partitionKey } = {}) {
  const options = {};
  if (pageSize) options.maxItemCount = Math.min(Number(pageSize) || 0, 1000);
  if (continuationToken) options.continuationToken = continuationToken;
  if (partitionKey !== undefined) options.partitionKey = partitionKey;
  return options;
}

module.exports = { eq, contains, isDefinedAndNotNull, selectWhere, countWhere, pageOptions };
