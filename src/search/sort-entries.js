'use strict';

// The projects map sends `sortBy=&sortBy=` on every call; a truthiness test would read that as an
// order and move a million-row list read onto the AI Search path.
function sortEntries(sortBy) {
  return (Array.isArray(sortBy) ? sortBy : [sortBy])
    .filter(s => typeof s === 'string' && s.trim() !== '')
    .flatMap(s => s.split(','))
    .map(s => s.trim())
    .filter(Boolean);
}

module.exports = { sortEntries };
