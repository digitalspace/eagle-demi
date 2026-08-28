'use strict';

const { authenticate } = require('../helpers/auth');
const { isAuthenticatedRole } = require('../helpers/access-sql');

/**
 * Hard auth for the authenticated routes: the request must carry a valid credential AND that
 * credential must hold a session role. Anything else gets a status, not a `next()`.
 *
 * Gated on AUTHENTICATED_ROLES, not on `isPrivileged`. Row-plane privilege is a different question
 * — `staff` is not privileged and still administers and writes exactly as before — and gating a
 * session on the short-circuit set would lock it out of every route this middleware fronts.
 * `compliance` is not in the set: see AUTHENTICATED_ROLES.
 *
 * The check lives HERE rather than inside `authenticate()`, which is shared with `passiveAuth`.
 * See the comment in `helpers/auth.js` for what that sharing cost.
 */
module.exports = (req, res, next) => {
  authenticate(
    req,
    (user) => {
      const roles = (user && user.realm_access && user.realm_access.roles) || [];
      if (!isAuthenticatedRole(roles)) {
        return res
          .status(403)
          .json({ error: 'Forbidden. User does not possess admin or staff permissions.' });
      }
      req.user = user;
      return next();
    },
    (status, error) => {
      return res.status(status).json({ error });
    }
  );
};
