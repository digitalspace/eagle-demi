'use strict';

// Organization writes. Format: test/controllers/route-inventory.test.js. `roles` are eagle-api's
// x-security-scopes plus sysadmin and staff, which its auth admits on every route (auth.js:35-43).
// Publish and unpublish drop eagle-api's project-system-admin scope: the choice stays with staff
// (docs/eagle-api-port.md, Organizations).
const IN = 'domain/organizations.js';
const STAFF = ['staff', 'sysadmin'];

module.exports = {
  'POST /organizations': { action: 'organization.create', in: IN, roles: STAFF },
  'PUT /organizations/:id': {
    action: 'organization.update', in: IN, roles: ['project-system-admin', 'sysadmin', 'staff']
  },
  'PUT /organizations/:id/publish': { action: 'organization.publish', in: IN, roles: STAFF },
  'PUT /organizations/:id/unpublish': { action: 'organization.unpublish', in: IN, roles: STAFF }
};
