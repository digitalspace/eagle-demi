'use strict';

/**
 * Stub the stored parents `helpers/update-parent:readParent` reads, both unfiltered: the project row
 * by Eagle id (a `projects` queryFirst) and the notification row (`notifications.readForWrite`).
 * Each takes a value, or a function of the Eagle id. Any other queryFirst goes to the real one.
 */

const cosmos = require('../../src/db/cosmos-nosql');
const projects = require('../../src/repositories/projects');
const notifications = require('../../src/repositories/notifications');

const answer = (value, id) => (typeof value === 'function' ? value(id) : value);

function parentProject(t, project) {
  const original = cosmos.queryFirst;
  t.mock.method(cosmos, 'queryFirst', async (container, spec, options) => {
    if (container !== projects.CONTAINER) return original(container, spec, options);
    const param = spec.parameters.find(p => p.name === '@eagleId');
    return answer(project, param && param.value);
  });
}

function parentNotification(t, notification) {
  t.mock.method(notifications, 'readForWrite', async (id) => answer(notification, id));
}

module.exports = { parentProject, parentNotification };
