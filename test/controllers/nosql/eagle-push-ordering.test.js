'use strict';

/**
 * `pushedAt` ordering on the five mirrors that share `upsertWithRetry` — periods, comments,
 * organizations, updates, notifications. The project and document mirrors have the same rule and
 * are covered in their own race suites, which already hold the etag harness.
 *
 * The etag guard makes a lost race safe but not ordered: two eagle-api pods push one record, and
 * the older body can read the winner's row, rebuild cleanly and land last. Eagle then holds one
 * version of the record and DEMI holds the one before it, with nothing that looks wrong.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const comments = require('../../../src/repositories/comments');
const { logger } = require('../../../src/utils/logger');
const { MIRRORS, captureMirror, storedStamped } = require('../../helpers/eagle-mirror-fixtures');

/** Two stamps eagle-api could have sent, oldest first, a clear gap apart. */
const OLDER = 1757980000000;
const NEWER = 1757980005000;

const entities = Object.keys(MIRRORS);

test('a push older than the one already stored is ignored, on every mirror', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  for (const entity of entities) {
    await t.test(entity, async () => {
      const logged = [];
      t.mock.method(logger, 'info', (message, meta) => logged.push({ message, meta }));

      const { res, row } = await captureMirror(t, entity, null,
        { existing: storedStamped(entity, NEWER), pushedAt: OLDER });

      // 200, not a 5xx: eagle-api's push client re-sends a 5xx, and there is nothing to send again.
      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.body, { ok: true, ignored: 'stale', eaglePushedAt: NEWER });
      assert.strictEqual(row, undefined, 'the stale body was written over the newer one');
      assert.strictEqual(logged.filter(line => /ignored/.test(line.message)).length, 1,
        'a push dropped on the floor with nothing in the log is not debuggable');
    });
  }
});

test('a newer push writes, and stores the stamp it was ordered by', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  // The period mirror re-derives its comments whenever the level moves; it does not here, but the
  // repository must never be reached from a test either way.
  t.mock.method(comments, 'setAclForPeriod', async () => ({ succeeded: 0, failed: 0, rows: [] }));

  for (const entity of entities) {
    await t.test(entity, async () => {
      const { res, row } = await captureMirror(t, entity, null,
        { existing: storedStamped(entity, OLDER), pushedAt: NEWER });

      assert.strictEqual(res.statusCode, 200);
      assert.ok(row, 'the newer push has to land');
      assert.strictEqual(row.eaglePushedAt, NEWER,
        'without the stamp on the row the next push has nothing to be ordered against');
    });
  }
});

test('a push one millisecond older than the stored stamp is ignored', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  for (const entity of entities) {
    await t.test(entity, async () => {
      const { res, row } = await captureMirror(t, entity, null,
        { existing: storedStamped(entity, NEWER), pushedAt: NEWER - 1 });

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.body, { ok: true, ignored: 'stale', eaglePushedAt: NEWER });
      assert.strictEqual(row, undefined, 'no tolerance: one millisecond older still loses');
    });
  }
});

test('a push equal to the stored stamp writes', async (t) => {
  // Same pod, same millisecond — it ordered the writes itself, so this one is not stale.
  t.afterEach(() => t.mock.restoreAll());
  t.mock.method(comments, 'setAclForPeriod', async () => ({ succeeded: 0, failed: 0, rows: [] }));

  for (const entity of entities) {
    await t.test(entity, async () => {
      const { res, row } = await captureMirror(t, entity, null,
        { existing: storedStamped(entity, NEWER), pushedAt: NEWER });

      assert.strictEqual(res.statusCode, 200);
      assert.ok(row, 'an equal stamp has to be able to write');
      assert.strictEqual(row.eaglePushedAt, NEWER);
    });
  }
});

test('a push that keeps losing its race asks to be sent again', async (t) => {
  // eagle-api's push client retries a 500-and-up and gives up on everything below it
  // (eagle-api api/helpers/pushClient.js), so anything under 500 here would drop the push on the
  // floor and leave DEMI holding the pre-push record with nothing to say so.
  t.afterEach(() => t.mock.restoreAll());
  t.mock.method(logger, 'warn', () => {});

  for (const entity of entities) {
    await t.test(entity, async () => {
      const { res, row, writes } = await captureMirror(t, entity, null,
        { existing: storedStamped(entity, OLDER), pushedAt: NEWER, losses: Infinity });

      assert.strictEqual(res.statusCode, 503);
      assert.deepStrictEqual(res.body, {
        error: 'The record is being written by another request. Push it again.'
      });
      assert.strictEqual(row, undefined);
      assert.strictEqual(writes(), 3, 'the retry bound is what stops this spinning');
    });
  }
});

test('a push carrying no stamp writes, and leaves the stored one alone', async (t) => {
  // An eagle-api build that predates the field. It cannot be ordered, so it is applied as it
  // arrives — but clearing the stamp would unorder every push behind it too.
  t.afterEach(() => t.mock.restoreAll());
  t.mock.method(comments, 'setAclForPeriod', async () => ({ succeeded: 0, failed: 0, rows: [] }));

  for (const entity of entities) {
    await t.test(entity, async () => {
      const { res, row } = await captureMirror(t, entity, null,
        { existing: storedStamped(entity, NEWER) });

      assert.strictEqual(res.statusCode, 200);
      assert.ok(row, 'a client that sends no stamp still has to be able to write');
      assert.strictEqual(row.eaglePushedAt, NEWER);
    });
  }
});
