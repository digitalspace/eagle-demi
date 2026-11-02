'use strict';

// commentPeriods.listSyncPending: the period rows the sync-out pending hook re-queues, deleted ones too.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const commentPeriods = require('../../src/repositories/comment-periods');
const { fakeWhereQuery } = require('../helpers/updates-store');

const period = (id, syncVersion, sentVersion, overrides = {}) => ({
  id, syncVersion,
  ...(sentVersion === undefined ? {} : { syncOut: { eagle: { sentVersion } } }),
  ...overrides
});

const ROWS = [
  period('behind', 2, 1),
  period('sent', 2, 2),
  period('never-sent', 1),
  period('never-changed', 0),
  period('deleted-behind', 3, 2, { isDeleted: true })
];

test('commentPeriods.listSyncPending lists every row past its sent version, deleted ones too', async (t) => {
  fakeWhereQuery(t, ROWS);

  const rows = await commentPeriods.listSyncPending();

  assert.deepStrictEqual(rows.map(row => row.id), ['behind', 'never-sent', 'deleted-behind']);
});
