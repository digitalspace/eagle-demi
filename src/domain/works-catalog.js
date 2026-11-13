'use strict';

// The works catalog: one stored item holding a list of `{code, name, aliases, acts, trackIds,
// eagleListId}` entries per vocabulary. Lookups on a missing catalog or list answer null.

const { normalizeName } = require('./phase-catalog');

const LISTS = Object.freeze(['workTypes', 'milestoneTypes', 'outcomes', 'workStates', 'interruptionTypes',
  'commentPeriodTypes', 'complexities', 'intakeTypes']);

const entriesOf = (catalog, list) => (catalog && Array.isArray(catalog[list]) ? catalog[list] : []);
const labelsOf = (entry) => [entry.code, entry.name, ...(entry.aliases || [])];
const sameLabel = (a, b) => normalizeName(a) === normalizeName(b);

/** The entry whose code, name or alias is `label`. */
function entryFor(catalog, list, label) {
  if (typeof label !== 'string' || !label.trim()) return null;
  return entriesOf(catalog, list).find(entry => labelsOf(entry).some(one => sameLabel(one, label))) || null;
}

/** True when `label` is one only 2018 Act records carry, so the sheet loader skips it. */
function skips2018(catalog, vocabulary, label) {
  const skipped = (catalog && catalog.skip2018 && catalog.skip2018[vocabulary]) || [];
  return typeof label === 'string' && skipped.some(one => sameLabel(one, label));
}

/** EAC or PAC for a decision label that issues a certificate, else null. */
function certificateKindOf(catalog, label) {
  const entry = entryFor(catalog, 'outcomes', label);
  const kinds = Object.entries((entry && entry.certificateKinds) || {});
  const hit = kinds.find(([alias]) => sameLabel(alias, label));
  return hit ? hit[1] : null;
}

module.exports = { LISTS, entryFor, skips2018, certificateKindOf };
