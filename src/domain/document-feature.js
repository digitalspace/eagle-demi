'use strict';

// Featured-document cap from eagle-api `document.js:838-849`, checked on PUT /documents/:id.
// An Eagle push is not checked: Eagle stays the writer until the flip.

/** True when `changes` turn `isFeatured` on for a `row` that is not featured yet. */
function featuresDocument(row, changes) {
  return changes.isFeatured === true && row.isFeatured !== true;
}

/** The 409 body when the project's `featured` other documents already fill `max`, else null. */
function capRefusal(featured, max) {
  if (featured < max) return null;
  return {
    error: `A project can have at most ${max} featured documents. Unfeature one first.`,
    limit: max
  };
}

module.exports = { featuresDocument, capRefusal };
