'use strict';

// User writes. Format: test/controllers/route-inventory.test.js. `roles` are eagle-api's
// x-security-scopes (swagger.yaml:4613,4661) plus sysadmin and staff, which its auth admits on
// every route (auth.js:35-43).
const IN = 'domain/users.js';
const ROLES = ['project-system-admin', 'sysadmin', 'staff'];

module.exports = {
  'POST /users': { action: 'user.create', in: IN, roles: ROLES },
  'PUT /users/:id': { action: 'user.update', in: IN, roles: ROLES }
};
