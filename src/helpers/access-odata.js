'use strict';

/**
 * OData twin of `access-sql.js` for AI Search. Roles, tiers and scope are imported, not re-derived,
 * so the two backends cannot disagree about who sees what.
 */

const {
  TIER, PUBLIC_ROLES, LEVEL_TOKENS, SEALED_TOKEN, isPrivileged, opensSealed, levelTokens,
  credentialField
} = require('./access-sql');

/**
 * OData escapes a quote by doubling it. OData filters have no bound parameters, so this is the only
 * escaping there is; role names come from a verified token, so it is defence in depth.
 */
function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * One `search.in` clause however many values, so the filter does not grow by OR branches. A value
 * holding a comma would split the list, so those fall back to an `eq` chain.
 */
function inClause(expression, values) {
  const list = Array.from(new Set(values.map(String)));
  if (list.some(v => v.includes(','))) {
    return `(${list.map(v => `${expression} eq ${quote(v)}`).join(' or ')})`;
  }
  return `search.in(${expression}, ${quote(list.join(','))}, ',')`;
}

/**
 * `empty` is the fail-closed path: OData has no `false` literal and a null or empty filter is
 * unrestricted, so "matches nothing" means the caller returns [] and sends no request.
 * @param {object} access from resolveAccess()
 * @param {string} [partitionField='projectId']  project field in this index: `id` on projects, `projectId` on documents and chunks
 * @param {string|null} [documentField=null]  field a document-scoped credential compares: `id` on documents, `documentId` on chunks
 * @returns {{filter: string|null, empty: boolean}}  null filter = unrestricted (privileged only)
 */
function filterFor(access, partitionField = 'projectId', documentField = null) {
  // No access context at all is not a privileged caller — it is a bug upstream. Fail closed.
  if (!access) return { filter: null, empty: true };

  const clauses = [];

  // Privileged lifts the role predicate only, never the project scope, as on the SQL side.
  if (!isPrivileged(access.roles || [])) {
    const roles = Array.from(new Set([...(access.roles || []), ...PUBLIC_ROLES]));
    // `read/any(r: ...)` is the collection form. Without `any`, the filter compares the collection
    // itself and matches nothing — silently, which on this path would read as an empty corpus.
    const grants = [`read/any(r: ${inClause('r', roles)})`];

    // Team arm, level 1, ORed as in `readClause`. Skipped for a null `partitionField`: rows with no
    // project axis carry no team scope, and `search.in(null, …)` is a 400.
    const teams = access.teams || [];
    if (teams.length > 0 && partitionField) {
      grants.push(`(read/any(r: r eq ${quote(LEVEL_TOKENS[1])})` +
        ` and ${inClause(partitionField, teams)})`);
    }

    // Credential arm, ORed. `not read/any(...)` holds `levels` to the row's own level, since tokens
    // nest upward; see `levelTokens`.
    for (const cred of access.credentials || []) {
      const field = credentialField(cred, partitionField, documentField);
      const ids = (cred.scope && cred.scope.ids) || [];
      const { granted, wider } = levelTokens(cred.levels);
      if (!field || ids.length === 0 || granted.length === 0) continue;

      grants.push(
        `(${inClause(field, ids)} and read/any(r: ${inClause('r', granted)})` +
        (wider.length ? ` and not read/any(r: ${inClause('r', wider)})` : '') +
        ')'
      );
    }

    clauses.push(grants.length > 1 ? `(${grants.join(' or ')})` : grants[0]);
  }

  // Sealed exclusion sits outside the privilege branch: privileged callers are the ones it is for.
  if (!opensSealed(access.roles, access.compartment)) {
    clauses.push(`not read/any(r: r eq ${quote(SEALED_TOKEN)})`);
  }

  // Null `partitionField` = no project axis (`project-notifications`): skip scoping as `scopeClause`
  // does, else scoped callers lose every public row and `search.in(null, …)` is a 400.
  if (access.tier === TIER.SCOPED && partitionField) {
    const scope = access.projectScope;
    // Scoped to nothing must match nothing. Never fall through to the role clause alone, which
    // would hand a project-scoped caller the whole public corpus.
    if (!Array.isArray(scope) || scope.length === 0) return { filter: null, empty: true };
    clauses.push(inClause(partitionField, scope));
  }

  // No clauses means an unscoped privileged caller on a compartment read: unrestricted, and `null`
  // says so explicitly rather than emitting an empty string that a caller might send.
  if (clauses.length === 0) return { filter: null, empty: false };

  return { filter: clauses.join(' and '), empty: false };
}

module.exports = {
  filterFor,
  // The `search.in` builder, shared with the `?docIds=` scope in controllers/search.js so a
  // caller-named id list is escaped by the same code as the ACL's.
  inClause,
  // Exported for tests: escaping is the part worth pinning, since there is no parameter binding.
  quote
};
