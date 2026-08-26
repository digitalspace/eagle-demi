'use strict';

const { canWrite, canAdmin } = require('../helpers/access-sql');

/**
 * Two gates, both layered ON TOP of authMiddleware — never instead of it.
 *
 * authMiddleware answers "is this caller privileged?", which was once the only question asked, so
 * every mutating route was reachable by anything that could read privileged data. That made a
 * read-only consumer impossible to express: any credential good enough to list projects was also
 * good enough to delete them.
 *
 * `requireWrite` guards APPLICATION DATA — projects, documents, chunks, boundaries, the Eagle
 * mirror. `requireAdmin` guards the SERVICE ITSELF — `/admin/*`, where keys are minted and
 * operator syncs are run. The split is what lets `demi-service-write` exist: eagle-api's push
 * writes the mirror without being able to mint itself a wider credential.
 *
 * Neither refuses anything that was accepted before them: `requireWrite` permits ADMIN_ROLES plus
 * the service writer, `requireAdmin` permits exactly ADMIN_ROLES.
 *
 * Order matters: mount as `authMiddleware, requireWrite` — these read `req.user`, which
 * authMiddleware populates. On their own they would 403 every request.
 */
function requireWrite(req, res, next) {
  const roles = (req.user && req.user.realm_access && req.user.realm_access.roles) || [];

  if (!canWrite(roles)) {
    return res.status(403).json({ error: 'Forbidden. This credential is read-only.' });
  }

  return next();
}

function requireAdmin(req, res, next) {
  const roles = (req.user && req.user.realm_access && req.user.realm_access.roles) || [];

  if (!canAdmin(roles)) {
    return res.status(403).json({ error: 'Forbidden. This credential cannot administer DEMI.' });
  }

  return next();
}

module.exports = { requireWrite, requireAdmin };
