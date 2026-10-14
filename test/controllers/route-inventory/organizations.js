'use strict';

// Organization writes. Format: test/controllers/route-inventory.test.js. `roles` are eagle-api's
// x-security-scopes plus sysadmin and staff, which its auth admits on every route (auth.js:35-43).
module.exports = {
  'POST /organizations': { action: 'organization.create', in: 'domain/organizations.js', roles: ['staff', 'sysadmin'] },
  'PUT /organizations/:id': {
    action: 'organization.update', in: 'domain/organizations.js', roles: ['project-system-admin', 'sysadmin', 'staff']
  }
};
