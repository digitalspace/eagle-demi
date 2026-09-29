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
    assert.doesNotMatch(spec.query, /c\.read/, 'an ownership check applies no visibility clause');
  });

  const stored = [
    { id: '310', read: ['compliance'], shortCode: 'sealed-site', legacyShortCodes: [] },
    { id: '312', shortCode: 'readless-site', legacyShortCodes: [] },
    { id: '311', read: ['public'], shortCode: 'other', legacyShortCodes: [] }
  ];
  /**
   * Cosmos as the ACL predicate would see it: a seal exclusion in the query hides a sealed row, and
   * on a row with no `read[]` the term is undefined, so that row drops out too.
   */
  const storedQuery = async (_container, spec) => {
    const code = spec.parameters.find(p => p.name === '@code').value;
    const sealed = /NOT ARRAY_CONTAINS\(c\.read, '([^']+)'\)/.exec(spec.query);
    const items = stored
      .filter(row => row.shortCode === code || row.legacyShortCodes.includes(code))
      .filter(row => !sealed || (row.read && !row.read.includes(sealed[1])))
      .map(row => ({ id: row.id }));
    return { items };
  };

  await t.test('a sealed project still owns its code', async () => {
    t.mock.method(cosmos, 'query', storedQuery);

    assert.deepStrictEqual(await projectsRepo.listShortCodeOwners('sealed-site'), ['310'],
      'a hidden owner would let PUT or DELETE /links repoint a sealed project\'s code');
  });

  await t.test('a project with no read[] still owns its code', async () => {
    t.mock.method(cosmos, 'query', storedQuery);

    assert.deepStrictEqual(await projectsRepo.listShortCodeOwners('readless-site'), ['312']);
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
