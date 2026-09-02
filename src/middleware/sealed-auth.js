'use strict';

const { authenticate } = require('../helpers/auth');

/**
 * Auth for the sealed compartment, and deliberately NOT `middleware/auth.js`: that gate demands
 * AUTHENTICATED_ROLES, which excludes `compliance` on purpose, so mounting it here would 403 the
 * compartment's only caller. Verification only — `requireRole('compliance')` beside it decides who
 * gets in (docs/rbac-architecture.md §1, "Level 0").
 */
module.exports = (req, res, next) => {
  authenticate(
    req,
    (user) => { req.user = user; return next(); },
    (status, error) => res.status(status).json({ error })
  );
};
