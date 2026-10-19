'use strict';

/**
 * Project notification writes through domain/notifications.js. Apart from the reads in
 * notifications.js, which answer through `mirror-reads` and import no `domain/`.
 */

const notifications = require('../../repositories/notifications');
const notification = require('../../domain/notifications');
const { writeHandler } = require('./write');

const WRITES = { entity: notifications.CONTAINER };

module.exports = {
  createNotification: writeHandler(notification.create, WRITES),
  updateNotification: writeHandler(notification.update, WRITES),
  publishNotification: writeHandler(notification.publish, WRITES),
  unpublishNotification: writeHandler(notification.unpublish, WRITES)
};
