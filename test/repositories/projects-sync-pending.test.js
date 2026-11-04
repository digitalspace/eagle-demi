'use strict';

// projects.listSyncPending: the project rows the sync-out pending hook re-queues. projects.listNative: the rows a re-seed keeps.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const projects = require('../../src/repositories/projects');
const { isNativeProject, isDemiOwnedProject } = require('../../src/merge/project');
const { fakeWhereQuery } = require('../helpers/updates-store');

const project = (id, syncVersion, sentVersion, overrides = {}) => ({
  id, sourceSystem: 'track', sources: {}, syncVersion,
  ...(sentVersion === undefined ? {} : { syncOut: { eagle: { sentVersion } } }),
  ...overrides
});

const OWNED = { demiOwnedAt: '2026-11-01T00:00:00.000Z', sources: { track: { track_project_id: 8 } } };

const ROWS = [
  project('behind', 2, 1),
  project('sent', 2, 2),
  project('never-sent', 1),
  project('never-changed', 0),
  project('track-null', 2, 1, { sources: { track: null } }),
  // Cosmos answers `null != 'eagle'` as undefined, which drops the row; the evaluator does the same.
  project('source-null', 2, 1, { sourceSystem: null }),
  project('tracked', 2, 1, { sources: { track: { track_project_id: 7 } } }),
  project('eagle-owned', 2, 1, { sourceSystem: 'eagle' }),
  project('eagle-5cf00c03a266b7e1877504db', 2, 1, { sourceSystem: undefined }),
  project('owned', 2, 1, { ...OWNED, eagleId: '5cf00c03a266b7e1877504dc' }),
  project('owned-sent', 2, 2, { ...OWNED, eagleId: '5cf00c03a266b7e1877504dd' }),
  project('owned-no-eagle-id', 2, 1, OWNED)
];
const listed = row => isNativeProject(row) || (isDemiOwnedProject(row) && Boolean(row.eagleId));

test('projects.listSyncPending lists native and DEMI-owned Eagle rows past their sent version, as the JS rules read them',
  async (t) => {
    fakeWhereQuery(t, ROWS);

    const rows = await projects.listSyncPending();

    assert.deepStrictEqual(rows.map(row => row.id), ['behind', 'never-sent', 'track-null', 'source-null', 'owned']);
    assert.deepStrictEqual(ROWS.filter(listed).map(row => row.id),
      ['behind', 'sent', 'never-sent', 'never-changed', 'track-null', 'source-null', 'owned', 'owned-sent'],
      'the SQL and the JS rules agree');
  });

test('projects.listNative lists every native row, sent or not, and no Track or Eagle row', async (t) => {
  // A compliance row too: a native row the seeder misses is rebuilt from Track and split from its Eagle id.
  fakeWhereQuery(t, [...ROWS, project('compliance-only', 0, undefined, { read: ['compliance'] })]);

  const rows = await projects.listNative();

  assert.deepStrictEqual(rows.map(row => row.id),
    ['behind', 'sent', 'never-sent', 'never-changed', 'track-null', 'source-null', 'compliance-only']);
});
