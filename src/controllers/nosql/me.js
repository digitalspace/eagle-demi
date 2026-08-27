'use strict';

/**
 * Tells a caller what it can see, without reading Cosmos. Mounted behind passiveAuthMiddleware
 * (src/routes/api.js), so an anonymous caller gets 200 with the public tier rather than a 401.
 */

const { resolveAccess } = require('../../helpers/access-sql');

exports.getMe = (req, res) => {
  const access = resolveAccess(req);
  res.json({ roles: access.roles, level: access.level, tier: access.tier });
};
