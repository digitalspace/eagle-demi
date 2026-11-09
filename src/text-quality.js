'use strict';

// docling emits this for every picture; there is no way to turn it off (image_export_mode admits
// only placeholder/embedded/referenced), so it is stripped or tolerated, never prevented.
const IMAGE_PLACEHOLDER = /<!--\s*image\s*-->/gi;

function round(n) {
  return Math.round(n * 1000) / 1000;
}

/** Remove docling's image placeholders; '' when a section held nothing else. */
function stripPlaceholders(text) {
  return String(text || '')
    .replace(IMAGE_PLACEHOLDER, ' ')
    // Collapse the runs of spaces and the blank lines a removed placeholder leaves, without
    // joining paragraphs that were genuinely separate.
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n')
    .trim();
}

/** Is this chunk nothing but rules, dot leaders and form underscores? */
function isSeparatorFurniture(text) {
  // A share, not the longest run. Letters under 0.35 keeps tables of contents: measured on the
  // corpus, a TOC runs separator share 0.40-0.58 but letters 0.37-0.56 (section titles).
  const body = String(text || '').replace(IMAGE_PLACEHOLDER, ' ');
  const denom = Math.max(body.replace(/\s/g, '').length, 1);
  const letters = (body.match(/[A-Za-z]/g) || []).length;
  const separatorChars = (body.match(/[.\-_=·•*]{4,}/g) || [])
    .reduce((total, run) => total + run.length, 0);
  return round(separatorChars / denom) > 0.3 && round(letters / denom) < 0.35;
}

module.exports = {
  stripPlaceholders,
  isSeparatorFurniture
};
