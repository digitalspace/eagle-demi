'use strict';

// Project CAC writes. Format: test/controllers/route-inventory.test.js. `roles` are eagle-api's
// x-security-scopes at b072e79^ (swagger.yaml:1795,1844,2941,2972,2998), which name staff and sysadmin.
const IN = 'domain/cac.js';
const ROLES = ['staff', 'sysadmin'];

module.exports = {
  'POST /projects/:id/cac': { action: 'cac.create', in: IN, roles: ROLES },
  'DELETE /projects/:id/cac': { action: 'cac.delete', in: IN, roles: ROLES },
  'PUT /projects/:id/cac/publish': { action: 'cac.publish', in: IN, roles: ROLES },
  'PUT /projects/:id/cac/unpublish': { action: 'cac.unpublish', in: IN, roles: ROLES },
  'POST /projects/:id/cac/members/remove': { action: 'cac.member.remove', in: IN, roles: ROLES }
};
