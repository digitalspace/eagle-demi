'use strict';

/**
 * Stub the two rows `helpers/update-parent:readParent` reads: `projects.readByEagleId` and
 * `notifications.readForWrite`. Each takes a value, or a function of the Eagle id.
 */

const projects = require('../../src/repositories/projects');
const notifications = require('../../src/repositories/notifications');

const answer = (value, id) => (typeof value === 'function' ? value(id) : value);

function parentProject(t, project) {
  t.mock.method(projects, 'readByEagleId', async (eagleId) => answer(project, String(eagleId)));
}

function parentNotification(t, notification) {
  t.mock.method(notifications, 'readForWrite', async (id) => answer(notification, id));
}

module.exports = { parentProject, parentNotification };
