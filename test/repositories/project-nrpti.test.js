'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const projectNrpti = require('../../src/repositories/project-nrpti');
const { fakeWhereQuery } = require('../helpers/updates-store');

const E1 = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const E2 = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const READ = ['public'];

// E1: a twin listed before its Track row. E2: a deleted Track row and its live twin.
const ROWS = Object.freeze([
  { id: `eagle-${E1}`, eagleId: E1, read: READ, sources: {} },
  { id: '0', eagleId: E1, read: READ, sources: { track: { id: 0 } } },
  { id: '7', eagleId: E2, read: READ, isDeleted: true, sources: { track: { id: 7 } } },
  { id: `eagle-${E2}`, eagleId: E2, read: READ, sources: {} },
  { id: '9', read: READ, sources: { track: { id: 9 } } }
]);

test('project-nrpti', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('eagleIdMap links an Eagle id to its Track row, not the eagle-<id> twin', async () => {
    fakeWhereQuery(t, ROWS);
    const map = await projectNrpti.eagleIdMap();
    assert.strictEqual(map.get(E1), '0');
  });

  await t.test('eagleIdMap never links a deleted row', async () => {
    fakeWhereQuery(t, ROWS);
    const map = await projectNrpti.eagleIdMap();
    assert.strictEqual(map.get(E2), `eagle-${E2}`);
  });

  await t.test('patchSummary sets only /sources/nrpti on the project', async () => {
    const patch = t.mock.method(cosmos, 'patch', async () => ({}));
    const summary = { recordCounts: { order: 2 } };
    await projectNrpti.patchSummary(7, summary);
    const [container, id, partitionKey, operations] = patch.mock.calls[0].arguments;
    assert.deepStrictEqual([container, id, partitionKey], ['projects', '7', '7']);
    assert.deepStrictEqual(operations, [{ op: 'set', path: '/sources/nrpti', value: summary }]);
  });
});
