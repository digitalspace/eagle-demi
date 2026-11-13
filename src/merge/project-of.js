'use strict';

// Project ids only, free of I/O at require, so pure modules can use them without pulling in Cosmos.

const eagleOnlyProjectId = (eagleId) => `eagle-${eagleId}`;

// Only a folded twin counts for its target, so a link-and-unlink by `eagleId` cannot take a twin's ids.
// A relinked twin without `foldedInto` counts as a second holder beside its Track row: that fails closed.
function projectOf(row) {
  const twin = typeof row.eagleId === 'string' && String(row.id) === eagleOnlyProjectId(row.eagleId);
  return String(twin && row.foldedInto !== undefined && row.foldedInto !== null ? row.foldedInto : row.id);
}

module.exports = { eagleOnlyProjectId, projectOf };
