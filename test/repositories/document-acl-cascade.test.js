'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const documents = require('../../src/repositories/documents');
const cosmos = require('../../src/db/cosmos-nosql');
const { systemAccess } = require('../../src/helpers/access-sql');

// The stored legacy ACLs, spelled out. Building them from a constant would pass against any value
// of that constant, including one that no longer contains `staff`.
const PUBLIC_PROJECT = ['public', 'sysadmin', 'staff', 'demi-admin'];
const PRIVATE_PROJECT = ['sysadmin', 'staff', 'demi-admin'];

/** Mock the partition read, capture the bulk write. Returns the operations the cascade planned. */
function harness(tt, rows) {
  const captured = { ops: null };
  tt.mock.method(cosmos, 'query', async () => ({ items: rows, continuationToken: undefined }));
  tt.mock.method(cosmos, 'bulkVerified', async (container, operations) => {
    captured.ops = operations;
    return { succeeded: operations.length, failed: 0, statusCounts: {}, requestCharge: 1 };
  });
  return captured;
}

/** The value a planned patch would write to one path. */
function opValue(operation, path) {
  const op = operation.resourceBody.operations.find(o => o.path === path);
  return op && op.value;
}

test('constrainToProject — the lower of the two levels', async (t) => {
  await t.test('two level-4 ACLs stay at level 4', () => {
    assert.deepStrictEqual(
      documents.constrainToProject(['public', 'staff', 'project-team'], ['public', 'staff']),
      ['staff', 'idir', 'public']);
  });

  await t.test('a narrower document stays narrow under a public project', () => {
    // The whole point. Assignment would have widened this to the project's array.
    assert.deepStrictEqual(
      documents.constrainToProject(['sysadmin'], PUBLIC_PROJECT), ['team']);
  });

  await t.test('a legacy role name carries no level of its own', () => {
    // `project-team` is not a ladder token, so the document reads as level 1 and stays there —
    // stamping the project's level 2 over it would WIDEN the row.
    assert.deepStrictEqual(
      documents.constrainToProject(['project-team'], PRIVATE_PROJECT), ['team']);
  });

  await t.test('fail-closed under a level-1 project yields team', () => {
    // No project ACL is the case where the least is known — `levelOfRead([])` is 1.
    assert.deepStrictEqual(documents.constrainToProject(['public'], []), ['team']);
    assert.deepStrictEqual(documents.constrainToProject(['public'], undefined), ['team']);
  });

  await t.test('fail-closed under a public project yields team', () => {
    // A document with no ACL knows nothing about itself, and a project cannot supply that —
    // inheriting the parent's reach is exactly the widening this rule exists to stop.
    assert.deepStrictEqual(documents.constrainToProject([], PUBLIC_PROJECT), ['team']);
    assert.deepStrictEqual(documents.constrainToProject(undefined, PUBLIC_PROJECT), ['team']);
  });

  await t.test('a project move never widens a document', () => {
    // The three directions a cascade can run, with every ACL spelled out. None may raise the
    // document's level.
    assert.deepStrictEqual(documents.constrainToProject(['team'], ['staff']), ['team'],
      'project 1 -> 2 leaves a team document at team');
    assert.deepStrictEqual(
      documents.constrainToProject(['staff', 'idir', 'public'], ['staff']), ['staff'],
      'project 4 -> 2 caps a public document at staff');
    assert.deepStrictEqual(
      documents.constrainToProject(['staff'], ['staff', 'idir', 'public']), ['staff'],
      'project 2 -> 4 leaves a staff document at staff');
  });
});

test('setAclForProject', async (t) => {
  await t.test('does not widen a document that was independently narrower', async (tt) => {
    // Against a PUBLIC project, because that is the direction assignment goes wrong. The old code
    // stamped the project's array over the row and this document became public.
    const cap = harness(tt, [{ id: 'd1', read: ['sysadmin', 'staff'] }]);

    await documents.setAclForProject(systemAccess(), '207', PUBLIC_PROJECT);

    assert.deepStrictEqual(opValue(cap.ops[0], '/read'), ['staff'], 'level 2, as it already was');
    assert.strictEqual(opValue(cap.ops[0], '/isPublished'), false);
  });

  await t.test('a document Eagle restricted to a project team is not opened to the project ACL',
    async (tt) => {
      // `project-team` is a real role the seed preserves verbatim from Eagle
      // (`seed/transform.js`), and it is in neither the project's ACL nor PUBLIC_ROLES.
      const cap = harness(tt, [{ id: 'd1', read: ['project-team'] }]);

      await documents.setAclForProject(systemAccess(), '207', PRIVATE_PROJECT);

      assert.deepStrictEqual(opValue(cap.ops[0], '/read'), ['team']);
    });

  await t.test('captures ownRead on the first cascade', async (tt) => {
    // No backfill exists, so the first cascade over a seeded row is what preserves its Eagle ACL.
    const cap = harness(tt, [{ id: 'd1', read: ['public', 'sysadmin'] }]);

    await documents.setAclForProject(systemAccess(), '207', PRIVATE_PROJECT);

    assert.deepStrictEqual(opValue(cap.ops[0], '/ownRead'), ['public', 'sysadmin'],
      'the value BEFORE narrowing — capturing the narrowed one would be a one-way ratchet');
    assert.ok(!opValue(cap.ops[0], '/read').includes('public'));
  });

  await t.test('a round trip restores exactly what the document had', async (tt) => {
    // ONE cascade cannot expose a ratchet — the snapshot and the live value are still equal after
    // it. Only the second re-derivation shows whether `ownRead` was preserved or overwritten, so a
    // single unpublish is a probe that cannot fail.
    const down = harness(tt, [{ id: 'd1', read: ['public', 'sysadmin'] }]);
    await documents.setAclForProject(systemAccess(), '207', PRIVATE_PROJECT);

    const afterDown = {
      id: 'd1',
      read: opValue(down.ops[0], '/read'),
      ownRead: opValue(down.ops[0], '/ownRead')
    };
    assert.ok(!afterDown.read.includes('public'), 'unpublished in between');

    const up = harness(tt, [afterDown]);
    await documents.setAclForProject(systemAccess(), '207', PUBLIC_PROJECT);

    assert.deepStrictEqual(opValue(up.ops[0], '/read'), ['staff', 'idir', 'public'],
      'the document comes back to the level it started at, no wider and no narrower');
    assert.strictEqual(opValue(up.ops[0], '/isPublished'), true);
  });

  await t.test('a re-publish does NOT publish a document that was never public', async (tt) => {
    // The invariant the old unpublish-only trigger protected by never running. It now has to hold
    // by formula, because the cascade runs in both directions.
    const cap = harness(tt, [{ id: 'd1', read: ['sysadmin'], ownRead: ['sysadmin'] }]);

    await documents.setAclForProject(systemAccess(), '207', PUBLIC_PROJECT);

    assert.deepStrictEqual(opValue(cap.ops[0], '/read'), ['team']);
    assert.strictEqual(opValue(cap.ops[0], '/isPublished'), false);
  });

  await t.test('the stored ownRead wins over the live read', async (tt) => {
    // Reading `read` on a row that already has a snapshot is what makes the cascade lossy: the
    // live value is whatever the LAST cascade narrowed it to.
    const cap = harness(tt, [{ id: 'd1', read: ['sysadmin'], ownRead: ['public', 'sysadmin'] }]);

    await documents.setAclForProject(systemAccess(), '207', PUBLIC_PROJECT);

    assert.deepStrictEqual(opValue(cap.ops[0], '/read'), ['staff', 'idir', 'public'],
      'the snapshot is level 4, the live value level 1 — reading the live one would lose the row');
  });

  await t.test('every row is patched in one request, pinned to the project partition',
    async (tt) => {
      const cap = harness(tt, [
        { id: 'd1', read: ['public'] }, { id: 'd2', read: ['sysadmin'] }, { id: 'd3', read: [] }
      ]);

      const result = await documents.setAclForProject(systemAccess(), '207', PUBLIC_PROJECT);

      assert.strictEqual(cap.ops.length, 3);
      assert.ok(cap.ops.every(o => o.partitionKey === '207'), 'one partition, one bulk request');
      assert.ok(cap.ops.every(o => o.operationType === 'Patch'));
      assert.deepStrictEqual(result.ids, ['d1', 'd2', 'd3']);
      assert.deepStrictEqual(opValue(cap.ops[2], '/read'), ['team'],
        'a row with no ACL at all still fails closed rather than being skipped');
    });

  await t.test('a row with NO read field serialises a valid patch', async (tt) => {
    // Not `read: []` — the field ABSENT. `undefined` in a `set` op emits no `value` key at all,
    // and Cosmos rejects that. Patch ops are atomic per item, so the 400 would take the `/read`
    // narrowing down with it: the row keeps its old ACL, and the effect is fail-OPEN for exactly
    // the row that had no ACL to begin with.
    const cap = harness(tt, [{ id: 'd1' }]);

    await documents.setAclForProject(systemAccess(), '207', PUBLIC_PROJECT);

    // Asserted on the SERIALISED form, because that is where the defect shows. `{value: undefined}`
    // still satisfies `'value' in op` — the key exists on the object — and only JSON.stringify
    // drops it. Checking the object would be a probe that cannot fail.
    const wire = JSON.parse(JSON.stringify(cap.ops[0].resourceBody.operations));
    for (const op of wire) {
      assert.ok('value' in op, `${op.path} reaches Cosmos with no value key, which is a 400`);
    }
    assert.deepStrictEqual(opValue(cap.ops[0], '/read'), ['team'], 'and it still fails closed');
  });

  await t.test('an empty project writes nothing', async (tt) => {
    const cap = harness(tt, []);
    const result = await documents.setAclForProject(systemAccess(), '999', PUBLIC_PROJECT);
    assert.strictEqual(cap.ops, null, 'no documents, no bulk request');
    assert.deepStrictEqual(result.ids, []);
  });

  await t.test('an empty project ACL is refused outright', async (tt) => {
    harness(tt, [{ id: 'd1', read: ['public'] }]);
    await assert.rejects(
      () => documents.setAclForProject(systemAccess(), '207', []), /non-empty read/);
  });
});

/** Capture the patch operations one setPublished call would send. */
function capturePatch(tt) {
  const captured = { ops: null };
  tt.mock.method(cosmos, 'patch', async (container, id, pk, operations) => {
    captured.ops = operations;
    return {};
  });
  return captured;
}

const patchValue = (ops, path) => ops.find(o => o.path === path).value;

test('setPublished moves ownRead with it', async (t) => {
  await t.test('a per-document unpublish updates the snapshot too', async (tt) => {
    // Without this, the next project re-publish re-derives from a stale snapshot and RESURRECTS a
    // document an operator individually unpublished.
    const cap = capturePatch(tt);

    await documents.setPublished('d1', '207', 2);

    const read = patchValue(cap.ops, '/read');
    assert.deepStrictEqual(patchValue(cap.ops, '/ownRead'), read,
      'the deliberate decision becomes the document\'s own ACL');
    assert.deepStrictEqual(read, ['staff'], 'unpublishing lands the row at level 2');
  });

  await t.test('and a per-document publish does the same', async (tt) => {
    const cap = capturePatch(tt);

    await documents.setPublished('d1', '207', 4);

    assert.deepStrictEqual(patchValue(cap.ops, '/ownRead'), ['staff', 'idir', 'public'],
      'publishing lands it at level 4');
  });
});

test('setPublished writes the requested level', async (t) => {
  // The middle rungs, which the 4/2 pair above cannot reach. A body that derived the ACL from
  // publication state rather than from `level` would fail here and nowhere else.
  await t.test('level 1 is team only', async (tt) => {
    const cap = capturePatch(tt);

    await documents.setPublished('d1', '207', 1);

    assert.deepStrictEqual(patchValue(cap.ops, '/read'), ['team']);
    assert.deepStrictEqual(patchValue(cap.ops, '/ownRead'), ['team']);
    assert.strictEqual(patchValue(cap.ops, '/isPublished'), false);
  });

  await t.test('level 3 is staff and idir', async (tt) => {
    const cap = capturePatch(tt);

    await documents.setPublished('d1', '207', 3);

    assert.deepStrictEqual(patchValue(cap.ops, '/read'), ['staff', 'idir']);
    assert.deepStrictEqual(patchValue(cap.ops, '/ownRead'), ['staff', 'idir']);
    assert.strictEqual(patchValue(cap.ops, '/isPublished'), false);
  });

  await t.test('a level outside the ladder writes nothing', async (tt) => {
    const cap = capturePatch(tt);
    await assert.rejects(() => documents.setPublished('d1', '207', 5), /not a ladder level/);
    assert.strictEqual(cap.ops, null);
  });
});

// The caller writes the same ACLs into the search index, so the cascade has to report what it
// derived. Re-deriving them at the call site would be a second implementation of the rule above,
// free to drift from this one.
test('setAclForProject reports the ACLs it derived', async (t) => {
  await t.test('one row per document, carrying the derived ACL and its mirror', async (tt) => {
    harness(tt, [
      { id: 'd1', read: ['public', 'sysadmin'] },
      { id: 'd2', read: ['sysadmin', 'project-team'] }
    ]);

    const result = await documents.setAclForProject(systemAccess(), '207', PUBLIC_PROJECT);

    assert.deepStrictEqual(result.rows, [
      { id: 'd1', read: ['staff', 'idir', 'public'], isPublished: true },
      // Narrower than its project and it stays that way — so the index must NOT be told the
      // project's ACL for this row.
      { id: 'd2', read: ['team'], isPublished: false }
    ]);
    assert.deepStrictEqual(result.ids, ['d1', 'd2']);
  });

  await t.test('a project with no documents reports no rows', async (tt) => {
    harness(tt, []);
    const result = await documents.setAclForProject(systemAccess(), '207', PRIVATE_PROJECT);
    assert.deepStrictEqual(result.rows, []);
  });
});
