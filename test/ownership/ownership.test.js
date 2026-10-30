'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const project = require('../../src/ownership/project');
const document = require('../../src/ownership/document');
const organization = require('../../src/ownership/organization');

/** Every field named by more than one owner, with the owners that name it. */
function sharedFields(owners) {
  const byField = new Map();
  for (const [owner, fields] of Object.entries(owners)) {
    for (const field of new Set(fields)) byField.set(field, [...(byField.get(field) || []), owner]);
  }
  return [...byField].filter(([, names]) => names.length > 1).map(([field, names]) => `${field}: ${names.join(', ')}`);
}

const ENTITIES = { project, document, organization };

for (const [entity, { OWNERS }] of Object.entries(ENTITIES)) {
  test(`${entity}: no field has two owners`, () => {
    assert.deepStrictEqual(sharedFields(OWNERS), []);
  });

  test(`${entity}: no owner lists a field twice`, () => {
    for (const [owner, fields] of Object.entries(OWNERS)) {
      assert.deepStrictEqual(fields.filter((f, i) => fields.indexOf(f) !== i), [], owner);
    }
  });
}

test('sharedFields names a field two owners claim', () => {
  assert.deepStrictEqual(sharedFields({ eagle: ['pins', 'region'], demi: ['tags', 'pins'] }), ['pins: eagle, demi']);
});

test('project: no owner list names a legislation block, which Eagle owns by pattern', () => {
  const named = Object.values(project.OWNERS).flat().filter(f => project.LEGISLATION_KEY.test(f));
  assert.deepStrictEqual(named, []);
});

test('project: every push-only field has an owner', () => {
  const owned = new Set(Object.values(project.OWNERS).flat());
  assert.deepStrictEqual(project.PUSH_ONLY_FIELDS.filter(f => !owned.has(f)), []);
});

test('project: PUT never takes a field the Eagle push owns as bookkeeping', () => {
  for (const field of project.OWNERS.push) assert.ok(project.PUT_IGNORED_FIELDS.includes(field), field);
});
