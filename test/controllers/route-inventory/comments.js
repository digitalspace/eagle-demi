'use strict';

// Comment writes. Format: test/controllers/route-inventory.test.js. `roles` are eagle-api's
// x-security-scopes plus sysadmin and staff, which its auth admits on every route (auth.js:35-43).
const IN = 'domain/comments.js';
const ROLES = ['staff', 'sysadmin'];

module.exports = {
  'POST /comments': { action: 'comment.create', in: IN, roles: ROLES },
  'PUT /comments/:id': { action: 'comment.update', in: IN, roles: ROLES },
  'PUT /comments/:id/status': { action: 'comment.setStatus', in: IN, roles: ROLES }
};
