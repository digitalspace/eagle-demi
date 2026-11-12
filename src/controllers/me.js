'use strict';

/**
 * Tells a caller what it can see. Mounted behind passiveAuthMiddleware (src/http/routes.js), so an
 * anonymous caller gets 200 with the public tier rather than a 401.
 */

const { resolveAccess, isPrivileged, isAuthenticatedRole } = require('../helpers/access-sql');

exports.getMe = (req, res) => {
  const access = resolveAccess(req);
  // Not derivable from `tier`: a `projectScope` key is tier `scoped` whatever its roles. False for
  // `staff`.
  res.json({
    roles: access.roles,
    level: access.level,
    tier: access.tier,
    privileged: isPrivileged(access.roles),
    // The frontend's staff gate: `staff` and `compliance` share level and tier. Same predicate
    // authMiddleware 403s on, so the UI matches what the API serves.
    staffUi: isAuthenticatedRole(access.roles),
    // The holder's only view of its own `end`. Already window-filtered by middleware/credentials.js,
    // so revoked or expired grants are absent.
    credentials: access.credentials.map(c => ({
      id: c.id, scope: c.scope, levels: c.levels, end: c.end
    }))
  });
};
