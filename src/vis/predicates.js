'use strict';

/**
 * Catalog `when` predicates, taking `(record)` only. A true predicate WIDENS its field to `maxVis`
 * and never narrows one, and a dial beats it (docs/rbac-architecture.md §2 item 7).
 */
module.exports = {
  cacPublished: (record) => record.projectCACPublished === true,

  // `=== false`, not `!== true`: Eagle defaults `isAnonymous` to true, so an unset row is
  // anonymous and must not publish the name.
  commentAttributed: (record) => record.isAnonymous === false,

  // eagle-api decides pin visibility by the project's `pinsRead[]` and ignores the organization
  // `read`, so this is the only check that says whether `pins` is public.
  pinsPublished: (record) => Array.isArray(record.pinsRead) && record.pinsRead.includes('public')
};
