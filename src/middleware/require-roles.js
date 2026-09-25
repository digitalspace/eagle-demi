'use strict';

const config = require('../config');
const { canWrite, canAdmin, projectScopeFor } = require('../helpers/access-sql');
const { isRegistryIdentity } = require('../helpers/auth');
const { logger } = require('../utils/logger');

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

/**
 * One named realm role, for a gate narrower than either set above — classifying fields, releasing
 * a sealed record. Mounted behind `authMiddleware` like the other two.
 */
function requireRole(name) {
  return function (req, res, next) {
    const roles = (req.user && req.user.realm_access && req.user.realm_access.roles) || [];

    if (!roles.includes(name)) {
      return res.status(403).json({ error: `Forbidden. Requires role ${name}.` });
    }

    return next();
  };
}

/**
 * The Eagle mirror, PUT /eagle/*. Mounted after `requireWrite`, and narrower than any role: the
 * handlers write through `systemAccess()` into every project, and eagle-api is the only party
 * whose records they hold. `demi-service-write` alone is not enough, because the extractor key
 * holds it and a sysadmin can mint more keys with it. So the caller must be a registry principal
 * named in `config.eagleMirrorPrincipals`, hold `demi-service-write`, and carry no project scope,
 * since a scoped key would still write any project here.
 *
 * The principal is the registry row id helpers/auth.js `identityFor` puts in `keyId`:
 * `apim:<name>` for a caller APIM proved, the hex id for a presented key. It counts only on an
 * identity `identityFor` marked, because a Keycloak token's claims become `req.user` as they are
 * and a token could carry a `keyId` claim. Break-glass has no `keyId`, so it never passes.
 */
function requireEagleMirror(req, res, next) {
  const user = req.user || {};
  const roles = (user.realm_access && user.realm_access.roles) || [];
  const principal = isRegistryIdentity(user) && typeof user.keyId === 'string' ? user.keyId : '';

  const admitted = principal !== '' &&
    config.eagleMirrorPrincipals.includes(principal) &&
    roles.includes('demi-service-write') &&
    projectScopeFor(req) === null;

  if (!admitted) {
    // The route without its query string, and the principal's name only: never a header.
    const route = String(req.originalUrl || '').split('?')[0];
    logger.warn(
      `[demi-api] Eagle mirror refused ${principal || user.preferred_username || 'unknown'} on ${req.method} ${route}`
    );
    return res.status(403).json({ error: 'Forbidden. Only the Eagle mirror writer may call this route.' });
  }

  return next();
}

module.exports = { requireWrite, requireAdmin, requireRole, requireEagleMirror };
