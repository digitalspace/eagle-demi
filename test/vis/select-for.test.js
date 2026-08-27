'use strict';

/**
 * `selectFor` is defence in depth, not the policy: `redactForAccess` at the response boundary is
 * what enforces visibility, and a per-record dial can restrict below `maxVis` in ways a projection
 * cannot anticipate. What this buys is that a value the caller could never see does not leave
 * Cosmos (docs/rbac-architecture.md §2 item 1).
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { selectFor } = require('../../src/repositories/_sql');

test('selectFor projects by level', async (t) => {
  await t.test('level 0 projects everything', () => {
    assert.strictEqual(selectFor('projects', { level: 0 }, 'id'), '*');
  });

  await t.test('an anonymous projection omits the writer-only fields', () => {
    const select = selectFor('projects', { level: 4 }, 'id');

    assert.ok(!select.includes('c._etag'), '_etag has maxVis 2 and never reaches an anonymous read');
    assert.ok(select.includes('c.name'));
    assert.ok(select.includes('c.read'));
    assert.ok(select.includes('c.id'));
    // The dotted `sources.wildfire` projects its PARENT — the redactor narrows it back down.
    assert.ok(select.includes('c.sources'));
  });

  await t.test('a level 2 projection contains _etag', () => {
    assert.ok(selectFor('projects', { level: 2 }, 'id').includes('c._etag'));
  });

  await t.test('the projection always carries the ACL', () => {
    // Fails if a refactor drops the row-plane fields, which would blank `isPublished` for every
    // caller: the redactor derives it from `read[]`, so an unprojected ACL reads as "not published".
    for (const level of [1, 2, 3, 4]) {
      const select = selectFor('projects', { level }, 'id');
      assert.ok(select.includes('c.read'), `level ${level} must project the ACL`);
      assert.ok(select.includes('c.isPublished'), `level ${level} must project the mirror`);
      assert.ok(select.includes('c.vis'), `level ${level} must project the dial map`);
    }
  });

  await t.test('a missing level is treated as anonymous', () => {
    assert.strictEqual(selectFor('projects', {}, 'id'), selectFor('projects', { level: 4 }, 'id'));
  });

  await t.test('a null level projects as anonymous', () => {
    // `null <= maxVis` is true for every ceiling, so a level resolution that passes an
    // unrecognised value straight through projects at level 0's width — _etag included.
    const select = selectFor('projects', { level: null }, 'id');

    assert.strictEqual(select, selectFor('projects', { level: 4 }, 'id'));
    assert.ok(!select.includes('c._etag'), 'a bad level must fail closed, not open');
  });

  await t.test('a missing partition field throws', () => {
    assert.throws(() => selectFor('projects', { level: 4 }), /partition field/);
  });

  await t.test('an unknown entity throws rather than projecting everything', () => {
    assert.throws(() => selectFor('widgets', { level: 4 }, 'id'), /no field catalog/);
  });

  await t.test('an anonymous document projection omits s3Key and both ACLs', () => {
    const select = selectFor('documents', { level: 4 }, 'projectId');

    assert.ok(!select.includes('c.s3Key'), 'the object key has maxVis 0');
    assert.ok(!select.includes('c.ownRead'), 'the pre-cascade ACL has maxVis 0');
    assert.ok(!select.includes('c._etag'));
    assert.ok(select.includes('c.displayName'));
    assert.ok(select.includes('c.projectId'), 'the partition field is row-plane, always projected');
    assert.ok(select.includes('c.read'), 'the ACL feeds the derived isPublished');
  });

  await t.test('level 0 reads the whole document row', () => {
    assert.strictEqual(selectFor('documents', { level: 0 }, 'projectId'), '*');
  });
});
