'use strict';

/**
 * Update writes through domain/updates.js. Apart from the reads in updates.js because those
 * answer `res` themselves, which a controller importing `domain/` may not.
 */

const updates = require('../../repositories/updates');
const update = require('../../domain/updates');
const { writeHandler } = require('./write');

const WRITES = { entity: updates.CONTAINER };

module.exports = {
  createUpdate: writeHandler(update.create, WRITES),
  updateUpdate: writeHandler(update.update, WRITES),
  archiveUpdate: writeHandler(update.remove, WRITES)
};
