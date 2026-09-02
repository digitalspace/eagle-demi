'use strict';

/**
 * How the documents of a bulk download are ESTIMATED to pack into zip parts — greedy, in the order
 * given, and only ever an estimate: `fileSize` is not recorded for every document, so a size that
 * is missing counts as 0 here. The worker packs against the bytes it actually writes, which is the
 * only count that can be right, and the controller uses this to tell the caller roughly how many
 * files to expect.
 */

/**
 * @param {Array<{id: string, fileSize: number}>} docs
 * @param {number} maxBytes
 * @returns {Array<Array<object>>} the documents each part is estimated to hold
 */
function packParts(docs, maxBytes) {
  const parts = [];
  let current = [];
  let bytes = 0;

  for (const doc of docs || []) {
    const size = Number(doc && doc.fileSize);
    const known = Number.isFinite(size) && size > 0 ? size : 0;

    if (current.length > 0 && bytes + known > maxBytes) {
      parts.push(current);
      current = [];
      bytes = 0;
    }
    current.push(doc);
    bytes += known;
  }

  if (current.length > 0) parts.push(current);
  return parts;
}

function packPartCount(docs, maxBytes) {
  return packParts(docs, maxBytes).length;
}

module.exports = { packParts, packPartCount };
