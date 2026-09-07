'use strict';

/**
 * Two fields whose ACL says nothing about them, so only the redactor can withhold them.
 *
 * `comments.author` is the submitter's name on a PUBLISHED comment: the row is public, and whether
 * the name is depends on `isAnonymous`. `projects.pins` is the pinned-proponent list: eagle-api
 * ignores the organization's own `read` and governs it with the project's `pinsRead[]`
 * (api/controllers/pins.js), so a public project does not imply public pins.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { redactForAccess } = require('../../src/vis/redact');

const ANONYMOUS = { level: 4, roles: ['public'] };
const STAFF = { level: 2, roles: ['staff'] };

function comment(overrides = {}) {
  return {
    id: '5b8bcf0d0f5e9c0019a7a1c2',
    periodId: '5b8bcf0d0f5e9c0019a7a1c1',
    projectId: '207',
    author: 'Jane Public',
    comment: 'The turbine setback is too small.',
    isAnonymous: false,
    eaoStatus: 'Published',
    isPublished: true,
    read: ['staff', 'idir', 'public'],
    ...overrides
  };
}

function project(overrides = {}) {
  return {
    id: '207',
    name: 'Nicomen Wind Energy',
    pins: [{ _id: '5cf00c03a266b7e187750001', name: 'Some Nation', province: 'BC' }],
    pinsRead: ['public'],
    isPublished: true,
    read: ['staff', 'idir', 'public'],
    ...overrides
  };
}

test('a comment author is withheld unless the comment is attributed', async (t) => {
  await t.test('an anonymous comment carries no name', () => {
    const out = redactForAccess('comments', comment({ isAnonymous: true }), ANONYMOUS);

    assert.ok(!('author' in out), 'the name must not reach an anonymous caller');
    assert.strictEqual(out.comment, 'The turbine setback is too small.',
      'the comment itself still does — otherwise this passes on an empty response');
  });

  await t.test('a comment with no isAnonymous at all carries no name either', () => {
    // The Eagle model defaults it to true, so absence means anonymous. `!== true` would publish it.
    const row = comment();
    delete row.isAnonymous;

    assert.ok(!('author' in redactForAccess('comments', row, ANONYMOUS)));
  });

  await t.test('an attributed comment carries the name', () => {
    const out = redactForAccess('comments', comment(), ANONYMOUS);

    assert.strictEqual(out.author, 'Jane Public');
  });

  await t.test('staff keep the attribution either way', () => {
    // The EAO needs to know who wrote an anonymous comment; the public does not.
    assert.strictEqual(
      redactForAccess('comments', comment({ isAnonymous: true }), STAFF).author, 'Jane Public');
  });

  await t.test('no response carries the ACL or the raw Eagle record', () => {
    const out = redactForAccess('comments',
      comment({ sources: { eagle: { author: 'Jane Public', eaoNotes: 'staff only' } } }), ANONYMOUS);

    assert.ok(!('read' in out));
    assert.ok(!('sources' in out));
  });
});

test('project pins are withheld unless pinsRead says public', async (t) => {
  await t.test('a public project with unpublished pins carries none', () => {
    const out = redactForAccess('projects', project({ pinsRead: ['sysadmin', 'staff'] }), ANONYMOUS);

    assert.ok(!('pins' in out), 'the project ACL must not be what publishes pins');
    assert.strictEqual(out.name, 'Nicomen Wind Energy', 'the rest of the project still renders');
  });

  await t.test('a project with no pinsRead at all carries none', () => {
    const row = project();
    delete row.pinsRead;

    assert.ok(!('pins' in redactForAccess('projects', row, ANONYMOUS)));
  });

  await t.test('pinsRead including public is what publishes them', () => {
    const out = redactForAccess('projects', project(), ANONYMOUS);

    assert.deepStrictEqual(out.pins,
      [{ _id: '5cf00c03a266b7e187750001', name: 'Some Nation', province: 'BC' }]);
  });

  await t.test('pinsRead itself is never returned', () => {
    assert.ok(!('pinsRead' in redactForAccess('projects', project(), ANONYMOUS)));
    assert.ok(!('pinsRead' in redactForAccess('projects', project(), STAFF)));
  });
});
