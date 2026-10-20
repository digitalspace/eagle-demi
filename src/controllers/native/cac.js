'use strict';

/**
 * A project's CAC through domain/cac.js. Every answer is the project's CAC fields, redacted as a
 * project, so a per-project dial that hides a field hides it here too.
 */

const projects = require('../../repositories/projects');
const cac = require('../../domain/cac');
const { getHandler, NO_STORE } = require('../nosql/mirror-reads');
const { writeHandler } = require('./write');

const WRITES = { entity: projects.CONTAINER };
const read = getHandler(projects.CONTAINER, 'Project not found', cac.get);

module.exports = {
  // Staff-only, and a project may be unpublished: no shared cache may keep the answer.
  getCac: (req, res) => {
    res.setHeader('cache-control', NO_STORE);
    return read(req, res);
  },
  createCac: writeHandler(cac.create, WRITES),
  deleteCac: writeHandler((ctx, id) => cac.remove(ctx, id), WRITES),
  publishCac: writeHandler((ctx, id) => cac.publish(ctx, id), WRITES),
  unpublishCac: writeHandler((ctx, id) => cac.unpublish(ctx, id), WRITES),
  removeCacMember: writeHandler(cac.removeMember, WRITES)
};
