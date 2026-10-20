'use strict';

/**
 * Project extensions and suspensions through domain/extensions.js. Both answer the project's two
 * lists, redacted as a project, so a per-project dial that hides a list hides it here too.
 */

const projects = require('../../repositories/projects');
const extension = require('../../domain/extensions');
const { getHandler, NO_STORE } = require('../nosql/mirror-reads');
const { writeHandler } = require('./write');

const WRITES = { entity: projects.CONTAINER, shape: extension.bodyOf };
const read = getHandler(projects.CONTAINER, 'Project not found', extension.list, extension.bodyOf);

module.exports = {
  // Staff-only, and a project may be unpublished: no shared cache may keep the answer.
  getExtensions: (req, res) => {
    res.setHeader('cache-control', NO_STORE);
    return read(req, res);
  },
  createExtension: writeHandler(extension.create, WRITES),
  // writeHandler passes `:id` only; the item comes from the second path parameter.
  updateExtension: writeHandler((ctx, id, body) => extension.update(ctx, id, ctx.req.params.extId, body), WRITES),
  deleteExtension: writeHandler((ctx, id) => extension.remove(ctx, id, ctx.req.params.extId), WRITES)
};
