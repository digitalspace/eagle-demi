'use strict';

/**
 * Project group writes through domain/groups.js. Apart from the members read in groups.js because
 * that one answers `res` itself, which a controller importing `domain/` may not.
 */

const groups = require('../../repositories/groups');
const group = require('../../domain/groups');
const { writeHandler } = require('./write');

const WRITES = { entity: groups.CONTAINER };

module.exports = {
  createGroup: writeHandler(group.create, WRITES),
  updateGroup: writeHandler(group.update, WRITES),
  deleteGroup: writeHandler(group.remove, WRITES),
  addGroupMembers: writeHandler(group.addMembers, WRITES),
  // writeHandler passes `:id` only; the member comes from the second path parameter.
  removeGroupMember: writeHandler((ctx, id) => group.removeMember(ctx, id, ctx.req.params.userId), WRITES)
};
