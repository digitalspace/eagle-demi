'use strict';

/**
 * Eagle -> Track spelling of a project type. DEMI stores both, so a filter on either matches both.
 * See wiki Search-Index-Reference#project-type-spellings.
 */
const PROJECT_TYPE_SPELLINGS = Object.freeze({
  'Energy-Electricity': 'Energy - Electricity',
  'Energy-Petroleum & Natural Gas': 'Energy - Petroleum & Natural Gas',
  'Tourist Destination Resorts': 'Tourist Destination Resort'
});

/** `value`, then its other spelling in `pairs` from either side; an unlisted value comes back alone. */
function spellingsOf(pairs, value) {
  for (const [eagle, track] of Object.entries(pairs || {})) {
    if (eagle === track) continue;
    if (value === eagle) return [value, track];
    if (value === track) return [value, eagle];
  }
  return [value];
}

module.exports = { PROJECT_TYPE_SPELLINGS, spellingsOf };
