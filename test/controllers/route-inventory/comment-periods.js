'use strict';

// Comment period writes. Format: test/controllers/route-inventory.test.js. `roles` are eagle-api's
// x-security-scopes plus sysadmin and staff, which its auth admits on every route (auth.js:35-43).
const IN = 'domain/comment-periods.js';
const ROLES = ['staff', 'sysadmin'];

module.exports = {
  'POST /comment-periods': { action: 'commentPeriod.create', in: IN, roles: ROLES },
  'PUT /comment-periods/:id': { action: 'commentPeriod.update', in: IN, roles: ROLES },
  'DELETE /comment-periods/:id': { action: 'commentPeriod.delete', in: IN, roles: ROLES },
  'PUT /comment-periods/:id/publish': { action: 'commentPeriod.publish', in: IN, roles: ROLES },
  'PUT /comment-periods/:id/unpublish': { action: 'commentPeriod.unpublish', in: IN, roles: ROLES }
};
