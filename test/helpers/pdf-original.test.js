'use strict';

/**
 * The structural reader of a stored original. Fixtures `objstm-xmp` and `linearized-large` were
 * written by qpdf through pikepdf (pinned in pdf-title/requirements.txt); expected facts are
 * pikepdf's view of each file, and the size is the titler's `_next_free_number`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { readOriginal, READ_BUDGET } = require('../../src/helpers/pdf-original');
const { fixture, classicTail, classicPdf } = require('./pdf-build');

/** Facts read from `bytes` as an original of `length` bytes, plus every range asked for. */
async function read(bytes, length = bytes.length) {
  const reads = [];
  const facts = await readOriginal(async (offset, n) => {
    reads.push([offset, n]);
    return bytes.subarray(offset, offset + n);
  }, length);
  return { facts, reads };
}

const BODIES = [
  [1, '<< /Title (Old) >>'],
  [2, '<< /Type /Catalog /Pages 3 0 R >>'],
  [3, '<< /Type /Pages /Kids [4 0 R] /Count 1 >>'],
  [4, '<< /Type /Page /Parent 3 0 R /MediaBox [0 0 200 200] >>']
];
const TRAILER = '/Size 5 /Root 2 0 R /Info 1 0 R';
/** Offset of the last classic section in a built file. */
const lastTable = (bytes) => bytes.lastIndexOf('\nxref\n') + 1;

/** Header, one xref stream object with `dict` entries and `data`, and a startxref to it. */
function xrefStreamPdf(dict, data) {
  const head = '%PDF-1.7\n';
  return Buffer.concat([
    Buffer.from(`${head}1 0 obj\n<< /Type /XRef /Size 2 /W [1 1 1] ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'),
    data,
    Buffer.from(`\nendstream\nendobj\nstartxref\n${head.length}\n%%EOF\n`, 'latin1')
  ]);
}

/** PNG row predictor `type` (Sub 1, Up 2, Average 3, Paeth 4) over left `a`, above `b`, upper-left `c`. */
function pngGuess(type, a, b, c) {
  if (type === 1) return a;
  if (type === 2) return b;
  if (type === 3) return (a + b) >> 1;
  if (type === 4) {
    const p = a + b - c;
    const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  }
  return 0;
}

/**
 * Header, `bodies` as plain objects, then an xref stream listing them with widths `w`. `zero`
 * lists object 0 as free, so /Index starts at 0. `png` encodes rows with those predictor types
 * in turn, under FlateDecode and /Predictor 12.
 */
function xrefStreamFile(bodies, trailer, { w, zero = false, png = null }) {
  let text = '%PDF-1.7\n';
  const offsets = new Map();
  for (const [num, body] of bodies) {
    offsets.set(num, text.length);
    text += `${num} 0 obj\n${body}\nendobj\n`;
  }
  const self = Math.max(...offsets.keys()) + 1;
  offsets.set(self, text.length);
  const bytes = (v, width) => Array.from({ length: width }, (_, k) => Math.floor(v / 256 ** (width - 1 - k)) % 256);
  const first = zero ? 0 : 1;
  const rows = [];
  for (let n = first; n <= self; n++) {
    rows.push([...bytes(offsets.has(n) ? 1 : 0, w[0]), ...bytes(offsets.get(n) || 0, w[1]), ...bytes(0, w[2])]);
  }
  let data = Buffer.from(rows.flat());
  let filter = '';
  if (png) {
    const coded = rows.flatMap((row, i) => {
      const type = png[i % png.length];
      const above = rows[i - 1] || row.map(() => 0);
      return [type, ...row.map((x, j) => (x - pngGuess(type, row[j - 1] || 0, above[j], above[j - 1] || 0)) & 0xff)];
    });
    data = zlib.deflateSync(Buffer.from(coded));
    filter = `/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns ${rows[0].length} >> `;
  }
  text += `${self} 0 obj\n<< /Type /XRef /Size ${self + 1} /W [${w.join(' ')}] /Index [${first} ${self + 1 - first}] ${trailer} ${filter}/Length ${data.length} >>\nstream\n`;
  return Buffer.concat([
    Buffer.from(text, 'latin1'),
    data,
    Buffer.from(`\nendstream\nendobj\nstartxref\n${offsets.get(self)}\n%%EOF\n`, 'latin1')
  ]);
}

test('facts match pikepdf on real files', async (t) => {
  const expected = {
    'classic-info.original.pdf': { prev: 441, root: [3, 0], info: [1, 0], size: 6, metadata: null },
    'classic-xmp.original.pdf': { prev: 1069, root: [3, 0], info: [1, 0], size: 7, metadata: [6, 0] },
    'xrefstream-noinfo.original.pdf': { prev: 203, root: [1, 0], info: null, size: 7, metadata: null },
    'xrefstream-xmp.original.pdf': { prev: 912, root: [1, 0], info: [4, 0], size: 7, metadata: [5, 0] },
    'objstm-xmp.original.pdf': { prev: 990, root: [2, 0], info: [5, 0], size: 9, metadata: [6, 0] },
    'linearized-large.original.pdf.gz': { prev: 216, root: [7, 0], info: [4, 0], size: 11, metadata: [5, 0] }
  };
  for (const [file, facts] of Object.entries(expected)) {
    await t.test(file, async () => {
      assert.deepEqual((await read(fixture(file))).facts, facts);
    });
  }
});

test('a linearized file is read from the first-page section, over 1 MiB from the end', async () => {
  const original = fixture('linearized-large.original.pdf.gz');
  const { facts, reads } = await read(original);
  assert.ok(original.length - facts.prev > 1024 * 1024);
  assert.ok(!facts.error);
  assert.ok(reads.reduce((sum, [, n]) => sum + n, 0) < 64 * 1024, 'reads only the sections and objects it needs');
});

test('an xref stream with Predictor 12 and a Catalog inside an object stream', async () => {
  const original = fixture('objstm-xmp.original.pdf');
  const text = original.toString('latin1');
  assert.match(text, /\/Predictor 12/);
  assert.match(text, /\/Type \/ObjStm/);
  assert.doesNotMatch(text, /(^|\s)2 0 obj/, 'the Catalog is not a plain object');
  assert.deepEqual((await read(original)).facts.root, [2, 0]);
});

test('a hybrid file finds its compressed Catalog through /XRefStm', async () => {
  const catalog = '<< /Type /Catalog /Pages 3 0 R /Metadata 6 0 R >>';
  const packed = zlib.deflateSync(Buffer.from(`2 0 ${catalog}`, 'latin1'));
  const rows = Buffer.from([2, 0, 5, 0]); // type 2: in object stream 5, index 0
  const bodies = [
    BODIES[0], BODIES[2], BODIES[3],
    [5, `<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${packed.length} >>\nstream\n${packed.toString('latin1')}\nendstream`],
    [6, '<< /Type /Metadata /Subtype /XML /Length 4 >>\nstream\n<x/>\nendstream'],
    [7, `<< /Type /XRef /Size 8 /W [1 2 1] /Index [2 1] /Length 4 >>\nstream\n${rows.toString('latin1')}\nendstream`]
  ];
  // The table lists the compressed Catalog as free, as hybrid writers do for older readers.
  const hybrid = classicPdf(bodies, (offsets) => `/Size 8 /Root 2 0 R /Info 1 0 R /XRefStm ${offsets.get(7)}`, { free: [2] });
  assert.deepEqual((await read(hybrid)).facts, { prev: lastTable(hybrid), root: [2, 0], info: [1, 0], size: 8, metadata: [6, 0] });
  const tableOnly = classicPdf(bodies, '/Size 8 /Root 2 0 R /Info 1 0 R', { free: [2] });
  assert.equal((await read(tableOnly)).facts.error, 'original-unlisted');
});

test('a newer section wins over an older one for objects and trailer keys', async () => {
  const older = classicPdf(BODIES, TRAILER);
  const xmp = '<< /Type /Metadata /Subtype /XML /Length 4 >>\nstream\n<x/>\nendstream';
  const catalog = '<< /Type /Catalog /Pages 3 0 R /Metadata 6 0 R >>';
  // Catalog 2 revised in place to name an XMP stream.
  const revised = Buffer.concat([older, classicTail(older, [[2, catalog], [6, xmp]], `${TRAILER} /Prev ${lastTable(older)}`)]);
  assert.deepEqual((await read(revised)).facts, { prev: lastTable(revised), root: [2, 0], info: [1, 0], size: 7, metadata: [6, 0] });
  // /Root moved to a new Catalog 7; the older trailer still names 2.
  const moved = Buffer.concat([older, classicTail(older, [[6, xmp], [7, catalog]], `/Size 8 /Root 7 0 R /Info 1 0 R /Prev ${lastTable(older)}`)]);
  assert.deepEqual((await read(moved)).facts, { prev: lastTable(moved), root: [7, 0], info: [1, 0], size: 8, metadata: [6, 0] });
});

test('xref streams: every PNG row predictor, zero values and a missing type field', async (t) => {
  const trailer = '/Root 2 0 R /Info 1 0 R';
  const expected = (bytes) => ({ prev: bytes.lastIndexOf('5 0 obj'), root: [2, 0], info: [1, 0], size: 6, metadata: null });

  await t.test('None, Sub, Up, Average and Paeth rows, with /Index from 0', async () => {
    const file = xrefStreamFile(BODIES, trailer, { w: [1, 4, 1], zero: true, png: [0, 3, 4, 1, 2, 4] }); // Average on Info's row, Paeth on the Catalog's
    assert.deepEqual((await read(file)).facts, expected(file));
  });

  await t.test('/W [0 4 0]: type 1 and generation 0 by default', async () => {
    const file = xrefStreamFile(BODIES, trailer, { w: [0, 4, 0] });
    assert.deepEqual((await read(file)).facts, expected(file));
  });
});

test('/XRefStm must name an xref stream, not a table', async () => {
  const older = classicPdf(BODIES, TRAILER);
  const bad = Buffer.concat([older, classicTail(older, [[1, '<< /Title (New) >>']], `${TRAILER} /XRefStm ${lastTable(older)}`)]);
  assert.equal((await read(bad)).facts.error, 'original-xref');
});

test('a 3 MiB older table behind a large increment fits the read budget', async () => {
  // 100,000 free entries, one subsection each: about 2.8 MiB of table.
  const free = Array.from({ length: 100000 }, (_, i) => i + 5);
  const older = classicPdf(BODIES, '/Size 100005 /Root 2 0 R /Info 1 0 R', { free });
  const pad = `<< /Pad (${'x'.repeat(14 * 1024 * 1024)}) >>`;
  const file = Buffer.concat([older, classicTail(older, [[1, '<< /Title (New) >>'], [100005, pad]], `/Size 100006 /Root 2 0 R /Info 1 0 R /Prev ${lastTable(older)}`)]);
  const { facts, reads } = await read(file);
  assert.equal(facts.size, 100006, facts.error);
  assert.ok(reads.reduce((sum, [, n]) => sum + n, 0) < 8 * 1024 * 1024);
});

test('size covers the highest number any section lists, above a low /Size', async () => {
  const original = classicPdf([...BODIES, [9, '<< >>']], TRAILER.replace('/Size 5', '/Size 3'));
  assert.equal((await read(original)).facts.size, 10);
});

test('reads stay below the original length', async () => {
  const original = fixture('classic-xmp.original.pdf');
  const titled = fixture('classic-xmp.titled.pdf');
  const { facts, reads } = await read(titled, original.length);
  assert.deepEqual(facts, (await read(original)).facts);
  for (const [offset, n] of reads) assert.ok(offset >= 0 && offset + n <= original.length, `${offset}+${n}`);
});

test('refusals', async (t) => {
  const plain = classicPdf(BODIES, TRAILER);
  const plainPrev = (await read(plain)).facts.prev;
  const refused = async (bytes) => (await read(bytes)).facts.error;

  await t.test('the control is read', async () => {
    assert.equal(await refused(plain), undefined);
  });

  await t.test('a /Prev cycle', async () => {
    const loop = Buffer.concat([plain, classicTail(plain, [], (_, at) => `${TRAILER} /Prev ${at}`)]);
    assert.equal(await refused(loop), 'original-prev-loop');
  });

  await t.test('a startxref or /Prev past the original', async () => {
    const text = plain.toString('latin1');
    const past = String(plain.length + 10);
    assert.equal(await refused(Buffer.from(text.replace(/startxref\n\d+/, `startxref\n${past}`), 'latin1')), 'original-offset');
    const prevPast = Buffer.concat([plain, classicTail(plain, [], `${TRAILER} /Prev ${plain.length * 4}`)]);
    assert.equal(await refused(prevPast), 'original-offset');
  });

  await t.test('an xref offset that lands on another object\'s header', async () => {
    assert.equal(await refused(classicPdf(BODIES, TRAILER, { lie: { 2: 3 } })), 'original-object-header');
    assert.equal(await refused(classicPdf(BODIES, TRAILER, { lie: { 1: 4 } })), 'original-object-header');
  });

  await t.test('an xref offset that lands on no header at all', async () => {
    const text = plain.toString('latin1');
    const entry = /2 1\n(\d{10})/.exec(text.slice(plainPrev));
    const bent = text.replace(entry[0], `2 1\n${String(Number(entry[1]) + 2).padStart(10, '0')}`);
    assert.equal(await refused(Buffer.from(bent, 'latin1')), 'original-object-header');
  });

  await t.test('/Encrypt, in the newest trailer or an older one', async () => {
    assert.equal(await refused(fixture('encrypted.original.pdf')), 'original-encrypted');
    const older = classicPdf(BODIES, `${TRAILER} /Encrypt 9 0 R`);
    const newer = Buffer.concat([older, classicTail(older, [[1, '<< /Title (New) >>']], `${TRAILER} /Prev ${lastTable(older)}`)]);
    assert.equal(await refused(newer), 'original-encrypted');
  });

  await t.test('a filter other than FlateDecode', async () => {
    assert.equal(await refused(xrefStreamPdf('/Filter /LZWDecode', Buffer.from([1, 0, 0]))), 'original-filter');
    assert.equal(await refused(xrefStreamPdf('/Filter /FlateDecode /DecodeParms << /Predictor 2 >>', zlib.deflateSync(Buffer.from([1, 0, 0])))), 'original-filter');
  });

  await t.test('no startxref in the final bytes', async () => {
    assert.equal(await refused(Buffer.from('%PDF-1.4\nno trailer here\n')), 'original-no-startxref');
  });

  await t.test('the inflate budget', async () => {
    assert.equal(await refused(xrefStreamPdf('/Filter /FlateDecode', zlib.deflateSync(Buffer.alloc(40 * 1024 * 1024)))), 'original-inflate-budget');
  });

  await t.test('the read budget', async () => {
    // A table of free entries longer than the budget: the reader widens its window until it stops.
    const count = Math.ceil(READ_BUDGET / 20) + 1;
    const table = `xref\n0 ${count}\n${'0000000000 65535 f\r\n'.repeat(count)}trailer\n<< /Size ${count} /Root 1 0 R >>\n`;
    const huge = Buffer.from(`%PDF-1.4\n${table}startxref\n9\n%%EOF\n`, 'latin1');
    assert.equal(await refused(huge), 'original-read-budget');
  });

  await t.test('bad syntax far from the window end is final, not a wider read', async () => {
    const padded = classicPdf([...BODIES, [5, `<< /Pad (${'x'.repeat(2 * 1024 * 1024)}) >>`]], TRAILER);
    // startxref names object 1, a plain dictionary rather than an xref stream.
    const text = padded.toString('latin1').replace(/startxref\n\d+/, 'startxref\n9');
    const { facts, reads } = await read(Buffer.from(text, 'latin1'));
    assert.equal(facts.error, 'original-syntax');
    assert.ok(reads.reduce((sum, [, n]) => sum + n, 0) < 16 * 1024);
  });

  await t.test('a short read from storage', async () => {
    const facts = await readOriginal(async (offset, n) => plain.subarray(offset, offset + n - 1), plain.length);
    assert.equal(facts.error, 'original-short-read');
  });
});
