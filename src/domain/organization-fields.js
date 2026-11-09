'use strict';

const SHORT = { type: 'string', max: 1000 };

/** The fields eagle-api's POST copies from the body (organization.js:92-113). None is required. */
const SCHEMA = Object.freeze({
  name: SHORT,
  description: { type: 'string', max: 10000 },
  country: SHORT,
  postal: SHORT,
  province: SHORT,
  city: SHORT,
  address1: SHORT,
  address2: SHORT,
  companyType: SHORT,
  companyLegal: SHORT,
  company: SHORT,
  parentCompany: { type: 'id', nullable: true }
});

module.exports = { SCHEMA };
