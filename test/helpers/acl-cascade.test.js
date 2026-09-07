'use strict';

/**
 * The engagement ACL rule — `helpers/acl-cascade.deriveAcls`.
 *
 * Comment periods and comments are mirrored rows: the push stores the RAW Eagle record beside the
 * row, and `read` on the row itself has already been narrowed to whatever the parent was at push
 * time. So the row's own ACL is `sources.eagle.read` (projected as `eagleRead`), and the live
 * `read` is only a fallback for a row that has no raw copy. Deriving from `read` alone is a
 * one-way ratchet: a period pushed under a private project would stay private forever.
 *
 * Pure function, so this is the cheapest place the rule can be pinned. The wiring that carries it
 * from a project publish down to the comments is in
 * test/controllers/nosql/engagement-cascade.test.js.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { deriveAcls } = require('../../src/helpers/acl-cascade');

// Spelled out, not built from readForLevel: an ACL derived from the same helper the code under
// test uses would agree with any value that helper ever returns.
const PUBLIC_PARENT = ['staff', 'idir', 'public'];
const STAFF_PARENT = ['staff'];
// What a project ACL looked like before the ladder — still on rows the seed wrote.
const LEGACY_PUBLIC_PARENT = ['public', 'sysadmin', 'staff', 'demi-admin'];

test('deriveAcls — the raw Eagle ACL is the row\'s own', async (t) => {
  await t.test('a period Eagle published but the mirror stored private goes public', () => {
    // The bug this exists for: the period was pushed while its project was private, so `read` says
    // staff. The engagement tab of a freshly published project rendered empty.
    assert.deepStrictEqual(
      deriveAcls([{ id: 'cp1', read: ['staff'], eagleRead: ['public'] }], PUBLIC_PARENT),
      [{ id: 'cp1', read: PUBLIC_PARENT, isPublished: true }]);
  });

  await t.test('and the same row goes private again on a takedown', () => {
    assert.deepStrictEqual(
      deriveAcls([{ id: 'cp1', read: PUBLIC_PARENT, eagleRead: ['public'] }], STAFF_PARENT),
      [{ id: 'cp1', read: STAFF_PARENT, isPublished: false }]);
  });

  await t.test('a round trip lands the row exactly where it started', () => {
    // One direction alone cannot show a ratchet — only re-deriving from what the last cascade wrote
    // does. `eagleRead` is untouched by a cascade, which is what makes the second pass recoverable.
    const [down] = deriveAcls([{ id: 'cp1', read: PUBLIC_PARENT, eagleRead: ['public'] }],
      STAFF_PARENT);
    assert.ok(!down.read.includes('public'), 'private in between');

    assert.deepStrictEqual(
      deriveAcls([{ id: 'cp1', read: down.read, eagleRead: ['public'] }], PUBLIC_PARENT),
      [{ id: 'cp1', read: PUBLIC_PARENT, isPublished: true }]);
  });

  await t.test('a publish never widens a row Eagle itself kept private', () => {
    // It narrows, it does not assign. Stamping the project's ACL over the row would publish a
    // period Eagle never published.
    assert.deepStrictEqual(
      deriveAcls([{ id: 'cp2', read: ['staff'], eagleRead: ['staff', 'sysadmin'] }], PUBLIC_PARENT),
      [{ id: 'cp2', read: STAFF_PARENT, isPublished: false }]);
  });

  await t.test('the live read is used only when there is no raw Eagle record', () => {
    assert.deepStrictEqual(
      deriveAcls([{ id: 'c1', read: PUBLIC_PARENT }], LEGACY_PUBLIC_PARENT),
      [{ id: 'c1', read: PUBLIC_PARENT, isPublished: true }]);
  });

  await t.test('a row with neither ACL fails closed instead of inheriting its parent', () => {
    // Level 2. Inheriting the parent's reach is exactly the widening this rule exists to stop.
    assert.deepStrictEqual(
      deriveAcls([{ id: 'c1' }, { id: 'c2', read: [], eagleRead: [] }], PUBLIC_PARENT),
      [{ id: 'c1', read: STAFF_PARENT, isPublished: false },
        { id: 'c2', read: STAFF_PARENT, isPublished: false }]);
  });

  await t.test('a row Eagle deleted is not republished by its project', () => {
    // The raw Eagle copy of a deleted period still says `public` — it was published right up to
    // the delete — so deriving from it alone hands the row straight back to the public the next
    // time the project publishes. The flag is the only thing that says otherwise.
    assert.deepStrictEqual(
      deriveAcls([{ id: 'cp1', read: STAFF_PARENT, eagleRead: ['public'], isDeleted: true }],
        PUBLIC_PARENT),
      [{ id: 'cp1', read: STAFF_PARENT, isPublished: false }]);
  });

  await t.test('and a takedown still narrows it past the deleted ceiling', () => {
    // The ceiling is a ceiling, not an assignment: a level-1 parent still wins.
    assert.deepStrictEqual(
      deriveAcls([{ id: 'cp1', read: STAFF_PARENT, eagleRead: ['public'], isDeleted: true }],
        ['team']),
      [{ id: 'cp1', read: ['team'], isPublished: false }]);
  });

  await t.test('isDeleted false is an ordinary row', () => {
    assert.deepStrictEqual(
      deriveAcls([{ id: 'cp1', read: STAFF_PARENT, eagleRead: ['public'], isDeleted: false }],
        PUBLIC_PARENT),
      [{ id: 'cp1', read: PUBLIC_PARENT, isPublished: true }]);
  });

  await t.test('every row is derived, in the order it arrived', () => {
    assert.deepStrictEqual(
      deriveAcls([
        { id: 'a', eagleRead: ['public'] },
        { id: 'b', eagleRead: ['sysadmin'] },
        { id: 'c', eagleRead: ['public'] }
      ], PUBLIC_PARENT).map(r => r.id),
      ['a', 'b', 'c']);
  });
});
