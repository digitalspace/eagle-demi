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
  sortKeys: ['name'],
  filters: ['companyType'],
  multiValueFilters: ['companyType'],
  qFields: ['name'],
  notFound: 'Organization not found'
});

module.exports = {
  SPEC,
  getOrganizations: listHandler(SPEC),
  getOrganization: getHandler(SPEC),
  createOrganization: writeHandler(organization.create, { entity: lists.CONTAINER }),
  updateOrganization: writeHandler(organization.update, { entity: lists.CONTAINER })
};
