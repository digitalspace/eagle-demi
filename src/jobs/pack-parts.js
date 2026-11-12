'use strict';

/**
 * An estimate only: `fileSize` is missing on some documents and counts as 0 here. The worker packs
 * by the bytes it actually writes; the controller uses this for a rough part count.
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
