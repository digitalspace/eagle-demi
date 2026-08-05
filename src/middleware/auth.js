'use strict';

const { authenticate } = require('../helpers/auth');
const { isPrivileged } = require('../helpers/access-sql');

/**
 * Hard auth for privileged routes: the request must carry a valid credential AND that credential
 * must be privileged. Anything else gets a status, not a `next()`.
 *
 * The privilege check lives HERE rather than inside `authenticate()`, which is shared with
 * `passiveAuth`. See the comment in `helpers/auth.js` for what that sharing cost.
 *
 * `isPrivileged` is imported rather than re-listing the role names, so SECURE_ROLES has exactly one
 * definition. The inline list this replaced was a second copy of it, free to drift.
 */
module.exports = (req, res, next) => {
  authenticate(
    req,
    (user) => {
      const roles = (user && user.realm_access && user.realm_access.roles) || [];
      if (!isPrivileged(roles)) {
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
