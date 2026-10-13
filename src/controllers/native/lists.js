'use strict';

/**
 * Native reads of Eagle `List` lookup rows (`kind: 'List'` in the `lists` container):
 * `GET /lists` and `GET /lists/:id`, on the contract in helpers/native-query.js.
 */

const lists = require('../../repositories/lists');
const { listHandler, getHandler } = require('../nosql/mirror-reads');

const SPEC = Object.freeze({
  entity: lists.CONTAINER,
  repository: lists.nativeKind(lists.KINDS.LIST),
  sortKeys: ['name'],
  filters: ['type'],
  multiValueFilters: [],
  qFields: ['name'],
  notFound: 'List not found'
});

module.exports = {
  SPEC,
  getLists: listHandler(SPEC),
  getList: getHandler(SPEC)
};
