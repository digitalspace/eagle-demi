'use strict';

// Accepts a string, a repeated `sortBy` array, or one comma-joined value. eagle-public sends it twice,
// often one empty; a truthiness test would read that as an order and use the AI Search path.
function sortEntries(sortBy) {
  return (Array.isArray(sortBy) ? sortBy : [sortBy])
    .filter(s => typeof s === 'string' && s.trim() !== '')
    .flatMap(s => s.split(','))
    .map(s => s.trim())
    .filter(Boolean);
}

module.exports = { sortEntries };
