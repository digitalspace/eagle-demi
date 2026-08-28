'use strict';

/**
 * Tells a caller what it can see, without reading Cosmos. Mounted behind passiveAuthMiddleware
 * (src/routes/api.js), so an anonymous caller gets 200 with the public tier rather than a 401.
 */

const { resolveAccess, isPrivileged } = require('../helpers/access-sql');

exports.getMe = (req, res) => {
  const access = resolveAccess(req);
  // `privileged` is answered here rather than derived from `tier` by the caller: a staff key
  // carrying `project:207` resolves to tier `scoped`, and every client that re-derived privilege
  // from the tier string would call that staffer unauthorized.
  res.json({
    roles: access.roles,
    level: access.level,
    tier: access.tier,
    privileged: isPrivileged(access.roles)
  });
};
