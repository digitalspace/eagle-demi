'use strict';

const { canWrite } = require('../helpers/access-sql');

/**
 * Write gate, layered ON TOP of authMiddleware — never instead of it.
 *
 * authMiddleware answers "is this caller privileged?", which until now was the only question asked,
 * so every mutating route was reachable by anything that could read privileged data. That made a
 * read-only consumer impossible to express: any credential good enough to list projects was also
 * good enough to delete them.
 *
 * The permitted set is exactly the historical SECURE_ROLES, so this rejects nothing that was
 * previously accepted. It exists so `demi-service-read` can be handed out safely.
 *
 * Order matters: mount as `authMiddleware, requireWrite` — this reads `req.user`, which
 * authMiddleware populates. On its own it would 403 every request.
 */
function requireWrite(req, res, next) {
  const roles = (req.user && req.user.realm_access && req.user.realm_access.roles) || [];

  if (!canWrite(roles)) {
    return res.status(403).json({ error: 'Forbidden. This credential is read-only.' });
  }

  return next();
}

module.exports = { requireWrite };
