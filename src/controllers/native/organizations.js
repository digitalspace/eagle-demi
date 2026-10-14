'use strict';

/**
 * Native reads of Eagle `Organization` rows (`kind: 'Organization'` in the `lists` container):
 * `GET /organizations` and `GET /organizations/:id`, on the contract in helpers/native-query.js.
 * The staff-side fields sit at level 2 in catalog/lists.js, so the shared redactor withholds them.
 */

const lists = require('../../repositories/lists');
const { listHandler, getHandler } = require('../nosql/mirror-reads');

const SPEC = Object.freeze({
  entity: lists.CONTAINER,
  repository: lists.nativeKind(lists.KINDS.ORGANIZATION),
  sortKeys: ['name'],
  filters: ['companyType'],
  multiValueFilters: ['companyType'],
  qFields: ['name'],
  notFound: 'Organization not found'
});

module.exports = {
  SPEC,
  getOrganizations: listHandler(SPEC),
  getOrganization: getHandler(SPEC)
};
