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
  // companyLegal stays out of lists.SORTABLE: that also feeds /search?dataset=Organization, which
  // has no per-field check, and companyLegal is staff-only. Here parseNativeQuery checks the catalog.
  sortKeys: [...lists.SORTABLE[lists.KINDS.ORGANIZATION], 'companyLegal'],
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
