'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const projects = require('../../src/repositories/projects');
const { PROJECT_SEARCH_FIELDS, LEG_TWO_SEARCH_FIELDS } = require('../../src/search/ai-search');
const { dialExclusion } = require('../../src/search/project-dials');

const ANON = { level: 4 };

/** Stand in for the Cosmos read: a row is hidden when it dials any field asked for. */
function dialledRows(t, rows) {
  return t.mock.method(projects, 'listDialHiddenIds', async (_access, fields) =>
    rows.filter(r => fields.some(field => Object.hasOwn(r.vis, field))).map(r => r.id));
}

test('dialExclusion', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a description dial is excluded under the project fields, not under leg two', async () => {
    dialledRows(t, [{ id: 'p1', vis: { description: 2 } }]);

    assert.strictEqual(await dialExclusion(ANON, [], PROJECT_SEARCH_FIELDS), "not search.in(id, 'p1', ',')");
    assert.strictEqual(await dialExclusion(ANON, [], LEG_TWO_SEARCH_FIELDS), null);
  });

  await t.test('an index column reads the dial of the stored field it is built from', async () => {
    const read = dialledRows(t, [{ id: 'p1', vis: { proponentName: 2 } }, { id: 'p2', vis: { region: 3 } }]);

    assert.strictEqual(await dialExclusion(ANON, ['proponent'], 'searchLabels'), "not search.in(id, 'p1,p2', ',')");
    assert.deepStrictEqual(read.mock.calls[0].arguments[0], ANON, 'at the caller\'s own level');
  });
});
