'use strict';

/**
 * Tells a caller what it can see. Mounted behind passiveAuthMiddleware (src/http/routes.js), so an
 * anonymous caller gets 200 with the public tier rather than a 401.
 */

const { resolveAccess, isPrivileged, isAuthenticatedRole } = require('../helpers/access-sql');

exports.getMe = (req, res) => {
  const access = resolveAccess(req);
  // `privileged` is answered here rather than derived from `tier` by the caller: a key minted with
  // a `projectScope` resolves to tier `scoped` whatever its roles, and a client re-deriving
  // privilege from the tier string would call that caller unauthorized. It is false for `staff`.
  res.json({
    roles: access.roles,
    level: access.level,
    tier: access.tier,
    privileged: isPrivileged(access.roles),
    // The frontend's staff gate. `level`/`tier` cannot answer it: a `staff` caller is level 2 and
    // tier `public`, exactly like a `compliance` one. This is the same predicate authMiddleware
    // 403s on, so the UI shows what the API will actually serve.
    staffUi: isAuthenticatedRole(access.roles),
    // How the holder sees its own expiry: `end` is nowhere else in the API for them, and the
    // grantor's own view of it is GET /api/credentials. Already window-filtered by
    // middleware/credentials.js, so a revoked or expired grant is simply absent.
    credentials: access.credentials.map(c => ({
      id: c.id, scope: c.scope, levels: c.levels, end: c.end
    }))
  });
};
