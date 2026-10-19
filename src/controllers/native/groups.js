'use strict';

/**
 * `GET /groups/:id/members`: the group's members through the users read (`controllers/nosql/user.js`),
 * so they are sorted, paged, counted, redacted and audited as `GET /users` is.
 */

const groups = require('../../repositories/groups');
const { withCriteria, inList } = require('../../repositories/_sql');
const { resolveAccess } = require('../../helpers/access-sql');
const { serverError } = require('../../helpers/response');
const { listHandler } = require('../nosql/mirror-reads');
const users = require('../nosql/user');

exports.getGroupMembers = async (req, res) => {
  try {
    const group = await groups.native.getById(resolveAccess(req), req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const members = Array.isArray(group.members) ? group.members.map(String) : [];
    // An empty list renders `false`, so a group with no members answers an empty page.
    const repository = withCriteria(users.nativeSpec.repository, [inList('id', members, '@member')]);
    return listHandler({ ...users.nativeSpec, repository })(req, res);
  } catch (err) {
    return serverError(res, err, 'group members read failed');
  }
};
