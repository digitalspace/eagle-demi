'use strict';

/**
 * Native project notification reads: `GET /notifications` and `GET /notifications/:id`, on the list
 * contract in `helpers/native-query.js`. A notification has no project axis
 * (`repositories/notifications.js`), so role ACL alone decides which rows a caller sees.
 */

const notifications = require('../../repositories/notifications');
const { listHandler, getHandler } = require('../nosql/mirror-reads');
const { indexedKind, INDEX_MAPS } = require('../../search/native-index');

const SPEC = Object.freeze({
  entity: 'notifications',
  repository: indexedKind({ index: 'project-notifications', store: notifications.nativeRepository }),
  sortKeys: notifications.SORTABLE,
  filters: Object.values(notifications.FILTERS),
  multiValueFilters: [],
  qFields: INDEX_MAPS['project-notifications'].searched,
  notFound: 'Notification not found'
});

exports.SPEC = SPEC;
exports.getNotifications = listHandler(SPEC);
exports.getNotification = getHandler(SPEC);
