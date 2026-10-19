'use strict';

// Organization writes. Format: test/controllers/route-inventory.test.js. `roles` are eagle-api's
// x-security-scopes plus sysadmin and staff, which its auth admits on every route (auth.js:35-43).
const IN = 'domain/organizations.js';
const ORG_ADMIN = ['project-system-admin', 'sysadmin', 'staff'];

module.exports = {
  'POST /organizations': { action: 'organization.create', in: IN, roles: ['staff', 'sysadmin'] },
  'PUT /organizations/:id': { action: 'organization.update', in: IN, roles: ORG_ADMIN },
  'PUT /organizations/:id/publish': { action: 'organization.publish', in: IN, roles: ORG_ADMIN },
  'PUT /organizations/:id/unpublish': { action: 'organization.unpublish', in: IN, roles: ORG_ADMIN }
};
