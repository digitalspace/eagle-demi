'use strict';

/**
 * `Organization` rows (`kind: 'Organization'` in the `lists` container): reads on the contract in
 * helpers/native-query.js, writes through domain/organizations.js. The staff-side fields sit at
 * level 2 in catalog/lists.js, so the shared redactor withholds them.
 */

const lists = require('../../repositories/lists');
const organization = require('../../domain/organizations');
const { listHandler, getHandler } = require('../nosql/mirror-reads');
const { writeHandler } = require('./write');

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

const WRITES = { entity: lists.CONTAINER };

module.exports = {
  SPEC,
  getOrganizations: listHandler(SPEC),
  getOrganization: getHandler(SPEC),
  createOrganization: writeHandler(organization.create, WRITES),
  updateOrganization: writeHandler(organization.update, WRITES),
  publishOrganization: writeHandler(organization.publish, WRITES),
  unpublishOrganization: writeHandler(organization.unpublish, WRITES)
};
