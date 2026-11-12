'use strict';

/**
 * A Cosmos upsert replaces the whole item, so two writers on one revision lose an update silently.
 * The `_etag` guard turns that into a 412; the answer is to re-read and rebuild from what is stored.
 */

/** Past this many lost races the caller gets a conflict, never a row built from a stale revision. */
const ETAG_WRITE_TRIES = 3;

/** 409 (created behind us) and 412 (etag moved) both mean: somebody else wrote this row. */
const raced = (err) => [409, 412].includes(err.code || err.statusCode);

/**
 * @param {object} options
 * @param {object|null} options.existing the row the first build read, `null` when there is none
 * @param {() => Promise<object|null>} options.reread fetches the stored row again after a loss
 * @param {(current: object|null, attempt: number) => Promise<object>} options.attempt writes guarded on `current._etag`; throws `code` 412 or 409 on a lost race
 * @param {(current: object|null, attempt: number) => void} [options.onLost] called per lost race, for the log line only
 * @returns {Promise<object>} whatever `attempt` returned, or `{ status: 'conflict' }` when every try lost
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
