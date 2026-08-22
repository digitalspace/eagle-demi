'use strict';

/**
 * Visibility for Azure AI Search. The OData twin of `access-sql.js`.
 *
 * Roles, tiers and project scope are NOT re-derived here — they are imported, so the two search
 * backends cannot drift into disagreeing about who may see what. This module only translates an
 * already-resolved access context into an OData `$filter`.
 *
 * The two dimensions are the same as everywhere else: `read[]` holds role TYPES, and project scope
 * rides `projectId`. See `access-sql.js` for why they must stay separate.
 */

const { TIER, PUBLIC_ROLES, isPrivileged } = require('./access-sql');

/**
 * OData string literals are single-quoted, and a literal quote is escaped by DOUBLING it.
 *
 * Role names arrive from a verified token rather than from the query string, so this is defence in
 * depth rather than the last line — but it is the only escaping there is. There is no bound
 * parameter form in an OData filter: the value IS the query text.
 */
function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * `search.in(field, 'a,b,c', ',')` rather than a chain of `eq ... or ...`.
 *
 * One clause regardless of how many roles the caller carries, and the list is a single literal —
 * so the filter length grows with the data, not with the number of OR branches. A comma inside a
 * value would split the list, so values carrying one fall back to an explicit `eq` chain.
 */
function inClause(expression, values) {
  const list = Array.from(new Set(values.map(String)));
  if (list.some(v => v.includes(','))) {
    return `(${list.map(v => `${expression} eq ${quote(v)}`).join(' or ')})`;
  }
  return `search.in(${expression}, ${quote(list.join(','))}, ',')`;
}

/**
 * The visibility filter for this caller.
 *
 * @param {object} access from resolveAccess()
 * @param {string} [partitionField='projectId']  the field carrying project identity in THIS index
 * @returns {{filter: string|null, empty: boolean}}
 *   filter — the OData `$filter`, or null for "no restriction" (privileged only)
 *   empty  — true when this caller can match NOTHING; the caller must return [] and issue no
 *            request at all
 *
 * THE `empty` FLAG IS THE FAIL-CLOSED PATH, and it exists because **OData has no `false`
 * literal**. `access-sql.js` collapses an impossible predicate to the SQL `false`; there is no
 * equivalent here, and the obvious alternatives are all wrong in the dangerous direction — a null
 * filter is UNRESTRICTED, and an empty string is unrestricted too. So "matches nothing" cannot be
 * expressed as a filter and has to be expressed as "do not ask".
 *
 * `partitionField` exists for the same reason `visibilityFor(access, partitionField)` takes one in
 * `access-sql.js`: a project IS its own scope, so on `projects` the field is `id`, while
 * documents and chunks carry `projectId`. Scoping projects on a `projectId` they do not have would
 * match nothing at all — and an empty result is indistinguishable from an empty corpus.
 */
function filterFor(access, partitionField = 'projectId') {
  // No access context at all is not a privileged caller — it is a bug upstream. Fail closed.
  if (!access) return { filter: null, empty: true };

  const clauses = [];

  // Privileged lifts the ROLE predicate only, never the project scope — the twin of `readClause`
  // returning `true` while `scopeClause` still narrows. Short-circuiting the whole function here
  // discarded the scope, so a scoped privileged key searched the entire corpus.
  if (!isPrivileged(access.roles || [])) {
    const roles = Array.from(new Set([...(access.roles || []), ...PUBLIC_ROLES]));
    // `read/any(r: ...)` is the collection form. Without `any`, the filter compares the collection
    // itself and matches nothing — silently, which on this path would read as an empty corpus.
    clauses.push(`read/any(r: ${inClause('r', roles)})`);
  }

  if (access.tier === TIER.SCOPED) {
    const scope = access.projectScope;
    // Scoped to nothing must match nothing. Never fall through to the role clause alone, which
    // would hand a project-scoped caller the whole public corpus.
    if (!Array.isArray(scope) || scope.length === 0) return { filter: null, empty: true };
    clauses.push(inClause(partitionField, scope));
  }

  // No clauses means an unscoped privileged caller: unrestricted, and `null` says so explicitly
  // rather than emitting an empty string that a caller might send as a filter.
  if (clauses.length === 0) return { filter: null, empty: false };

  return { filter: clauses.join(' and '), empty: false };
}

module.exports = {
  filterFor,
  // Exported for tests: escaping is the part worth pinning, since there is no parameter binding.
  quote
};
