'use strict';

// Project notification writes. Format: test/controllers/route-inventory.test.js. `roles` are eagle-api's
// x-security-scopes (swagger.yaml:4763,4817), which already name sysadmin and staff; publish and
// unpublish borrow the PUT's.
const IN = 'domain/notifications.js';
const ROLES = ['staff', 'sysadmin'];

module.exports = {
  'POST /notifications': { action: 'notification.create', in: IN, roles: ROLES },
  'PUT /notifications/:id': { action: 'notification.update', in: IN, roles: ROLES },
  'PUT /notifications/:id/publish': { action: 'notification.publish', in: IN, roles: ROLES },
  'PUT /notifications/:id/unpublish': { action: 'notification.unpublish', in: IN, roles: ROLES }
};
