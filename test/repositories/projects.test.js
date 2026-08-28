'use strict';

/**
 * The project list's own filter keys, held against the field catalog.
 *
 * `buildCriteria` REJECTS a field the caller cannot see rather than dropping it, so every key it
 * knows has to be classified — an uncatalogued one would throw for every caller, level 0 included.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const projectsRepo = require('../../src/repositories/projects');
const catalog = require('../../src/vis/catalog/projects');

test('buildCriteria keys are all catalogued', () => {
  const fields = Object.keys(projectsRepo.CRITERIA_FIELDS);
  assert.deepStrictEqual(fields, ['regionalDistrict', 'municipality', 'electoralDistrict']);

  for (const field of fields) {
    assert.ok(catalog[field], `buildCriteria filters on '${field}', which has no catalog entry`);
  }
});
