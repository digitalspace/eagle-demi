'use strict';

// Update writes. Format: test/controllers/route-inventory.test.js. `roles` are eagle-api's
// x-security-scopes plus sysadmin and staff, which its auth admits on every route (auth.js:35-43).
const IN = 'domain/updates.js';
const ROLES = ['project-system-admin', 'sysadmin', 'staff'];

module.exports = {
  'POST /updates': { action: 'update.create', in: IN, roles: ROLES },
  'PUT /updates/:id': { action: 'update.update', in: IN, roles: ROLES },
  'DELETE /updates/:id': { action: 'update.archive', in: IN, roles: ROLES }
};
