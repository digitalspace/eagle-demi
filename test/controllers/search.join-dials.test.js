'use strict';

// `/search` joins labels onto a dataset's rows through short repository selects. A label row's own
// field dials must hold on that join, as they do on a full read of the row.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { storedContainers } = require('../helpers/stored-documents');
const {
  PROJECT_ROW, get, getAsStaff, periodRow, updateRow, notificationRow, orgRow
} = require('../helpers/search-reads');
const { PROJECT_EAGLE_ID, ORG_EAGLE_ID } = require('../helpers/eagle-mirror-fixtures');

const MET_URL = 'https://engage.gov.bc.ca/nicomen';

const CASES = [
  {
    name: 'RecentActivity keeps a dialled notification name to staff',
    path: '/api/search?dataset=RecentActivity',
    rows: { projects: [], updates: [updateRow({ projectId: null, pcp: null })], notifications: [notificationRow({ vis: { name: 2 } })] },
    whole: ['updates'],
    anonymous: (row, text) => {
      assert.ok(!('name' in row.projectNotification));
      assert.ok(!text.includes('Bear Creek Quarry'));
    },
    staff: (row) => assert.strictEqual(row.projectNotification.name, 'Bear Creek Quarry')
  },
  {
    name: 'RecentActivity keeps a dialled period metURL to staff',
    path: '/api/search?dataset=RecentActivity',
    rows: {
      projects: [],
      notifications: [],
      updates: [updateRow({ projectId: null, projectNotification: null })],
      commentPeriods: [periodRow({ isMet: true, metURL: MET_URL, vis: { metURL: 2 } })]
    },
    whole: ['updates'],
    anonymous: (row, text) => {
      assert.strictEqual(row.pcp.metURL, '');
      assert.ok(!text.includes(MET_URL));
    },
    staff: (row) => assert.strictEqual(row.pcp.metURL, MET_URL)
  },
  {
    name: 'CommentPeriod keeps a dialled project name and Eagle id to staff',
    path: '/api/search?dataset=CommentPeriod',
    rows: { commentPeriods: [periodRow()], projects: [{ ...PROJECT_ROW, vis: { name: 2, eagleId: 2 } }] },
    whole: ['commentPeriods'],
    anonymous: (row, text) => {
      assert.ok(!('projectName' in row));
      assert.strictEqual(row.project, null);
      assert.ok(!text.includes(PROJECT_EAGLE_ID));
    },
    staff: (row) => {
      assert.strictEqual(row.projectName, PROJECT_ROW.name);
      assert.strictEqual(row.project, PROJECT_EAGLE_ID);
    }
  },
  {
    name: 'CommentPeriod still lists a period whose project dials its id',
    path: '/api/search?dataset=CommentPeriod',
    rows: { commentPeriods: [periodRow()], projects: [{ ...PROJECT_ROW, vis: { id: 2 } }] },
    whole: ['commentPeriods'],
    anonymous: (row) => {
      assert.strictEqual(row.projectName, PROJECT_ROW.name);
      assert.strictEqual(row.project, PROJECT_EAGLE_ID);
      // The stored project id is also the period's own, undialled `projectId`: it shows only there.
      assert.deepStrictEqual(Object.keys(row).filter(key => row[key] === PROJECT_ROW.id), ['projectId']);
    },
    staff: (row) => assert.strictEqual(row.project, PROJECT_EAGLE_ID)
  },
  {
    name: 'ProjectNotification keeps a dialled proponent name to staff',
    path: '/api/search?dataset=ProjectNotification',
    rows: { notifications: [notificationRow({ proponent: ORG_EAGLE_ID })], lists: [orgRow({ vis: { name: 2 } })] },
    whole: ['notifications'],
    anonymous: (row, text) => {
      assert.strictEqual(row.proponent, ORG_EAGLE_ID);
      assert.ok(!text.includes('Nicomen Energy Ltd'));
    },
    staff: (row) => assert.strictEqual(row.proponent, 'Nicomen Energy Ltd')
  }
];

for (const c of CASES) {
  test(c.name, async (t) => {
    storedContainers(t, c.rows, { whole: c.whole });

    const anonymous = await get(c.path);
    const text = JSON.stringify(anonymous.body);
    c.anonymous(anonymous.body[0].searchResults[0], text);
    assert.ok(!text.includes('"vis"'));

    const staff = await getAsStaff(t, c.path);
    c.staff(staff.body[0].searchResults[0]);
    assert.ok(!JSON.stringify(staff.body).includes('"vis"'));
  });
}
