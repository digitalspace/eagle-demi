'use strict';

const { resolveAccess } = require('../../src/helpers/access-sql');

/** A domain call's `ctx` for a signed-in user holding `roles`. */
function ctxFor(roles, username = 'idir-staff') {
  const req = { user: { sub: 'kc-1', preferred_username: username, realm_access: { roles } }, headers: {} };
  return { access: resolveAccess(req), req };
}

module.exports = { ctxFor };
