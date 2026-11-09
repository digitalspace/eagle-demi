'use strict';

// The Track push. Format: test/controllers/route-inventory.test.js.
module.exports = {
  'PUT /track/projects/:id': { action: 'project.push' },
  'DELETE /track/projects/:id': { action: 'project.delete', in: 'controllers/nosql/project.js' }
};
