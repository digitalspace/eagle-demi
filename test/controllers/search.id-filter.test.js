'use strict';

/**
 * `and[_id]` on every Cosmos-backed `/search` dataset: one row back, nothing reported dropped.
 * Each corpus holds the target and a sibling, so a dataset that ignores the filter answers two.
 * The index datasets' half lives in test/search/eagle-query.test.js. Harness:
 * `test/helpers/search-reads.js`.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const searchController = require('../../src/controllers/search');
const {
  PROJECT_ROW, stubCosmos, getAsStaff,
  listRow, orgRow, periodRow, commentRow, updateRow, notificationRow
} = require('../helpers/search-reads');
const {
  USER_EAGLE_ID, GROUP_EAGLE_ID, storedInspection, storedElement, ITEM_EAGLE_ID, INSPECTION_EAGLE_ID
} = require('../helpers/eagle-mirror-fixtures');

const OTHER = '5c0e4a0c3f4b1a0021a1b2ff';
const STAFF = ['sysadmin', 'staff'];

/** A target row and a sibling of the same shape, keyed by container. */
const pair = (container, target, extra = {}) => ({
  ...extra,
  [container]: [target, { ...target, id: OTHER, eagleId: OTHER }]
});

const inspectionItem = {
  id: ITEM_EAGLE_ID, kind: 'InspectionItem', inspection: INSPECTION_EAGLE_ID, projectId: '207', read: STAFF
};

const CASES = {
  List: pair('lists', listRow()),
  Organization: pair('lists', orgRow()),
  CommentPeriod: pair('commentPeriods', periodRow(), { projects: [PROJECT_ROW] }),
  Comment: pair('comments', commentRow(), { projects: [PROJECT_ROW] }),
  RecentActivity: pair('updates', updateRow(), { projects: [PROJECT_ROW] }),
  ProjectNotification: pair('notifications', notificationRow()),
  User: pair('users', { id: USER_EAGLE_ID, eagleId: USER_EAGLE_ID, firstName: 'Pat', read: STAFF }),
  Group: pair('groups', { id: GROUP_EAGLE_ID, eagleId: GROUP_EAGLE_ID, projectId: '207', name: 'WG', read: STAFF },
    { projects: [PROJECT_ROW] }),
  Inspection: pair('inspections', storedInspection(STAFF), { projects: [PROJECT_ROW] }),
  InspectionElement: pair('inspections', storedElement(STAFF)),
  InspectionItem: pair('inspections', inspectionItem)
};

/** A feed of pinned and dated rows, not a record list: no `_id` to fetch by. */
const NO_ID = new Set(['HomeFeed']);

test('every Cosmos dataset is in the and[_id] table or named as taking none', () => {
  const covered = [...Object.keys(CASES), ...NO_ID].sort();
  assert.deepStrictEqual(covered, [...searchController.COSMOS_DATASET_NAMES].sort());
});

test('GET /search?dataset=<each>&and[_id]= answers that one row', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  for (const [dataset, corpus] of Object.entries(CASES)) {
    await t.test(dataset, async () => {
      const [container] = Object.keys(corpus).filter(key => key !== 'projects');
      const id = corpus[container][0].id;
      stubCosmos(t, corpus, {}, { strict: true });

      const res = await getAsStaff(t, `/api/search?dataset=${dataset}&and%5B_id%5D=${id}`, ['sysadmin']);

      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const [{ searchResults, count, meta }] = res.body;
      assert.deepStrictEqual(searchResults.map(row => row._id), [id]);
      assert.strictEqual(count, 1);
      assert.strictEqual(meta[0].dropped, undefined, `dropped ${JSON.stringify(meta[0].dropped)}`);
    });
  }
});
