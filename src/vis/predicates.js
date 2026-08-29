'use strict';

/**
 * Catalog `when` predicates, taking `(record)` only. A true predicate WIDENS its field to `maxVis`
 * and never narrows one, and a dial beats it (docs/rbac-architecture.md §2 item 7).
 */
module.exports = {
  cacPublished: (record) => record.projectCACPublished === true
};
