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

const cosmos = require('../../src/db/cosmos-nosql');
const projectsRepo = require('../../src/repositories/projects');
const catalog = require('../../src/vis/catalog/projects');

test('buildCriteria keys are all catalogued', () => {
  const fields = Object.keys(projectsRepo.CRITERIA_FIELDS);
  assert.deepStrictEqual(fields, ['regionalDistrict', 'municipality', 'electoralDistrict']);

  for (const field of fields) {
    assert.ok(catalog[field], `buildCriteria filters on '${field}', which has no catalog entry`);
  }
});

test('project short-code reads and writes', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('an owner is a project holding the code as current or legacy', async () => {
    let spec;
    t.mock.method(cosmos, 'query', async (_container, s) => { spec = s; return { items: [{ id: 207 }] }; });

    assert.deepStrictEqual(await projectsRepo.listShortCodeOwners('site-c'), ['207']);
    assert.match(spec.query, /c\.shortCode = @code OR ARRAY_CONTAINS\(c\.legacyShortCodes, @code\)/);
    assert.deepStrictEqual(spec.parameters, [{ name: '@code', value: 'site-c' }]);
  });

  await t.test('the patch sets only the three short-link fields, guarded on the etag', async () => {
    let call;
    t.mock.method(cosmos, 'patch', async (...args) => { call = args; return {}; });

    await projectsRepo.patchShortLink('eagle-1',
      { shortCode: 'site-c', shortCodeSource: 'name', legacyShortCodes: ['kq7bt2rm'], name: 'x' }, '"0x1"');

    assert.deepStrictEqual(call[3].map(op => op.path),
      ['/shortCode', '/shortCodeSource', '/legacyShortCodes']);
    assert.strictEqual(call[5], '"0x1"');
  });
});
