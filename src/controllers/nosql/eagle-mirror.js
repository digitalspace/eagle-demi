'use strict';

/**
 * The parts every `PUT /eagle/*` mirror shares. eagle-api pushes fire-and-forget on every write it
 * makes, keyed by its own `_id`, and the body carries the RAW Eagle record.
 */

/** `{ eagleId, doc }`, or null when the body does not agree with the path. */
function eaglePush(req) {
  const eagleId = String(req.params.eagleId);
  const doc = req.body && req.body.doc;
  if (!doc || String(doc._id || '') !== eagleId) return null;
  return { eagleId, doc };
}

/** 409 (created behind us) and 412 (etag moved) both mean: somebody else wrote this row. */
const raced = (err) => [409, 412].includes(err.code || err.statusCode);

/**
 * Write the row, and re-read then re-write once if another push got in between. `build(existing)`
 * is re-run against the fresh row, so anything carried across from it is carried from the value
 * that is actually stored rather than the one this request read first.
 */
async function upsertWithRetry(repo, build, readExisting) {
  let existing = await readExisting();
  try {
    return { saved: await repo.upsert(build(existing), existing), existing };
  } catch (err) {
    if (!raced(err)) throw err;
    existing = await readExisting();
    return { saved: await repo.upsert(build(existing), existing), existing };
  }
}

/** The Mongo `ObjectId | { _id }` a populated Eagle reference arrives as, as a string or null. */
function refId(value) {
  if (!value) return null;
  return String((typeof value === 'object' && value._id) || value) || null;
}

module.exports = { eaglePush, raced, upsertWithRetry, refId };
