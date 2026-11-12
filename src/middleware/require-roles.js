'use strict';

const config = require('../config');
const { canWrite, canAdmin, projectScopeFor } = require('../helpers/access-sql');
const { isRegistryIdentity } = require('../helpers/auth');
const { logger } = require('../utils/logger');

// Mount after authMiddleware, which sets req.user; alone these refuse every request. requireWrite
// guards app data, requireAdmin guards /admin/*, so demi-service-write can write but not mint keys.
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

// Any one listed role admits. The list sits on the guard as `roles` so a test can compare it with
// the eagle-api `x-security-scopes` the route was ported from.
function requireRole(...names) {
  if (names.length === 0) throw new TypeError('requireRole needs at least one role name');
  const refusal = names.length === 1
    ? `Forbidden. Requires role ${names[0]}.`
    : `Forbidden. Requires one of the roles ${names.join(', ')}.`;

  const guard = function (req, res, next) {
    const roles = (req.user && req.user.realm_access && req.user.realm_access.roles) || [];

    if (!names.some(name => roles.includes(name))) {
      return res.status(403).json({ error: refusal });
    }

    return next();
  };
  guard.roles = Object.freeze([...names]);
  return guard;
}

// These routes write every project via systemAccess(), so a role or a scoped key is too wide.
// keyId counts only on an identity identityFor marked: a Keycloak token could carry that claim.
function namedWriter(principalsOf, label) {
  return function (req, res, next) {
    const user = req.user || {};
    const roles = (user.realm_access && user.realm_access.roles) || [];
    const principal = isRegistryIdentity(user) && typeof user.keyId === 'string' ? user.keyId : '';

    const admitted = principal !== '' &&
      principalsOf().includes(principal) &&
      roles.includes('demi-service-write') &&
      projectScopeFor(req) === null;

    if (!admitted) {
      // The route without its query string, and the principal's name only: never a header.
      const route = String(req.originalUrl || '').split('?')[0];
      logger.warn(
        `[demi-api] ${label} refused ${principal || user.preferred_username || 'unknown'} on ${req.method} ${route}`
      );
      return res.status(403).json({ error: `Forbidden. Only the ${label} writer may call this route.` });
    }

    return next();
  };
}

const requireEagleMirror = namedWriter(() => config.eagleMirrorPrincipals, 'Eagle mirror');

const requireEngageWriter = namedWriter(() => config.engagePrincipals, 'ENGAGE');

const requireTrackWriter = namedWriter(() => config.trackPrincipals, 'Track');

// PDF title routes read every row unfiltered and hand out links that write stored originals.
const requirePdfTitleWorker = namedWriter(() => config.pdfTitleWorkerPrincipals, 'PDF title worker');

module.exports = { requireWrite, requireAdmin, requireRole, requireEagleMirror, requireEngageWriter, requireTrackWriter, requirePdfTitleWorker };
