'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  parseArgs, purgeSeeded, isSeeded, UNLINKED_PARTITION
} = require('../../src/scripts/purge-nrpti-seeded');
const { TIER } = require('../../src/helpers/access-sql');

function seeded(id, name) {
  return {
    id,
    name,
    sourceSystem: 'nrpti',
    projectState: 'Compliance Record Ingest',
    metadata: { sourceSystem: 'nrpti', seededFromNrpti: true }
  };
}

function fakeProjects(items, opts = {}) {
  const state = { deleted: [], listCalls: [] };
  return {
    state,
    async listBySourceSystem(access, sourceSystem) {
      state.listCalls.push({ access, sourceSystem });
      return { items };
    },
    async deleteById(id) {
      if (opts.failFor === id) throw new Error('project delete boom');
      state.deleted.push(id);
      return true;
    }
  };
}

/** @param byProject e.g. {'8000123': ['r1','r2'], '': ['u1']} */
function fakeRecords(byProject, opts = {}) {
  const state = { deleted: [], listCalls: [] };
  return {
    state,
    async listVisible(access, listOpts) {
      state.listCalls.push(listOpts);
      const ids = byProject[listOpts.projectId] || [];
      return { items: ids.map(id => ({ id, projectId: listOpts.projectId })) };
    },
    async deleteById(id, projectId) {
      if (opts.failFor === id) throw new Error('record delete boom');
      state.deleted.push([id, projectId]);
      // The real one returns false on a 404 instead of throwing — see cosmos.remove.
      return opts.missingFor !== id;
    }
  };
}

function fakeDocuments(byProject = {}) {
  const state = { listCalls: [] };
  return {
    state,
    async listVisible(access, listOpts) {
      state.listCalls.push(listOpts);
      return { items: (byProject[listOpts.projectId] || []).map(id => ({ id })) };
    }
  };
}

/**
 * Stands in for `src/search/ai-search.js`. Assert on `state.deleted` in every live test: passing
 * the wrong opts key would silently fall through to the REAL client, which on a machine with a
 * populated .env issues live deletes against the dev index.
 */
function fakeIndex(opts = {}) {
  const state = { deleted: [] };
  return {
    state,
    config() {
      return { configured: opts.configured !== false };
    },
    indexes() {
      return { chunks: 'demi-chunks', projects: 'demi-projects', documents: 'demi-documents' };
    },
    async deleteFromIndex(index, id) {
      state.deleted.push([index, id]);
      // The real one logs and returns 0 instead of throwing, so 0 is the ONLY failure signal.
      return opts.failFor === id ? 0 : 1;
    }
  };
}

const TWO_SEEDED = [seeded('8000123', 'Sooke River Rest Area'), seeded('8000456', 'Pit Toilet 12')];
const RECORDS = { '8000123': ['r1', 'r2'], '8000456': ['r3'], [UNLINKED_PARTITION]: [] };

test('parseArgs defaults to a dry run and rejects anything else', () => {
  assert.deepStrictEqual(parseArgs([]), { live: false });
  assert.strictEqual(parseArgs(['--live']).live, true);
  assert.throws(() => parseArgs(['--yes-really']), /unknown argument/);
});

test('isSeeded demands BOTH markers', () => {
  assert.strictEqual(isSeeded(seeded('8000123', 'x')), true);
  // Provenance alone is not proof of the auto-seed — a future NRPTI importer could set it.
  assert.strictEqual(isSeeded({ id: '1', sourceSystem: 'nrpti' }), false);
  assert.strictEqual(isSeeded({ id: '1', sourceSystem: 'track', metadata: { seededFromNrpti: true } }), false);
});

test('a dry run counts projects and records but deletes nothing', async () => {
  const projects = fakeProjects(TWO_SEEDED);
  const records = fakeRecords(RECORDS);
  const index = fakeIndex();

  const summary = await purgeSeeded([], {
    projects, records, documents: fakeDocuments(), index
  });

  assert.strictEqual(summary.mode, 'dry-run');
  assert.strictEqual(summary.projectsRemoved, 2);
  assert.strictEqual(summary.recordsRemoved, 3);      // 2 + 1, the real number
  assert.deepStrictEqual(projects.state.deleted, []);
  assert.deepStrictEqual(records.state.deleted, []);
  assert.deepStrictEqual(index.state.deleted, []);
});

test('a record that was already gone is not counted as removed', async () => {
  // cosmos.remove answers false on a 404 rather than throwing. Counting that as a deletion makes
  // the summary claim rows this run did not remove — and the summary is the only record of it.
  const summary = await purgeSeeded(['--live'], {
    projects: fakeProjects([seeded('8000123', 'Sooke River Rest Area')]),
    records: fakeRecords({ '8000123': ['r1', 'r2'] }, { missingFor: 'r2' }),
    documents: fakeDocuments(),
    index: fakeIndex()
  });

  assert.strictEqual(summary.recordsRemoved, 1, 'r2 was already gone');
  assert.strictEqual(summary.projectsRemoved, 1, 'and the project still goes');
});

test('a live run refuses to start when AI Search is not configured', async () => {
  // `deleteFromIndex` returns 0 for a failed delete AND for an unconfigured service, so without
  // this gate the run empties Cosmos and only then reports one failure per project — none of them
  // retryable, because listBySourceSystem no longer returns a project that Cosmos no longer holds.
  const projects = fakeProjects(TWO_SEEDED);
  const records = fakeRecords(RECORDS);

  await assert.rejects(
    () => purgeSeeded(['--live'], {
      projects, records, documents: fakeDocuments(), index: fakeIndex({ configured: false })
    }),
    /AI Search is not configured/
  );

  assert.deepStrictEqual(projects.state.deleted, [], 'nothing deleted');
  assert.deepStrictEqual(records.state.deleted, [], 'not even the records');
});

test('a dry run is allowed without AI Search, because it deletes nothing', async () => {
  const summary = await purgeSeeded([], {
    projects: fakeProjects(TWO_SEEDED),
    records: fakeRecords(RECORDS),
    documents: fakeDocuments(),
    index: fakeIndex({ configured: false })
  });
  assert.strictEqual(summary.projectsRemoved, 2);
});

test('a live run deletes records first, then the project, then the index row', async () => {
  const projects = fakeProjects(TWO_SEEDED);
  const records = fakeRecords(RECORDS);
  const index = fakeIndex();

  const summary = await purgeSeeded(['--live'], {
    projects, records, documents: fakeDocuments(), index
  });

  assert.strictEqual(summary.projectsRemoved, 2);
  assert.strictEqual(summary.recordsRemoved, 3);
  assert.strictEqual(summary.indexEntriesRemoved, 2);
  // The partition key must be the record's own project, or the delete silently misses.
  assert.deepStrictEqual(records.state.deleted,
    [['r1', '8000123'], ['r2', '8000123'], ['r3', '8000456']]);
  assert.deepStrictEqual(projects.state.deleted, ['8000123', '8000456']);
  assert.deepStrictEqual(index.state.deleted,
    [['demi-projects', '8000123'], ['demi-projects', '8000456']]);
  assert.deepStrictEqual(summary.failures, []);
});

test('the AI Search delete is not optional — indexers never see a Cosmos delete', async () => {
  // Drop it and the phantom project stays searchable forever, even once Cosmos is clean.
  const index = fakeIndex();
  await purgeSeeded(['--live'], {
    projects: fakeProjects(TWO_SEEDED),
    records: fakeRecords(RECORDS),
    documents: fakeDocuments(),
    index
  });
  assert.strictEqual(index.state.deleted.length, 2, 'one index delete per deleted project');
  for (const [indexName] of index.state.deleted) {
    assert.strictEqual(indexName, 'demi-projects');
  }
});

test('a failed index delete is a failure, because no re-run can retry it', async () => {
  // The Cosmos row is gone by this point, so `listBySourceSystem` will never return this project
  // again and the indexer's `_ts` high-water mark cannot see the delete. Unreported, the phantom
  // stays searchable forever and the script exits 0 — the exact outcome the purge exists to avoid.
  const index = fakeIndex({ failFor: '8000456' });

  const summary = await purgeSeeded(['--live'], {
    projects: fakeProjects(TWO_SEEDED),
    records: fakeRecords(RECORDS),
    documents: fakeDocuments(),
    index
  });

  assert.strictEqual(summary.projectsRemoved, 2);       // the Cosmos side did succeed
  assert.strictEqual(summary.indexEntriesRemoved, 1);
  assert.strictEqual(summary.failures.length, 1);
  assert.strictEqual(summary.failures[0].id, '8000456');
  assert.strictEqual(summary.failures[0].stage, 'index');
  assert.match(summary.failures[0].message, /by hand/);
});

test('a dry run does not report an index failure — it never calls the index', async () => {
  const index = fakeIndex({ failFor: '8000456' });
  const summary = await purgeSeeded([], {
    projects: fakeProjects(TWO_SEEDED), records: fakeRecords(RECORDS), documents: fakeDocuments(), index
  });
  assert.deepStrictEqual(index.state.deleted, []);
  assert.deepStrictEqual(summary.failures, []);
});

test('a project sourced nrpti without the seed marker is reported, never deleted', async () => {
  const legit = { id: '4321', name: 'Real NRPTI import', sourceSystem: 'nrpti', metadata: {} };
  const projects = fakeProjects([legit, ...TWO_SEEDED]);
  const index = fakeIndex();

  const summary = await purgeSeeded(['--live'], {
    projects, records: fakeRecords(RECORDS), documents: fakeDocuments(), index
  });

  assert.strictEqual(summary.scanned, 3);
  assert.strictEqual(summary.projectsRemoved, 2);
  assert.deepStrictEqual(summary.notSeeded, [{ id: '4321', name: 'Real NRPTI import' }]);
  assert.ok(!projects.state.deleted.includes('4321'));
  assert.ok(!index.state.deleted.some(([, id]) => id === '4321'));
});

test('a seeded project that owns documents is refused, not purged', async () => {
  // Something linked real content to a phantom. Deleting the project would take that content's
  // registry row with it, so this needs a human rather than a sweep.
  const projects = fakeProjects(TWO_SEEDED);
  const records = fakeRecords(RECORDS);
  const index = fakeIndex();

  const summary = await purgeSeeded(['--live'], {
    projects, records, documents: fakeDocuments({ '8000123': ['doc-a'] }), index
  });

  assert.strictEqual(summary.projectsRemoved, 1);
  assert.deepStrictEqual(projects.state.deleted, ['8000456']);
  // Its records survive too — they are still reachable while the project row exists.
  assert.deepStrictEqual(records.state.deleted, [['r3', '8000456']]);
  assert.strictEqual(summary.failures.length, 1);
  assert.strictEqual(summary.failures[0].id, '8000123');
  assert.strictEqual(summary.failures[0].stage, 'documents');
  assert.match(summary.failures[0].message, /refusing to delete/);
});

test('a project whose records fail to delete keeps its row', async () => {
  // The dangerous outcome: records left in a partition whose project is gone. Nothing lists
  // records by a dead project id, so they would be unreachable rather than merely stale.
  const projects = fakeProjects(TWO_SEEDED);
  const records = fakeRecords(RECORDS, { failFor: 'r2' });
  const index = fakeIndex();

  const summary = await purgeSeeded(['--live'], {
    projects, records, documents: fakeDocuments(), index
  });

  assert.deepStrictEqual(projects.state.deleted, ['8000456']);
  assert.deepStrictEqual(index.state.deleted, [['demi-projects', '8000456']]);
  assert.strictEqual(summary.failures.length, 1);
  assert.strictEqual(summary.failures[0].id, '8000123');
  assert.strictEqual(summary.failures[0].stage, 'records');
});

test('the unlinked partition is swept, and named explicitly rather than left falsy', async () => {
  // `''` is a real partition key. A falsy `if (projectId)` in the repository would turn this
  // lookup into "every record in the container" — a wipe wearing a sweep's clothes.
  const records = fakeRecords({ ...RECORDS, [UNLINKED_PARTITION]: ['u1', 'u2'] });

  const summary = await purgeSeeded(['--live'], {
    projects: fakeProjects([]), records, documents: fakeDocuments(), index: fakeIndex()
  });

  assert.strictEqual(summary.unlinkedRecordsRemoved, 2);
  assert.deepStrictEqual(records.state.deleted, [['u1', ''], ['u2', '']]);
  const swept = records.state.listCalls.at(-1);
  assert.strictEqual(swept.projectId, '', 'the sweep must ask for the empty partition by name');
});

test('the dry run counts the unlinked partition without deleting it', async () => {
  const records = fakeRecords({ [UNLINKED_PARTITION]: ['u1', 'u2', 'u3'] });
  const summary = await purgeSeeded([], {
    projects: fakeProjects([]), records, documents: fakeDocuments(), index: fakeIndex()
  });
  assert.strictEqual(summary.unlinkedRecordsRemoved, 3);
  assert.deepStrictEqual(records.state.deleted, []);
});

test('the purge reads with the privileged tier, or it purges only what it can see', async () => {
  const projects = fakeProjects(TWO_SEEDED);
  await purgeSeeded([], {
    projects, records: fakeRecords(RECORDS), documents: fakeDocuments(), index: fakeIndex()
  });

  const { access, sourceSystem } = projects.state.listCalls[0];
  assert.strictEqual(access.tier, TIER.PRIVILEGED);
  assert.strictEqual(access.projectScope, null);
  assert.strictEqual(sourceSystem, 'nrpti');
});
