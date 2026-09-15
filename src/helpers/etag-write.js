'use strict';

/**
 * The retry loop behind every whole-item write that is guarded on the row's revision.
 *
 * A Cosmos upsert REPLACES the item from a snapshot, so two writers that read the same revision
 * both win and the slower one silently undoes the faster one. Carrying the `_etag` into the write
 * turns that into a 412, and the only honest answer to a 412 is to read the row again and rebuild
 * from what is actually stored — which is what this does.
 */

/**
 * How many times a guarded write rebuilds and re-sends after losing its race.
 *
 * Each loss means another writer landed, so the answer is a rebuild off the row that stored. A
 * fourth loss is contention this request cannot win, and the caller is told so rather than handed
 * a row built from a revision that is already gone.
 */
const ETAG_WRITE_TRIES = 3;

/** 409 (created behind us) and 412 (etag moved) both mean: somebody else wrote this row. */
const raced = (err) => [409, 412].includes(err.code || err.statusCode);

/**
 * @param {object} options
 * @param {object|null} options.existing the row the first build read, `null` when there is none
 * @param {() => Promise<object|null>} options.reread fetches the stored row again after a loss
 * @param {(current: object|null, attempt: number) => Promise<object>} options.attempt builds and
 *   writes from whatever is stored now, guarded on `current._etag`. It must throw an error with
 *   `code` 412 (the row moved) or 409 (a row this build read as absent was created behind it), and
 *   return an object carrying its own `status`.
 * @param {(current: object|null, attempt: number) => void} [options.onLost] called per lost race,
 *   for the log line only.
 * @returns {Promise<object>} whatever `attempt` returned, or `{ status: 'conflict' }` when every
 *   try lost.
 */
async function writeGuarded({ existing, reread, attempt, onLost }) {
  let current = existing;

  for (let tryNumber = 1; tryNumber <= ETAG_WRITE_TRIES; tryNumber++) {
    try {
      return await attempt(current, tryNumber);
    } catch (err) {
      if (!raced(err)) throw err;
      if (onLost) onLost(current, tryNumber);
      // Not on the last try: there is nothing left to rebuild for, and a read costs RU.
      if (tryNumber < ETAG_WRITE_TRIES) current = await reread();
    }
  }

  return { status: 'conflict' };
}

module.exports = { writeGuarded, raced };
