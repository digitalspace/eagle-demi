'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  closeUnpublished, needsClosing, closedAcl, exitCodeFor, parseArgs
} = require('../../src/scripts/close-unpublished-track-projects');
const merge = require('../../src/merge/project');

const NOW = '2026-08-23T00:00:00.000Z';
const PUBLIC_ACL = ['public', ...merge.SECURE_ROLES];

/** `sources.eagle` populated — the merge matched an Eagle record. */
const MATCHED = { _id: '58851172aaecd9001b820335', read: ['public'] };

/** Projects repository double. `listVisible` answers whole — projects fit in one page. */
function fakeProjects(items) {
  return { CONTAINER: 'projects', async listVisible() { return { items }; } };
}

/** Documents repository double, keyed by the partition the script pins. */
function fakeDocuments(countsByProject = {}) {
  const state = { asked: [] };
  return {
    state,
    async countVisible(access, opts) {
      state.asked.push(String(opts.projectId));
      return countsByProject[String(opts.projectId)] || 0;
    }
  };
}

function fakePatch() {
  const calls = [];
  return { calls, fn: async (id, ops) => { calls.push({ id, ops }); } };
}

const TRACK_ONLY = {
  id: '354', name: 'Surrey Langley SkyTrain', eagleId: null, read: PUBLIC_ACL,
  sources: { track: {}, eagle: null }
};
const TRACK_LINKED = {
  id: '207', name: 'Nicomen Wind Energy', eagleId: '58851172aaecd9001b820335', read: PUBLIC_ACL,
  sources: { track: {}, eagle: MATCHED }
};
// The category the first review of this branch caught: `epic_guid` is set, so `eagleId` is set,
// but it points at nothing and no Eagle record was matched. `merge/project.js` counts 6 of these.
const DANGLING_GUID = {
  id: '361', name: 'Dangling Guid Project', eagleId: '58851172aaecd9001b820335',
  read: PUBLIC_ACL, sources: { track: {}, eagle: null }
};
const EAGLE_ONLY = {
  id: 'eagle-6a59234357be6fca20a489dc', name: 'testtesttest',
  eagleId: '6a59234357be6fca20a489dc', read: PUBLIC_ACL,
  sources: { track: null, eagle: MATCHED }
};
const ALREADY_CLOSED = {
  id: '360', name: 'Berg Mine', eagleId: null, read: [...merge.SECURE_ROLES],
  sources: { track: {}, eagle: null }
};
// `POST /projects` writes `sources: {}` deliberately — the wildfire sync patches
// `/sources/wildfire` and a Cosmos patch cannot create a path recursively — alongside
// `eagleId: null`, `sourceSystem: 'track'` and a public `read[]`. Under a `sources.eagle` test
// alone that is byte-identical to a Track-only row.
const API_CREATED = {
  id: '9001', name: 'Deliberately published via POST /projects', eagleId: null,
  sourceSystem: 'track', read: PUBLIC_ACL, isPublished: true, sources: {}
};
const NO_SOURCES = { id: '362', name: 'Legacy Row', read: PUBLIC_ACL };

test('needsClosing selects on the Eagle counterpart, not on provenance', async (t) => {
  await t.test('a Track project with no Eagle counterpart, currently public', () => {
    assert.strictEqual(needsClosing(TRACK_ONLY), true);
  });

  await t.test('a DANGLING epic_guid counts as no counterpart', () => {
    // `eagleId` is populated from `track.epic_guid` whether or not the guid resolves
    // (`merge/project.js`), while `resolveProjectAcl` keys on the record actually matched. Selecting
    // on `eagleId` skipped these 6 rows and left them public — the exact gap the reviewer found.
    assert.strictEqual(needsClosing(DANGLING_GUID), true);
    assert.ok(DANGLING_GUID.eagleId, 'and it does carry an eagleId, which is the whole trap');
  });

  await t.test('an API-CREATED project is left alone', () => {
    // The row somebody deliberately and auditably published through POST /projects — the same
    // route the eagle-api-pushes-to-DEMI ingest path will use. `sources.eagle` alone does not tell
    // it apart from a Track-only row; `sources.track` does, because the merge writes it and
    // createProject does not.
    assert.strictEqual(needsClosing(API_CREATED), false);
  });

  await t.test('a row with no sources at all is left alone', () => {
    // Not fail-closed here, deliberately: "no sources" is the API-created shape, not an unmatched
    // Track row. Narrowing it would unpublish a deliberate act. This script only ever closes rows
    // it can prove the merge produced from Track with no Eagle match.
    assert.strictEqual(needsClosing(NO_SOURCES), false);
  });

  await t.test('a Track project WITH an Eagle counterpart is left alone', () => {
    // Eagle published it, so Eagle's read[] is the authority and the merge already preserved it.
    assert.strictEqual(needsClosing(TRACK_LINKED), false);
  });

  await t.test('an Eagle-only project is left alone', () => {
    // It always carries `sources.eagle` by construction, so it can never match. This is the row set
    // the PROVENANCE filter handles; conflating the two would unpublish every project Eagle holds
    // that Track has not caught up with.
    assert.strictEqual(needsClosing(EAGLE_ONLY), false);
  });

  await t.test('a project already closed is not rewritten', () => {
    // Otherwise a re-run pays full RU to set the values that are already there.
    assert.strictEqual(needsClosing(ALREADY_CLOSED), false);
  });
});

test('closeUnpublished', async (t) => {
  await t.test('dry run is the default and writes nothing', async () => {
    const patch = fakePatch();
    const summary = await closeUnpublished([], {
      projects: fakeProjects([TRACK_ONLY, TRACK_LINKED]),
      documents: fakeDocuments(),
      patch: patch.fn,
      now: NOW
    });

    assert.strictEqual(summary.mode, 'dry-run');
    assert.strictEqual(summary.matched, 1);
    assert.strictEqual(summary.closed, 0);
    assert.strictEqual(patch.calls.length, 0, 'a dry run must not patch');
    assert.deepStrictEqual(summary.names, ['354 Surrey Langley SkyTrain']);
  });

  await t.test('--live withdraws public and mirrors isPublished', async () => {
    const patch = fakePatch();
    const summary = await closeUnpublished(['--live'], {
      projects: fakeProjects([TRACK_ONLY, TRACK_LINKED, EAGLE_ONLY, ALREADY_CLOSED, API_CREATED]),
      documents: fakeDocuments(),
      patch: patch.fn,
      now: NOW
    });

    assert.strictEqual(summary.scanned, 5);
    assert.strictEqual(summary.matched, 1, 'only the Track-only public row');
    assert.strictEqual(summary.closed, 1);
    assert.strictEqual(patch.calls.length, 1);

    const { id, ops } = patch.calls[0];
    assert.strictEqual(id, '354');
    assert.deepStrictEqual(ops, [
      { op: 'set', path: '/read', value: closedAcl() },
      { op: 'set', path: '/isPublished', value: false },
      { op: 'set', path: '/updatedAt', value: NOW }
    ]);
    assert.ok(!ops[0].value.includes('public'), 'public is what this script exists to remove');
  });

  await t.test('it writes exactly what a re-seed would write', async () => {
    // Two SECURE_ROLES lists exist and they differ. Asserting against either constant would pass
    // while the backfill and a re-seed left different arrays on the same row, and neither module's
    // own tests could see it. Comparing against the merge's OWN output is drift-proof: whichever
    // list moves, this fails.
    const reseeded = merge.mergeTrackProject({ track_project_id: 354 }, null, { now: NOW });
    assert.deepStrictEqual(closedAcl(), reseeded.read);
    assert.strictEqual(reseeded.isPublished, false, 'and the mirror agrees');
  });

  await t.test('a project WITH documents is skipped, counted and never patched', async () => {
    // The whole no-cascade argument rests on Track-only projects having no documents. Measured
    // true today; asserted rather than assumed, because if it stops being true this script would
    // otherwise leave documents publicly searchable under a project it just unpublished.
    const patch = fakePatch();
    const summary = await closeUnpublished(['--live'], {
      projects: fakeProjects([TRACK_ONLY]),
      documents: fakeDocuments({ 354: 7 }),
      patch: patch.fn,
      now: NOW
    });

    assert.strictEqual(summary.matched, 1);
    assert.strictEqual(summary.withDocuments, 1);
    assert.strictEqual(summary.closed, 0);
    assert.strictEqual(patch.calls.length, 0, 'skipped means not patched');
  });

  await t.test('the document count is pinned to the project partition', async () => {
    const documents = fakeDocuments();
    await closeUnpublished([], {
      projects: fakeProjects([TRACK_ONLY]), documents, patch: fakePatch().fn, now: NOW
    });
    assert.deepStrictEqual(documents.state.asked, ['354'],
      'an unpinned count would fan out across every partition and cost the corpus');
  });

  await t.test('a failed patch is counted, and the run continues', async () => {
    const other = {
      id: '355', name: 'Kimberley Water Reclamation Centre', eagleId: null, read: PUBLIC_ACL,
      sources: { track: {}, eagle: null }
    };
    let first = true;
    const summary = await closeUnpublished(['--live'], {
      projects: fakeProjects([TRACK_ONLY, other]),
      documents: fakeDocuments(),
      patch: async () => { if (first) { first = false; throw new Error('429'); } },
      now: NOW
    });

    assert.strictEqual(summary.failed, 1);
    assert.strictEqual(summary.closed, 1, 'one failure must not abandon the rest');
  });
});

test('parseArgs refuses anything it does not understand', () => {
  // A typo'd flag that is silently ignored turns a live run into a dry run reporting success.
  assert.deepStrictEqual(parseArgs([]), { live: false });
  assert.deepStrictEqual(parseArgs(['--live']), { live: true });
  assert.throws(() => parseArgs(['--dry-run']), /unknown argument/);
});

test('exitCodeFor', async (t) => {
  // The contract the docblock and the commit message advertise, and that an operator running under
  // `set -e` relies on. It lived inline in the require.main block, where no test could reach it.
  await t.test('a clean run exits 0', () => {
    assert.strictEqual(exitCodeFor({ failed: 0, withDocuments: 0 }), 0);
  });

  await t.test('a failure exits 1', () => {
    assert.strictEqual(exitCodeFor({ failed: 1, withDocuments: 0 }), 1);
  });

  await t.test('a SKIP exits 1 too — it is work deliberately not done', () => {
    assert.strictEqual(exitCodeFor({ failed: 0, withDocuments: 1 }), 1);
  });

  await t.test('a partial run that also closed rows still exits 1', () => {
    assert.strictEqual(exitCodeFor({ failed: 0, withDocuments: 2, closed: 5 }), 1);
  });
});
