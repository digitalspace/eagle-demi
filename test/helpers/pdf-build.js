'use strict';

/**
 * Hand-built PDF sections and fixture loading for the tail and original-reader tests. Bodies are
 * latin1 strings, so stream data may hold any byte.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'pdf-title');

/** A file from `test/fixtures/pdf-title`, gunzipped when its name ends in `.gz`. */
function fixture(file) {
  const bytes = fs.readFileSync(path.join(FIXTURES, file));
  return file.endsWith('.gz') ? zlib.gunzipSync(bytes) : bytes;
}

/**
 * Bytes to append after `prefix`: `bodies` (`[number, body]`) as objects, then one classic xref
 * section listing them and a trailer. `trailer` is a string, or a function of the objects'
 * offsets (a Map) and the section's own offset. `lie: {2: 3}` lists object 2 at object 3's
 * offset, and `free` lists numbers as free entries.
 */
function classicTail(prefix, bodies, trailer, { lie = {}, free = [] } = {}) {
  let text = '';
  const offsets = new Map();
  for (const [num, body] of bodies) {
    offsets.set(num, prefix.length + Buffer.byteLength(text, 'latin1'));
    text += `${num} 0 obj\n${body}\nendobj\n`;
  }
  const xrefAt = prefix.length + Buffer.byteLength(text, 'latin1');
  const rows = [...offsets].map(([num, offset]) => [num, `${String(lie[num] ? offsets.get(lie[num]) : offset).padStart(10, '0')} 00000 n`]);
  for (const num of free) rows.push([num, '0000000000 00001 f']);
  text += 'xref\n';
  for (const [num, row] of rows.sort((a, b) => a[0] - b[0])) text += `${num} 1\n${row}\r\n`;
  const dict = typeof trailer === 'function' ? trailer(offsets, xrefAt) : trailer;
  text += `trailer\n<< ${dict} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(text, 'latin1');
}

/** A whole classic PDF: header, then `classicTail` over it. */
function classicPdf(bodies, trailer, options) {
  const header = Buffer.from('%PDF-1.7\n', 'latin1');
  return Buffer.concat([header, classicTail(header, bodies, trailer, options)]);
}

module.exports = { fixture, classicTail, classicPdf };
