'use strict';

const SHORT = { type: 'string', max: 1000, nullable: true };
const LONG = { type: 'string', max: 10000, nullable: true };
const DATE = { type: 'isoDate', nullable: true };

/** The fields eagle-api's PUT maps from the body (projectNotification.js:114-135). None is required. */
const SCHEMA = Object.freeze({
  name: SHORT,
  type: SHORT,
  subType: SHORT,
  proponent: SHORT,
  nature: SHORT,
  region: SHORT,
  location: LONG,
  trigger: LONG,
  decision: SHORT,
  decisionDate: DATE,
  notificationReceivedDate: DATE,
  description: LONG,
  notificationThresholdUnits: SHORT,
  associatedProjectId: { type: 'string', max: 200, nullable: true },
  associatedProjectName: SHORT,
  dateStarted: DATE,
  dateCompleted: DATE,
  pcp: { type: 'string', max: 200, nullable: true },
  isMet: { type: 'boolean', nullable: true },
  metURL: { type: 'string', max: 2000, nullable: true }
});

/** Fields `_schema.js` has no type for, checked here: a Number and a Mixed array in the model. */
const NUMBER_FIELDS = Object.freeze({
  notificationThresholdValue: (value) => value === null || Number.isFinite(value) ? null : 'must be a number',
  // eagle-admin sends [latitude, longitude] from two text inputs, so numbers or numeric strings.
  centroid: (value) => value === null || (Array.isArray(value) && value.length <= 2 &&
    value.every(v => Number.isFinite(v) || (typeof v === 'string' && v.length <= 50)))
    ? null : 'must be an array of at most 2 numbers or strings'
});

const FIELDS = [...Object.keys(SCHEMA), ...Object.keys(NUMBER_FIELDS)];

/**
 * What a field sent empty in a PUT becomes, as the Eagle push maps it. create and update override
 * the null `notificationReceivedDate`: Cosmos cannot continue a page sorted on a null value.
 */
const DEFAULTS = Object.freeze({
  ...Object.fromEntries(FIELDS.map(key => [key, null])),
  centroid: [],
  pcp: 'none',
  isMet: false,
  metURL: ''
});

module.exports = { SCHEMA, NUMBER_FIELDS, FIELDS, DEFAULTS };
