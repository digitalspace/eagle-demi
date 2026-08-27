'use strict';

/**
 * Shared SQL-building helpers for the repositories.
 *
 * Deliberately small. This is NOT a query builder or an ORM — every repository writes its own
 * SQL so the emitted text is readable at the call site and reviewable in a diff. These helpers
 * only remove the mechanical parts (parameter naming, paging) that would otherwise be
 * copy-pasted nine times and drift.
 */

const cosmos = require('../db/cosmos-nosql');
const { visibilityFor, andClauses, MAX_PAGE_SIZE } = require('../helpers/access-sql');
const { catalogFor } = require('../vis/catalog');
const { visible } = require('../vis/redact');
const { ANONYMOUS_LEVEL, LEVELS } = require('../vis/level');

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
 * Membership test against a bounded list of values.
 *
 * An EMPTY list renders as `false`, never as an omitted clause: `IN ()` is not valid SQL, and the
 * tempting alternative — dropping the criterion — would silently widen the query from "these
 * specific rows" to "every row the caller may see".
 *
 * The caller supplies the parameter prefix so two IN clauses in one query cannot collide;
 * andClauses throws on a duplicate name rather than quietly dropping one.
 */
function inList(field, values, prefix, alias = 'c') {
  if (!Array.isArray(values) || values.length === 0) {
    return { clause: 'false', params: [] };
  }
  const names = values.map((_, i) => `${prefix}${i}`);
  return {
    clause: `${alias}.${field} IN (${names.join(', ')})`,
    params: names.map((name, i) => ({ name, value: values[i] }))
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
 * @param {string|null} opts.partitionField 'id' on projects, 'projectId' elsewhere, NULL for a
 *                                        container with no project axis (boundaries)
 * @param {Array}    [opts.criteria]       extra fragments
 * @param {string}   [opts.select='*']     projection — use to omit fields a caller may not see
 * @param {string}   [opts.orderBy]        e.g. 'c.name ASC' (the path must be indexed)
 * @returns {{query: string, parameters: Array}}
 */
function selectWhere({ access, partitionField, criteria = [], select = '*', orderBy, visibility = {} }) {
  const predicate = andClauses(
    visibilityFor(access, partitionField, visibility),
    ...criteria.filter(Boolean)
  );

  let query = `SELECT ${select} FROM c WHERE ${predicate.clause}`;
  if (orderBy) query += ` ORDER BY ${orderBy}`;

  return { query, parameters: predicate.params };
}

/**
 * The `select` projection for this caller: the catalog fields whose ceiling reaches their level, so
 * a value they could never see does not leave Cosmos at all.
 *
 * Defence in depth only — `redactForAccess` at the response boundary is what enforces the policy,
 * because a per-record dial can restrict below `maxVis` and a projection cannot read one it has not
 * fetched yet. Level 0 takes `*`: every field is visible to it.
 *
 * The row-plane fields are unconditional. `read` and the partition field feed `canRead` and the
 * derived `isPublished`, and the dial map has to be readable to be applied — dropping them would
 * blank `isPublished` for every caller.
 *
 * @param {string} entity          a key of src/vis/catalog
 * @param {object} access          from resolveAccess()
 * @param {string} partitionField  'id' on projects, 'projectId' elsewhere. Required: a default
 *   would give the next entity a projection missing its own partition key.
 */
function selectFor(entity, access, partitionField) {
  if (!partitionField) throw new Error('[vis] selectFor needs the entity partition field');

  // Same fail-closed resolution as redact.js: `null <= maxVis` is true for every ceiling, so an
  // unrecognised level must land on 4 rather than reach Cosmos as a comparison that always passes.
  const level = LEVELS.includes(access && access.level) ? access.level : ANONYMOUS_LEVEL;
  if (level === 0) return '*';

  const fields = new Set(['id', partitionField, 'read', 'isPublished', 'vis']);
  for (const [key, entry] of Object.entries(catalogFor(entity))) {
    // A dotted key projects its PARENT; the redactor narrows it back to the listed children.
    if (visible(level, entry.maxVis)) fields.add(key.split('.')[0]);
  }

  return [...fields].map(field => `c.${field}`).join(', ');
}

/**
 * COUNT using the IDENTICAL predicate as the read.
 * A count built from a different filter leaks the true size of a collection the caller
 * cannot see, which is why this shares selectWhere rather than rebuilding the predicate.
 */
function countWhere({ access, partitionField, criteria = [], visibility = {} }) {
  const spec = selectWhere({ access, partitionField, criteria, select: 'VALUE COUNT(1)', visibility });
  return spec;
}

/**
 * Paging options for the SDK. Continuation tokens rather than skip/take — Cosmos has no
 * efficient offset, so page N would cost the same as pages 1..N combined.
 */
function pageOptions({ pageSize, continuationToken, partitionKey } = {}) {
  const options = {};
  // A junk, zero or negative pageSize must NOT drop maxItemCount: cosmos.query then takes the
  // fetchAll() branch and drains the whole container cross-partition on an anonymous request.
  if (pageSize !== undefined) options.maxItemCount = Math.min(Math.max(Number(pageSize) || MAX_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  if (continuationToken) options.continuationToken = continuationToken;
  if (partitionKey !== undefined) options.partitionKey = partitionKey;
  return options;
}

/**
 * Every row a query matches, at the SDK's own page size and following any continuation token.
 *
 * For bounded whole-container reads only (the seeder's reconcile and per-project extraction
 * state). No request path may call this — an unbounded read is what `pageOptions` exists to
 * prevent.
 */
async function fetchAll(container, spec, opts = {}) {
  const rows = [];
  let continuationToken;
  do {
    // No maxItemCount, deliberately: it is what makes cosmos.query page by hand, and the SDK drops
    // `x-ms-continuation` on a cross-partition query, so a paged read here stops silently at 1,000
    // rows. Unset takes the SDK's own fetchAll(), which drains the result set itself.
    const page = await cosmos.query(container, spec,
      pageOptions({ ...opts, continuationToken }));
    for (const item of page.items) rows.push(item); // spread caps at ~125k args
    continuationToken = page.continuationToken;
  } while (continuationToken);
  return rows;
}

module.exports = {
  eq,
  inList,
  isDefinedAndNotNull,
  selectWhere,
  selectFor,
  countWhere,
  pageOptions,
  fetchAll
};
