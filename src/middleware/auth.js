'use strict';

const { authenticate } = require('../helpers/auth');
const { isAuthenticatedRole } = require('../helpers/access-sql');

/**
 * Hard auth for the authenticated routes: valid credential AND a session role (AUTHENTICATED_ROLES,
 * not row-plane `isPrivileged`) — else a status, not `next()`.
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
