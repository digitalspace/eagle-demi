'use strict';

/**
 * User writes through domain/users.js. The reads stay with the Eagle mirror in
 * controllers/nosql/user.js.
 */

const users = require('../../repositories/users');
const user = require('../../domain/users');
const { writeHandler } = require('./write');

const WRITES = { entity: users.CONTAINER };

module.exports = {
  createUser: writeHandler(user.create, WRITES),
  updateUser: writeHandler(user.update, WRITES)
};
