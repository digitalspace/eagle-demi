'use strict';

/**
 * How the documents of a bulk download pack into zip parts — greedy, in the order given.
 *
 * The controller sizes the job with this and the worker builds with it, from the same list in the
 * same order, so the `partCount` a caller polls against cannot disagree with the parts that arrive.
 */

/**
 * @param {Array<{id: string, fileSize: number}>} docs
 * @param {number} maxBytes
 * @returns {Array<Array<object>>} the documents of each part
 */
function packParts(docs, maxBytes) {
  const parts = [];
  let current = [];
  let bytes = 0;

  const flush = () => {
    if (current.length > 0) parts.push(current);
    current = [];
    bytes = 0;
  };

  for (const doc of docs || []) {
    const size = Number(doc && doc.fileSize);
    // An unrecorded size is not a small one. Giving it a part to itself keeps a document nobody
    // measured from silently blowing a part that was packed to the byte.
    const known = Number.isFinite(size) && size > 0;

    if (!known || size > maxBytes) {
      flush();
      parts.push([doc]);
      continue;
    }
    if (current.length > 0 && bytes + size > maxBytes) flush();
    current.push(doc);
    bytes += size;
  }

  flush();
  return parts;
}

function packPartCount(docs, maxBytes) {
  return packParts(docs, maxBytes).length;
}

module.exports = { packParts, packPartCount };
