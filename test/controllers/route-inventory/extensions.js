'use strict';

// Project extension writes. Format: test/controllers/route-inventory.test.js. `roles` are eagle-api's
// x-security-scopes (swagger.yaml:1933,1964,1995), which already name staff and sysadmin.
const IN = 'domain/extensions.js';
const ROLES = ['staff', 'sysadmin'];

module.exports = {
  'POST /projects/:id/extensions': { action: 'extension.create', in: IN, roles: ROLES },
  'PUT /projects/:id/extensions/:extId': { action: 'extension.update', in: IN, roles: ROLES },
  'DELETE /projects/:id/extensions/:extId': { action: 'extension.delete', in: IN, roles: ROLES }
};
