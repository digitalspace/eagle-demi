'use strict';

// Project group writes. Format: test/controllers/route-inventory.test.js. `roles` are eagle-api's
// x-security-scopes (swagger.yaml:1878,2054,2086,2151,2268), which already name sysadmin and staff.
const IN = 'domain/groups.js';
const ROLES = ['project-system-admin', 'sysadmin', 'staff'];

module.exports = {
  'POST /groups': { action: 'group.create', in: IN, roles: ROLES },
  'PUT /groups/:id': { action: 'group.update', in: IN, roles: ROLES },
  'DELETE /groups/:id': { action: 'group.delete', in: IN, roles: ROLES },
  'POST /groups/:id/members': { action: 'group.addMembers', in: IN, roles: ROLES },
  'DELETE /groups/:id/members/:userId': { action: 'group.removeMember', in: IN, roles: ROLES }
};
