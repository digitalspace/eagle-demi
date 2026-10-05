'use strict';

/**
 * Reads what `checkTail` needs from a stored original by following its cross-reference
 * structure: the last startxref, then each section by byte offset through /Prev and /XRefStm.
 * The original is never searched as text, so bytes inside a stream cannot pose as an object.
 * Every doubt is a refusal with an `original-*` reason, and the caller then refuses the tail.
 */

const zlib = require('zlib');
const { Reader, Refused, refuse } = require('./pdf-tail');

/** Bytes fetched from one original, in total, retries included. */
const READ_BUDGET = 16 * 1024 * 1024;
/** Bytes inflated from its xref and object streams, in total. */
const INFLATE_BUDGET = 32 * 1024 * 1024;
/** Sections followed through /Prev and /XRefStm. */
const MAX_SECTIONS = 64;
/** The last startxref must sit in this many final bytes. */
const END_WINDOW = 4096;
/** First read at an offset; a parse that runs off its end retries twice as wide. */
const FIRST_WINDOW = 4096;
const RETRY_MARGIN = 1024;

const isInt = (v) => Boolean(v) && Number.isInteger(v.number) && v.number >= 0;
const refOf = (v) => (v && v.ref ? v.ref : null);

/** Range reads that never reach the original's end and stop at the read budget. */
function source(readRange, length) {
  let spent = 0;
  async function read(offset, want) {
    if (!Number.isInteger(offset) || offset < 0 || offset >= length) refuse('original-offset');
    const n = Math.min(want, length - offset);
    spent += n;
    if (spent > READ_BUDGET) refuse('original-read-budget');
    const buf = await readRange(offset, n);
    if (!Buffer.isBuffer(buf) || buf.length !== n) refuse('original-short-read');
    return buf;
  }
  return {
    length,
    read,
    async exact(offset, want) {
      if (!Number.isInteger(want) || want < 0 || offset + want > length) refuse('original-offset');
      return want ? read(offset, want) : Buffer.alloc(0);
    },
    /** `parse(reader)` over the bytes at `offset`, widening the read while it runs out of bytes. */
    async parseAt(offset, parse) {
      let buf = Buffer.alloc(0);
      for (let size = FIRST_WINDOW; ; size *= 2) {
        // Only the bytes past the last window are fetched, so a wider retry costs what it adds.
        const more = await read(offset + buf.length, size - buf.length);
        buf = buf.length ? Buffer.concat([buf, more]) : more;
        const r = new Reader(buf, 0, { forbid: false });
        try {
          return parse(r, buf);
        } catch (err) {
          // A window cut mid-object fails near its end; bad syntax earlier, or at the original's end, is final.
          const cut = r.pos >= buf.length - RETRY_MARGIN && offset + buf.length < length;
          if (!(err instanceof Refused) || err.message !== 'tail-syntax' || !cut) throw err;
        }
      }
    }
  };
}

function inflater() {
  let spent = 0;
  return (data) => {
    const room = INFLATE_BUDGET - spent;
    if (room < 1) refuse('original-inflate-budget');
    let out;
    try {
      // Sync flush accepts a stream whose end marker is missing, as pikepdf and pypdf do.
      out = zlib.inflateSync(data, { maxOutputLength: room, finishFlush: zlib.constants.Z_SYNC_FLUSH });
    } catch (err) {
      refuse(err.code === 'ERR_BUFFER_TOO_LARGE' ? 'original-inflate-budget' : 'original-inflate');
    }
    spent += out.length;
    return out;
  };
}

/** Undo PNG row predictors (10-15) for one 8-bit component per pixel, the xref stream case. */
function unpredict(data, columns) {
  const row = columns + 1;
  if (data.length % row) refuse('original-filter');
  const out = Buffer.alloc((data.length / row) * columns);
  for (let i = 0, o = 0; i < data.length; i += row, o += columns) {
    const type = data[i];
    for (let j = 0; j < columns; j++) {
      const x = data[i + 1 + j];
      const a = j ? out[o + j - 1] : 0;
      const b = o ? out[o - columns + j] : 0;
      const c = j && o ? out[o - columns + j - 1] : 0;
      let v;
      if (type === 0) v = x;
      else if (type === 1) v = x + a;
      else if (type === 2) v = x + b;
      else if (type === 3) v = x + ((a + b) >> 1);
      else if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else refuse('original-filter');
      out[o + j] = v & 0xff;
    }
  }
  return out;
}

/** Stream data after its filters: none, or FlateDecode with an optional PNG predictor. */
function decode(dict, data, inflate) {
  const filter = dict.get('Filter');
  const one = (v) => (v && v.array ? (v.array.length === 1 ? v.array[0] : refuse('original-filter')) : v);
  const name = one(filter);
  if (!name) return data;
  if (name.name !== 'FlateDecode') refuse('original-filter');
  const parms = one(dict.get('DecodeParms'));
  const out = inflate(data);
  if (!parms || parms.keyword === 'null') return out;
  if (!parms.dict) refuse('original-filter');
  const get = (key, fallback) => {
    const v = parms.dict.get(key);
    if (v === undefined) return fallback;
    return isInt(v) ? v.number : refuse('original-filter');
  };
  const predictor = get('Predictor', 1);
  if (predictor === 1) return out;
  if (predictor < 10 || predictor > 15 || get('Colors', 1) !== 1 || get('BitsPerComponent', 8) !== 8) refuse('original-filter');
  const columns = get('Columns', 1);
  if (columns < 1) refuse('original-filter');
  return unpredict(out, columns);
}

/** `N G obj`, matching `ref` when given. */
function objectHeader(r, ref) {
  const num = r.word();
  const gen = r.word();
  if (!/^\d+$/.test(num) || !/^\d+$/.test(gen) || r.word() !== 'obj') refuse('original-object-header');
  if (ref && (Number(num) !== ref[0] || Number(gen) !== ref[1])) refuse('original-object-header');
}

/** The dictionary of the stream object at the reader, and where its data starts. */
function streamHead(r, ref) {
  objectHeader(r, ref);
  r.ws();
  if (!(r.buf[r.pos] === 0x3c && r.buf[r.pos + 1] === 0x3c)) refuse('original-stream');
  const dict = r.dict();
  r.ws();
  if (!r.peekWord('stream')) refuse('tail-syntax');
  r.pos += 'stream'.length;
  if (r.buf[r.pos] === 0x0d) r.pos++;
  if (r.buf[r.pos] !== 0x0a) refuse('tail-syntax');
  return { dict, dataAt: r.pos + 1 };
}

/** Rows of an xref stream as `[number, entry]`; entry `{type: 1, offset, gen}`, `{type: 2, stm, idx}` or `{type: 0}`. */
function xrefRows(dict, data) {
  const w = dict.get('W');
  const widths = w && w.array && w.array.length === 3 && w.array.every(v => isInt(v) && v.number <= 8)
    ? w.array.map(v => v.number) : refuse('original-xref');
  const size = dict.get('Size');
  if (!isInt(size)) refuse('original-xref');
  const index = dict.get('Index');
  const pairs = index ? (index.array && index.array.every(isInt) ? index.array.map(v => v.number) : refuse('original-xref')) : [0, size.number];
  if (pairs.length % 2) refuse('original-xref');
  const row = widths[0] + widths[1] + widths[2];
  if (!row) refuse('original-xref');
  const rows = [];
  let at = 0;
  const field = (width, fallback) => {
    if (!width) return fallback;
    let v = 0;
    for (let k = 0; k < width; k++) v = v * 256 + data[at++];
    return v;
  };
  for (let i = 0; i < pairs.length; i += 2) {
    if (at + pairs[i + 1] * row > data.length) refuse('original-xref');
    for (let n = pairs[i]; n < pairs[i] + pairs[i + 1]; n++) {
      const type = field(widths[0], 1);
      const f1 = field(widths[1], 0);
      const f2 = field(widths[2], 0);
      if (type === 1) rows.push([n, { type, offset: f1, gen: f2 }]);
      else if (type === 2) rows.push([n, { type, stm: f1, idx: f2 }]);
      else rows.push([n, { type: 0 }]);
    }
  }
  return rows;
}

/** The section at `offset`: a table with its trailer, or an xref stream. */
async function readSection(src, inflate, offset) {
  const head = await src.parseAt(offset, (r, buf) => {
    if (buf.toString('latin1', 0, 4) !== 'xref') return { stream: streamHead(r) };
    r.pos = 4;
    const rows = [];
    for (;;) {
      r.ws();
      if (r.peekWord('trailer')) break;
      const first = r.int();
      const count = r.int();
      for (let n = first; n < first + count; n++) {
        const at = r.int();
        const gen = r.int();
        const kind = r.word();
        if (kind === 'n') rows.push([n, { type: 1, offset: at, gen }]);
        else if (kind === 'f') rows.push([n, { type: 0 }]);
        else refuse('tail-syntax');
      }
    }
    r.expect('trailer');
    r.ws();
    return { rows, trailer: r.dict() };
  });
  if (!head.stream) return head;
  const { dict, dataAt } = head.stream;
  const type = dict.get('Type');
  if (!type || type.name !== 'XRef' || !isInt(dict.get('Length'))) refuse('original-xref');
  const data = await src.exact(offset + dataAt, dict.get('Length').number);
  return { rows: xrefRows(dict, decode(dict, data, inflate)), trailer: dict };
}

/** `{prev, root, info, size, metadata}` of the original, or `{error}` with an `original-*` reason. */
async function readOriginal(readRange, originalLength) {
  try {
    if (!Number.isInteger(originalLength) || originalLength < 1) refuse('original-empty');
    const src = source(readRange, originalLength);
    const inflate = inflater();
    const endAt = Math.max(0, originalLength - END_WINDOW);
    const end = (await src.read(endAt, END_WINDOW)).toString('latin1');
    const last = [...end.matchAll(/startxref\s+(\d+)/g)].at(-1);
    if (!last) refuse('original-no-startxref');
    const prev = Number(last[1]);

    // Newest section first: its in-use entries and trailer keys win over older ones.
    const entries = new Map();
    const trailer = new Map();
    let highest = -1;
    const seen = new Set();
    const take = (section) => {
      for (const [n, entry] of section.rows) {
        if (!entry.type) continue;
        highest = Math.max(highest, n);
        if (!entries.has(n)) entries.set(n, entry);
      }
      for (const key of ['Root', 'Info', 'Size']) {
        if (section.trailer.has(key) && !trailer.has(key)) trailer.set(key, section.trailer.get(key));
      }
    };
    const visit = (offset) => {
      if (seen.has(offset)) refuse('original-prev-loop');
      if (seen.size >= MAX_SECTIONS) refuse('original-sections');
      seen.add(offset);
    };
    for (let at = prev; at !== null;) {
      visit(at);
      const section = await readSection(src, inflate, at);
      if (section.trailer.has('Encrypt')) refuse('original-encrypted');
      take(section);
      const stm = section.trailer.get('XRefStm');
      if (stm) {
        // Only a table's trailer may name a hybrid xref stream, and it must name one.
        if (!isInt(stm) || section.trailer.get('Type')) refuse('original-xref');
        visit(stm.number);
        const hybrid = await readSection(src, inflate, stm.number);
        if (!hybrid.trailer.get('Type')) refuse('original-xref');
        take({ rows: hybrid.rows, trailer: new Map() });
      }
      const next = section.trailer.get('Prev');
      if (next && !isInt(next)) refuse('original-prev');
      at = next ? next.number : null;
    }

    const size = trailer.get('Size');
    const root = refOf(trailer.get('Root'));
    if (!isInt(size)) refuse('original-size');
    if (!root) refuse('original-no-root');
    const info = refOf(trailer.get('Info'));

    const streams = new Map();
    /** Decoded object stream `num`: its data, where objects start, and `[number, offset]` pairs. */
    const objectStream = async (num) => {
      if (streams.has(num)) return streams.get(num);
      const entry = entries.get(num);
      if (!entry || entry.type !== 1) refuse('original-object-stream');
      const { dict, dataAt } = await src.parseAt(entry.offset, (r) => streamHead(r, [num, entry.gen]));
      const type = dict.get('Type');
      const n = dict.get('N');
      const first = dict.get('First');
      if (!type || type.name !== 'ObjStm' || !isInt(n) || !isInt(first)) refuse('original-object-stream');
      let length = dict.get('Length');
      if (refOf(length)) length = await value(refOf(length), false);
      if (!isInt(length)) refuse('original-object-stream');
      const data = decode(dict, await src.exact(entry.offset + dataAt, length.number), inflate);
      const r = new Reader(data.subarray(0, first.number), 0, { forbid: false });
      const pairs = [];
      for (let i = 0; i < n.number; i++) pairs.push([r.int(), r.int()]);
      const stream = { data, first: first.number, pairs };
      streams.set(num, stream);
      return stream;
    };
    /** The object `ref` names, checked against its header; `inStream` false refuses a compressed one. */
    const value = async (ref, inStream = true) => {
      const entry = entries.get(ref[0]);
      if (!entry) refuse('original-unlisted');
      if (entry.type === 1) {
        if (entry.gen !== ref[1]) refuse('original-object-header');
        return src.parseAt(entry.offset, (r) => { objectHeader(r, ref); return r.value(); });
      }
      if (!inStream) refuse('original-object-stream');
      if (ref[1] !== 0) refuse('original-object-header');
      const stream = await objectStream(entry.stm);
      const pair = stream.pairs[entry.idx];
      if (!pair || pair[0] !== ref[0]) refuse('original-object-header');
      return new Reader(stream.data, stream.first + pair[1], { forbid: false }).value();
    };

    const catalog = await value(root);
    if (!catalog.dict) refuse('original-root');
    if (info) await value(info);
    const metadata = refOf(catalog.dict.get('Metadata'));
    // The titler revises the XMP stream in place, so it must be a plain stream object.
    if (metadata) await value(metadata, false);
    // The titler's next free number: never one any section lists as in use.
    return { prev, root, info, size: Math.max(size.number, highest + 1), metadata };
  } catch (err) {
    if (err instanceof Refused) return { error: err.message.startsWith('tail-') ? 'original-syntax' : err.message };
    throw err;
  }
}

module.exports = { readOriginal, READ_BUDGET, INFLATE_BUDGET };
