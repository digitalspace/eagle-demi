'use strict';

// The Track push. Format: test/controllers/route-inventory.test.js.
module.exports = {
  'POST /track/projects': { action: 'project.push' },
  'PUT /track/projects/:id': { action: 'project.push' },
  'DELETE /track/projects/:id': { action: 'project.delete', in: 'controllers/nosql/project.js' },
  'POST /track/projects/:pid/works': { action: 'project.push' },
  'PUT /track/projects/:pid/works/:id': { action: 'project.push' },
  'DELETE /track/projects/:pid/works/:id': { action: 'project.push' },
  'POST /track/projects/:pid/phases': { action: 'project.push' },
  'PUT /track/projects/:pid/phases/:id': { action: 'project.push' },
  'DELETE /track/projects/:pid/phases/:id': { action: 'project.push' },
  'POST /track/projects/:pid/events': { action: 'project.push' },
  'PUT /track/projects/:pid/events/:id': { action: 'project.push' },
  'DELETE /track/projects/:pid/events/:id': { action: 'project.push' }
};
