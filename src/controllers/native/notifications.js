'use strict';

/**
 * `GET /notifications` and `/notifications/:id`. A notification has no project axis, so role ACL
 * alone decides which rows a caller sees.
 */

const notifications = require('../../repositories/notifications');
const { listHandler, getHandler } = require('../nosql/mirror-reads');
const { indexedKind, INDEX_MAPS } = require('../../search/native-index');

const SPEC = Object.freeze({
  entity: 'notifications',
  repository: indexedKind({ index: 'project-notifications', store: notifications.nativeRepository }),
  sortKeys: notifications.SORTABLE,
  filters: Object.values(notifications.FILTERS),
  multiValueFilters: ['type', 'region', 'decision'],
  qFields: INDEX_MAPS['project-notifications'].searched,
  notFound: 'Notification not found'
});

exports.SPEC = SPEC;
exports.getNotifications = listHandler(SPEC);
exports.getNotification = getHandler(SPEC);
