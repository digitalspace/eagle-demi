'use strict';

/**
 * The staff-side Eagle fields the comment, comment-period and organization mirrors promote: staff
 * read them, anonymous callers do not, and what anonymous callers already read does not move.
 *
 * Each row is captured from the real mirror and redacted with real resolved access, so a field the
 * mirror stops writing, or a catalog entry that widens, fails here.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { redactForAccess } = require('../../src/vis/redact');
const {
  captureMirror, anonymous, staff, eagleComment,
  STAFF_PERIOD_FIELDS, STAFF_COMMENT_FIELDS, STAFF_ORGANIZATION_FIELDS
} = require('../helpers/eagle-mirror-fixtures');

const STAFF_FIELDS = {
  commentPeriods: STAFF_PERIOD_FIELDS,
  comments: STAFF_COMMENT_FIELDS,
  lists: STAFF_ORGANIZATION_FIELDS
};

function without(row, keys) {
  const copy = { ...row };
  for (const k of keys) delete copy[k];
  return copy;
}

test('staff-side Eagle fields reach staff only', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  for (const [entity, fields] of Object.entries(STAFF_FIELDS)) {
    const keys = Object.keys(fields);

    await t.test(`${entity}: staff read every one, as Eagle sent it`, async () => {
      const { row } = await captureMirror(t, entity);
      const out = redactForAccess(entity, row, staff());

      assert.deepStrictEqual(Object.fromEntries(keys.map(k => [k, out[k]])), { ...fields });
    });

    await t.test(`${entity}: an anonymous caller reads none of them`, async () => {
      const { row } = await captureMirror(t, entity);

      assert.deepStrictEqual(keys.filter(k => k in redactForAccess(entity, row, anonymous())), []);
    });

    await t.test(`${entity}: anonymous output is the same bytes as before the fields existed`,
      async () => {
        const { row } = await captureMirror(t, entity);
        const before = JSON.stringify(redactForAccess(entity, without(row, keys), anonymous()));

        assert.strictEqual(JSON.stringify(redactForAccess(entity, row, anonymous())), before);
        assert.ok(before.length > 2, 'an empty response would match itself');
      });
  }

  await t.test('an anonymous comment keeps its author from the public, with or without the fields',
    async () => {
      const { row } = await captureMirror(t, 'comments', eagleComment({ isAnonymous: true }));

      assert.ok(!('author' in redactForAccess('comments', row, anonymous())));
      assert.strictEqual(redactForAccess('comments', row, staff()).author, 'Jane Public');
    });
});
