'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  closeUnpublished, needsClosing, parseArgs
} = require('../../src/scripts/close-unpublished-track-projects');
const { SECURE_ROLES } = require('../../src/helpers/access-sql');

const NOW = '2026-08-23T00:00:00.000Z';
const PUBLIC_ACL = ['public', ...SECURE_ROLES];

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

const TRACK_ONLY = { id: '354', name: 'Surrey Langley SkyTrain', eagleId: null, read: PUBLIC_ACL };
const TRACK_LINKED = {
  id: '207', name: 'Nicomen Wind Energy', eagleId: '58851172aaecd9001b820335', read: PUBLIC_ACL
};
const EAGLE_ONLY = {
  id: 'eagle-6a59234357be6fca20a489dc', name: 'testtesttest',
  eagleId: '6a59234357be6fca20a489dc', read: PUBLIC_ACL
};
const ALREADY_CLOSED = { id: '360', name: 'Berg Mine', eagleId: null, read: [...SECURE_ROLES] };

test('needsClosing selects on the Eagle counterpart, not on provenance', async (t) => {
  await t.test('a Track project with no Eagle counterpart, currently public', () => {
    assert.strictEqual(needsClosing(TRACK_ONLY), true);
  });

  await t.test('a Track project WITH an Eagle counterpart is left alone', () => {
    // Eagle published it, so Eagle's read[] is the authority and the merge already preserved it.
    assert.strictEqual(needsClosing(TRACK_LINKED), false);
  });

  await t.test('an Eagle-only project is left alone', () => {
    // It always carries an eagleId by construction (merge/project.js:227), so it can never match.
    // This is the row set the PROVENANCE filter handles; conflating the two would unpublish every
    // project Eagle holds that Track has not caught up with.
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
      projects: fakeProjects([TRACK_ONLY, TRACK_LINKED, EAGLE_ONLY, ALREADY_CLOSED]),
      documents: fakeDocuments(),
      patch: patch.fn,
      now: NOW
    });

    assert.strictEqual(summary.scanned, 4);
    assert.strictEqual(summary.matched, 1, 'only the Track-only public row');
    assert.strictEqual(summary.closed, 1);
    assert.strictEqual(patch.calls.length, 1);

    const { id, ops } = patch.calls[0];
    assert.strictEqual(id, '354');
    assert.deepStrictEqual(ops, [
      { op: 'set', path: '/read', value: [...SECURE_ROLES] },
      { op: 'set', path: '/isPublished', value: false },
      { op: 'set', path: '/updatedAt', value: NOW }
    ]);
    assert.ok(!ops[0].value.includes('public'), 'public is what this script exists to remove');
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
    const other = { id: '355', name: 'Kimberley Water Reclamation Centre', eagleId: null, read: PUBLIC_ACL };
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
