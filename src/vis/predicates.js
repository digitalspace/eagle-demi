'use strict';

/**
 * Catalog `when` predicates, taking `(record)` only. A true predicate WIDENS its field to `maxVis`
 * and never narrows one, and a dial beats it (docs/rbac-architecture.md §2 item 7).
 */
module.exports = {
  cacPublished: (record) => record.projectCACPublished === true,

  // `=== false`, NOT `!== true`: `isAnonymous` defaults to TRUE in the Eagle model, so a row that
  // never set it is anonymous — and `!== true` is true for `undefined`, which would publish the
  // name on exactly those comments.
  commentAttributed: (record) => record.isAnonymous === false,

  // eagle-api governs pinned-proponent visibility with the project's own `pinsRead[]` and IGNORES
  // the organization-level `read` (controllers/pins.js), so neither the project ACL nor the
  // organization's says whether `pins` is public. This is the only thing that does.
  pinsPublished: (record) => Array.isArray(record.pinsRead) && record.pinsRead.includes('public')
};
