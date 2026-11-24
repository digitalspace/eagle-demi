'use strict';

const { readForLevel, capRead } = require('../helpers/access-sql');

/**
 * A new document's ACL: level 1 (docs/rbac-architecture.md §1), capped at the parent's level.
 * EVERY document write path must go through this.
 */
function resolveDocumentAcl(parentProject) {
  const read = capRead(readForLevel(1), parentProject.read);

  // `published` is READ OFF the capped read[] — read[] is authoritative, isPublished mirrors it.
  return { published: read.includes('public'), read };
}

module.exports = { resolveDocumentAcl };
