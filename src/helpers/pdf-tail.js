'use strict';

/**
 * Does the increment after a stored original hold exactly what `pdf-title/titler.py` writes, and
 * nothing else? The titler appends an Info dictionary with /Title, optionally a new XMP /Metadata
 * stream (unfiltered) under a new number with the Catalog revised to name it, and one xref section
 * (table plus trailer, or an xref stream). Anything else in the increment could change what the
 * public sees, so it is refused.
 *
 * The original's facts come from `readOriginal` in `pdf-original.js`, which follows its xref
 * structure.
 */

const crypto = require('crypto');

// Names that can run code, open links, or change pages or annotations, plus compression.
const FORBIDDEN = new Set([
  'JavaScript', 'JS', 'OpenAction', 'AA', 'Launch', 'URI', 'Contents', 'Annots', 'Filter',
  'DecodeParms', 'ObjStm', 'EmbeddedFiles', 'SubmitForm', 'ImportData', 'GoToR', 'GoToE', 'RichMedia'
]);
const XREF_KEYS = new Set(['Type', 'W', 'Index', 'Size', 'Root', 'Info', 'Prev', 'ID', 'Length']);
const TRAILER_KEYS = new Set(['Size', 'Root', 'Info', 'Prev', 'ID']);
const XMP_KEYS = new Set(['Type', 'Subtype', 'Length']);
/** Arrays and dictionaries nest at most this deep; real files stay far below it. */
const MAX_DEPTH = 32;

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([...'()<>[]{}/%'].map(c => c.charCodeAt(0)));

class Refused extends Error {}
const refuse = (reason) => { throw new Refused(reason); };

/**
 * A strict reader of PDF objects over one buffer. Strings and stream data are never searched.
 * `forbid: false` reads names such as /Filter without refusing, for parsing an original.
 */
class Reader {
  constructor(buf, pos = 0, { forbid = true } = {}) { this.buf = buf; this.pos = pos; this.forbid = forbid; this.depth = 0; }

  nest() {
    if (++this.depth > MAX_DEPTH) refuse('tail-syntax');
  }

  ws() {
    for (;;) {
      while (this.pos < this.buf.length && WS.has(this.buf[this.pos])) this.pos++;
      if (this.buf[this.pos] !== 0x25 || this.peekWord('%%EOF')) return;
      while (this.pos < this.buf.length && this.buf[this.pos] !== 0x0a && this.buf[this.pos] !== 0x0d) this.pos++;
    }
  }

  peekWord(word) {
    return this.buf.toString('latin1', this.pos, this.pos + word.length) === word;
  }

  word() {
    this.ws();
    const start = this.pos;
    while (this.pos < this.buf.length && !WS.has(this.buf[this.pos]) && !DELIM.has(this.buf[this.pos])) this.pos++;
    return this.buf.toString('latin1', start, this.pos);
  }

  expect(word) {
    if (this.word() !== word) refuse('tail-syntax');
  }

  int() {
    const w = this.word();
    if (!/^\d+$/.test(w)) refuse('tail-syntax');
    return Number(w);
  }

  value() {
    this.ws();
    const c = this.buf[this.pos];
    if (c === 0x2f) return { name: this.name() };
    if (c === 0x28) return { string: this.literal() };
    if (c === 0x3c && this.buf[this.pos + 1] === 0x3c) return { dict: this.dict() };
    if (c === 0x3c) return { string: this.hex() };
    if (c === 0x5b) return { array: this.array() };
    const start = this.pos;
    const w = this.word();
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) {
      if (/^\d+$/.test(w)) {
        const back = this.pos;
        const gen = this.word();
        if (/^\d+$/.test(gen) && this.word() === 'R') return { ref: [Number(w), Number(gen)] };
        this.pos = back;
      }
      return { number: Number(w) };
    }
    if (w === 'true' || w === 'false' || w === 'null') return { keyword: w };
    this.pos = start;
    return refuse('tail-syntax');
  }

  name() {
    this.pos++;
    const start = this.pos;
    while (this.pos < this.buf.length && !WS.has(this.buf[this.pos]) && !DELIM.has(this.buf[this.pos])) this.pos++;
    const name = this.buf.toString('latin1', start, this.pos)
      .replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    if (this.forbid && FORBIDDEN.has(name)) refuse(`tail-forbidden:${name}`);
    return name;
  }

  literal() {
    let depth = 0;
    const start = this.pos;
    for (; this.pos < this.buf.length; this.pos++) {
      const c = this.buf[this.pos];
      if (c === 0x5c) { this.pos++; continue; }
      if (c === 0x28) depth++;
      if (c === 0x29 && --depth === 0) { this.pos++; return this.buf.toString('latin1', start, this.pos); }
    }
    return refuse('tail-syntax');
  }

  hex() {
    const end = this.buf.indexOf(0x3e, this.pos);
    if (end < 0 || !/^<[0-9a-fA-F\s]*$/.test(this.buf.toString('latin1', this.pos, end))) refuse('tail-syntax');
    const text = this.buf.toString('latin1', this.pos, end + 1);
    this.pos = end + 1;
    return text;
  }

  array() {
    this.pos++;
    this.nest();
    const items = [];
    for (;;) {
      this.ws();
      if (this.buf[this.pos] === 0x5d) { this.pos++; this.depth--; return items; }
      if (this.pos >= this.buf.length) refuse('tail-syntax');
      items.push(this.value());
    }
  }

  dict() {
    this.pos += 2;
    this.nest();
    const map = new Map();
    for (;;) {
      this.ws();
      if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) { this.pos += 2; this.depth--; return map; }
      if (this.buf[this.pos] !== 0x2f) refuse('tail-syntax');
      const key = this.name();
      if (map.has(key)) refuse('tail-syntax');
      map.set(key, this.value());
    }
  }
}

const refOf = (v) => (v && v.ref ? v.ref : null);
const sameRef = (a, b) => Boolean(a && b) && a[0] === b[0] && a[1] === b[1];

const ESCAPES = { n: 0x0a, r: 0x0d, t: 0x09, b: 0x08, f: 0x0c };

/** The bytes a literal `(...)` or hex `<...>` string stands for, escapes and line ends decoded. */
function stringBytes(text) {
  if (text[0] === '<') {
    const hex = text.slice(1, -1).replace(/\s/g, '');
    return Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex');
  }
  const out = [];
  const code = (i) => text.charCodeAt(i);
  const isOctal = (i) => code(i) >= 0x30 && code(i) <= 0x37;
  for (let i = 1; i < text.length - 1; i++) {
    let c = code(i);
    if (c === 0x5c) {
      c = code(++i);
      if (text[i] in ESCAPES) out.push(ESCAPES[text[i]]);
      else if (isOctal(i)) {
        let v = 0;
        for (let k = 0; k < 3 && isOctal(i); k++, i++) v = v * 8 + code(i) - 0x30;
        i--;
        out.push(v & 0xff);
      } else if (c === 0x0d) {
        if (code(i + 1) === 0x0a) i++;
      } else if (c !== 0x0a) out.push(c);
    } else if (c === 0x0d) {
      if (code(i + 1) === 0x0a) i++;
      out.push(0x0a);
    } else out.push(c);
  }
  return Buffer.from(out);
}

/**
 * One text per meaning of a value: dictionary keys sorted, names and strings as hex of their
 * decoded bytes, numbers as JavaScript prints them. Two writers' spellings of one value compare equal.
 */
function canonical(v) {
  const name = (n) => `/${Buffer.from(n, 'latin1').toString('hex')}`;
  if ('dict' in v) return `<<${[...v.dict.keys()].sort().map(k => `${name(k)} ${canonical(v.dict.get(k))}`).join(' ')}>>`;
  if ('array' in v) return `[${v.array.map(canonical).join(' ')}]`;
  if ('name' in v) return name(v.name);
  if ('string' in v) return `<${stringBytes(v.string).toString('hex')}>`;
  if ('ref' in v) return `${v.ref[0]} ${v.ref[1]} R`;
  if ('number' in v) return String(v.number);
  return v.keyword;
}

/** sha256 of the canonical form of dictionary `dict` without `keys`: short enough for the row. */
function fingerprint(dict, keys) {
  const text = canonical({ dict: new Map([...dict].filter(([k]) => !keys.includes(k))) });
  return crypto.createHash('sha256').update(text, 'latin1').digest('hex');
}

/** A string /Title; a revised Info keeps every other entry as it was, a new one holds nothing else. */
function checkInfo(dict, facts) {
  const title = dict.get('Title');
  if (!title || !('string' in title)) refuse('tail-info');
  if (!facts.info) {
    if (dict.size !== 1) refuse('tail-info');
  } else if (fingerprint(dict, ['Title']) !== facts.infoKept) {
    refuse('tail-info-changed');
  }
}

function checkTrailer(dict, facts, info, allowed, highest) {
  for (const key of dict.keys()) if (!allowed.has(key)) refuse('tail-trailer');
  if (!sameRef(refOf(dict.get('Root')), facts.root)) refuse('tail-root');
  if (!sameRef(refOf(dict.get('Info')), info)) refuse('tail-info-ref');
  const prev = dict.get('Prev');
  if (!prev || prev.number !== facts.prev) refuse('tail-prev');
  const size = dict.get('Size');
  // /Size covers the original's numbers and every number the increment adds.
  if (!size || !Number.isInteger(size.number) || size.number < Math.max(facts.size, highest + 1)) refuse('tail-size');
}

/** Decode an xref stream's rows into `number -> {offset, gen}`, refusing any entry that is not type 1. */
function xrefStreamEntries(dict, data) {
  const w = dict.get('W');
  const widths = w && w.array && w.array.map(x => x.number);
  if (!widths || widths.length !== 3 || widths[0] !== 1 || widths[2] !== 2 || !(widths[1] >= 1 && widths[1] <= 8)) {
    refuse('tail-xref');
  }
  const index = dict.get('Index');
  const pairs = index && index.array ? index.array.map(x => x.number) : refuse('tail-xref');
  const row = 1 + widths[1] + 2;
  const entries = new Map();
  let at = 0;
  for (let i = 0; i < pairs.length; i += 2) {
    for (let n = pairs[i]; n < pairs[i] + pairs[i + 1]; n++) {
      if (at + row > data.length || data[at] !== 1) refuse('tail-xref');
      entries.set(n, { offset: data.readUIntBE(at + 1, widths[1]), gen: data.readUInt16BE(at + 1 + widths[1]) });
      at += row;
    }
  }
  if (at !== data.length) refuse('tail-xref');
  return entries;
}

/**
 * Null when `tail` (the bytes after the original) is exactly a titler increment for `facts`
 * (from `readOriginal`), else the reason it is refused.
 */
function checkTail(tail, originalLength, facts) {
  if (facts && facts.error) return facts.error;
  // Facts of any other shape, such as an older reader's without the Catalog, are not trusted.
  if (!facts || !('catalog' in facts) || !('infoKept' in facts)) return 'original-unscanned';
  try {
    const r = new Reader(tail);
    const objects = new Map();
    let info = null;
    let xmp = null;
    let catalog = null;
    let xrefStream = null;
    for (;;) {
      r.ws();
      if (r.peekWord('xref') || r.peekWord('startxref')) break;
      const at = r.pos;
      const num = r.int();
      const gen = r.int();
      r.expect('obj');
      // Another object may share the XMP number, so the XMP is never revised in place.
      if (facts.metadata && num === facts.metadata[0]) refuse('tail-xmp-in-place');
      r.ws();
      if (!(r.buf[r.pos] === 0x3c && r.buf[r.pos + 1] === 0x3c)) refuse('tail-object');
      const isCatalog = num === facts.root[0];
      // The revised Catalog may keep the original's actions; it is compared with the original below.
      r.forbid = !isCatalog;
      const dict = r.dict();
      r.forbid = true;
      let data = null;
      r.ws();
      if (r.peekWord('stream')) {
        r.pos += 'stream'.length;
        if (r.buf[r.pos] === 0x0d) r.pos++;
        if (r.buf[r.pos] !== 0x0a) refuse('tail-syntax');
        r.pos++;
        const len = dict.get('Length');
        if (!len || !Number.isInteger(len.number)) refuse('tail-syntax');
        data = tail.subarray(r.pos, r.pos + len.number);
        r.pos += len.number;
        r.expect('endstream');
      }
      r.expect('endobj');
      if (objects.has(num)) refuse('tail-object');
      objects.set(num, { offset: originalLength + at, gen });

      const type = dict.get('Type');
      if (data && type && type.name === 'XRef') {
        if (xrefStream) refuse('tail-object');
        xrefStream = { num, gen, dict, data, offset: originalLength + at };
      } else if (data && type && type.name === 'Metadata') {
        const subtype = dict.get('Subtype');
        if (xmp || !subtype || subtype.name !== 'XML' || ![...dict.keys()].every(k => XMP_KEYS.has(k))) refuse('tail-xmp');
        // A number no section of the original lists, so no object of the original holds it.
        if (num < facts.size || gen !== 0) refuse('tail-xmp-number');
        xmp = [num, gen];
      } else if (data) {
        refuse('tail-object');
      } else if (isCatalog) {
        if (gen !== facts.root[1]) refuse('tail-catalog-changed');
        catalog = dict;
      } else {
        if (info) refuse('tail-info');
        checkInfo(dict, facts);
        info = [num, gen];
      }
      if (xrefStream && num !== xrefStream.num) refuse('tail-object');
    }
    // Only the Info and Catalog revise an object the original has; anything else is new.
    if (xrefStream && (xrefStream.num < facts.size || xrefStream.gen !== 0)) refuse('tail-object-number');
    if (!info) refuse('tail-info');
    if (xmp && !catalog) refuse('tail-xmp');
    // A file with no XMP gets none, so its Catalog is never revised.
    if (catalog && (!facts.metadata || !xmp || !sameRef(refOf(catalog.get('Metadata')), xmp) ||
        fingerprint(catalog, ['Metadata']) !== facts.catalog)) {
      refuse('tail-catalog-changed');
    }
    // A revised Info keeps its number; a new one takes a number the original never used.
    if (facts.info ? !sameRef(info, facts.info) : (info[0] < facts.size || info[1] !== 0)) refuse('tail-info-number');
    const highest = Math.max(...objects.keys());

    let entries;
    let xrefAt;
    if (xrefStream) {
      if (!r.peekWord('startxref')) refuse('tail-xref');
      checkTrailer(xrefStream.dict, facts, info, XREF_KEYS, highest);
      entries = xrefStreamEntries(xrefStream.dict, xrefStream.data);
      xrefAt = xrefStream.offset;
    } else {
      xrefAt = originalLength + r.pos;
      r.expect('xref');
      entries = new Map();
      for (;;) {
        r.ws();
        if (r.peekWord('trailer')) break;
        const first = r.int();
        const count = r.int();
        for (let n = first; n < first + count; n++) {
          const offset = r.int();
          const gen = r.int();
          if (r.word() !== 'n') refuse('tail-xref');
          entries.set(n, { offset, gen });
        }
      }
      r.expect('trailer');
      r.ws();
      checkTrailer(r.dict(), facts, info, TRAILER_KEYS, highest);
    }
    // Every entry points at its own object in the increment, and every object has one.
    if (entries.size !== objects.size) refuse('tail-xref');
    for (const [n, entry] of entries) {
      const object = objects.get(n);
      if (!object || object.offset !== entry.offset || object.gen !== entry.gen) refuse('tail-xref');
    }

    r.expect('startxref');
    if (r.int() !== xrefAt) refuse('tail-startxref');
    r.ws();
    if (!r.peekWord('%%EOF')) refuse('tail-syntax');
    r.pos += 5;
    // The titler ends on a newline: whitespace only after %%EOF, not even a comment.
    while (r.pos < tail.length && WS.has(tail[r.pos])) r.pos++;
    if (r.pos !== tail.length) refuse('tail-trailing-bytes');
    return null;
  } catch (err) {
    if (err instanceof Refused) return err.message;
    throw err;
  }
}

module.exports = { checkTail, Reader, Refused, refuse, fingerprint };
