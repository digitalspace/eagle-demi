'use strict';

/**
 * Tells a caller what it can see, without reading Cosmos. Mounted behind passiveAuthMiddleware
 * (src/routes/api.js), so an anonymous caller gets 200 with the public tier rather than a 401.
 */

const { resolveAccess, isPrivileged } = require('../helpers/access-sql');

exports.getMe = (req, res) => {
  const access = resolveAccess(req);
  // `privileged` is answered here rather than derived from `tier` by the caller: a key minted with
  // a `projectScope` resolves to tier `scoped` whatever its roles, and a client re-deriving
  // privilege from the tier string would call that caller unauthorized. It is false for `staff`.
  res.json({
    roles: access.roles,
    level: access.level,
    tier: access.tier,
    privileged: isPrivileged(access.roles)
  });
};
