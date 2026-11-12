'use strict';

// Format: test/controllers/route-inventory.test.js. `roles` are eagle-api's x-security-scopes
// plus sysadmin and staff, which its auth admits on every route.
const IN = 'domain/users.js';
const ROLES = ['project-system-admin', 'sysadmin', 'staff'];

module.exports = {
  'POST /users': { action: 'user.create', in: IN, roles: ROLES },
  'PUT /users/:id': { action: 'user.update', in: IN, roles: ROLES }
};
