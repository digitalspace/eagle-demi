'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { scoreChunk, mulberry32 } = require('../../src/scripts/audit-chunk-quality');

// Real text pulled from the live corpus on 2026-07-31, not invented. A scorer tuned against
// imagined garbage grades imagined garbage.
const REAL_OCR_GARBAGE =
  'Skatng Club will be lulding its rugistralnn night st th Cnstum dlld IDistrctC nn Sepl 4 ' +
  'frm 6 t 8 pm fr th cmng ssn nd ll mmbrs r skd t ttnd';

const REAL_PLACEHOLDER_CHUNK =
  '<!-- image -->\n\n<!-- image -->\n\n<!-- image -->\n\n<!-- image -->';

const CLEAN_PROSE =
  'The proponent submitted an application for an environmental assessment certificate in ' +
  'March 2019. The project includes a natural gas pipeline and associated infrastructure ' +
  'located approximately 40 kilometres north of Fort St. John, British Columbia.';

// Tables of measurements are legitimately low on letters and high on digits, and they are
// perfectly findable content. Scoring them as garbage would manufacture a problem and then
// "fix" real data out of the index.
const NUMERIC_TABLE =
  '| Well | Depth (m) | Transmissivity | Conductivity |\n' +
  '| PH12-3-3 | 113.2 | 3E-06 | 8E-08 |\n' +
  '| PH12-4-1 | 146.9 | 6E-06 | 2E-07 |\n' +
  '| PH12-5-2 | 177.4 | 1E-05 | 4E-07 |';

test('chunk quality scorer', async (t) => {
  await t.test('clean prose scores clean', () => {
    const s = scoreChunk(CLEAN_PROSE);
    assert.strictEqual(s.verdict, 'clean', `expected clean, got ${JSON.stringify(s.reasons)}`);
  });

  // THE test that makes the scorer worth having: it must fail its own fixtures. A probe that
  // cannot fail proves nothing.
  await t.test('real OCR debris from the corpus scores garbage', () => {
    const s = scoreChunk(REAL_OCR_GARBAGE);
    assert.strictEqual(s.verdict, 'garbage');
    assert.ok(s.reasons.includes('vowelless-tokens'), JSON.stringify(s.reasons));
  });

  await t.test('a chunk of nothing but image placeholders scores garbage', () => {
    const s = scoreChunk(REAL_PLACEHOLDER_CHUNK);
    assert.strictEqual(s.verdict, 'garbage');
    assert.ok(s.reasons.includes('mostly-image-placeholders'), JSON.stringify(s.reasons));
    assert.strictEqual(s.metrics.placeholders, 4);
  });

  // The false-positive guard. Without it the scorer would report a quality crisis made of
  // perfectly good tables.
  await t.test('a numeric data table is NOT garbage', () => {
    const s = scoreChunk(NUMERIC_TABLE);
    assert.notStrictEqual(s.verdict, 'garbage',
      `data tables must survive scoring: ${JSON.stringify(s.reasons)}`);
  });

  // Placeholders are counted once, as placeholders — not a second time as poor letter density.
  // Counting one defect twice makes the thresholds impossible to reason about.
  await t.test('placeholder markup does not also depress the letter-density score', () => {
    const withPlaceholder = scoreChunk(`<!-- image -->\n\n${CLEAN_PROSE}`);
    const without = scoreChunk(CLEAN_PROSE);
    assert.strictEqual(withPlaceholder.metrics.alphaRatio, without.metrics.alphaRatio);
    assert.strictEqual(withPlaceholder.verdict, 'clean');
  });

  // The false positive that made the first audit run report 29% garbage. This is real text from a
  // BC Hydro Water Use Plan: clean prose that merely CONTAINS a table-of-contents dot leader. The
  // first scorer condemned it on the LENGTH of the longest repeated run; a document is not damaged
  // for having a table of contents.
  await t.test('prose containing a dot leader is not condemned for it', () => {
    const s = scoreChunk(
      'Peace Project Water Use Plan, revised for acceptance by the Comptroller of Water Rights, ' +
      'August 21, 2007. The plan describes operating parameters for the facility and the ' +
      'monitoring programs that support them.\n' +
      'Introduction .......................................................... 5\n' +
      'The Comptroller accepted the plan following a public review process that ran through 2006.'
    );
    assert.notStrictEqual(s.verdict, 'garbage', JSON.stringify(s.reasons));
  });

  // KNOWN OVER-REPORT, asserted so the audit is read with it in mind. A table-of-contents PAGE
  // scores garbage: dot leaders push separatorRatio to 0.4-0.6 and the page numbers push letter
  // density down, yet the section titles between them are findable content.
  //
  // Deliberately NOT tuned away. Three threshold passes already went into separating debris from
  // tables, and this classifier only decides which documents a human reads next — the verdict
  // metric is retrieval. Tuning it further would be fitting an instrument to its own fixtures.
  // The number this produces is therefore an UPPER bound on damage, and the report says so.
  await t.test('a table-of-contents page over-reports as garbage (known limitation)', () => {
    const s = scoreChunk(
      '7.0 EXPECTED WATER MANAGEMENT IMPLICATIONS ......................... 13\n' +
      '7.1 Other Licenced Uses of Water ................................... 13\n' +
      '7.2 Riparian Rights ................................................ 14\n' +
      '7.3 Fisheries and Aquatic Habitat .................................. 15\n' +
      '8.0 IMPLEMENTATION OF RECOMMENDATIONS ............................... 16'
    );
    assert.strictEqual(s.verdict, 'garbage',
      'if this starts passing, the scorer improved — re-run the audit and update the numbers');
  });

  // A chunk that is nothing BUT a rule is real junk, and must still be caught.
  await t.test('a chunk that is only a horizontal rule is garbage', () => {
    const s = scoreChunk('-'.repeat(200));
    assert.strictEqual(s.verdict, 'garbage');
    assert.ok(s.reasons.includes('mostly-separator-furniture'), JSON.stringify(s.reasons));
  });

  // Whitespace columns are still columns. The first tabular check only knew pipe tables and duly
  // flagged a table of earthquake records as OCR debris.
  await t.test('a whitespace-column data table is not garbage', () => {
    const s = scoreChunk(
      '84  -125.20  14.2  0.8  No  28 km ESE of Ucluelet,BC  2014/01/07\n' +
      '01:31:26  68.24  -136.20  20.0  3.0  No  110 km W of Inuvik,NT\n' +
      '23:06:41  56.98  -122.26  1.0  2.2  No  119 km WNW of Fort St John,BC'
    );
    assert.notStrictEqual(s.verdict, 'garbage', JSON.stringify(s.reasons));
    assert.strictEqual(s.metrics.tabular, true);
  });

  // KNOWN BLIND SPOT, asserted so it stays known. `Tum ble r Ridge` / `Ge orge` is real corpus
  // text — a text-layer character-spacing artefact, not OCR — and every cheap metric reads it as
  // clean: the fragments are all pronounceable and none is vowelless. Detecting it needs a
  // dictionary or a bigram model, which this scorer deliberately does not carry.
  //
  // This is precisely why the VERDICT metric is retrieval, not heuristics: searching "Tumbler
  // Ridge" fails to retrieve this document, which is the defect the reader actually experiences.
  await t.test('spaced-out words are a known blind spot the heuristics cannot see', () => {
    const s = scoreChunk('Tum ble r Ridge Hudson s Hope Kitim at Prince Ge orge Macke n zie');
    assert.strictEqual(s.verdict, 'clean',
      'if this ever starts failing the scorer got smarter — update the report, not just the test');
  });

  await t.test('empty and whitespace input do not throw or divide by zero', () => {
    for (const input of ['', '   ', null, undefined]) {
      const s = scoreChunk(input);
      assert.ok(['clean', 'marginal', 'garbage'].includes(s.verdict));
      assert.strictEqual(Number.isFinite(s.metrics.alphaRatio), true);
    }
  });

  // Two runs over an unchanged corpus must produce identical JSON, or a before/after comparison
  // later means nothing.
  await t.test('sampling is seeded, so runs are reproducible', () => {
    const a = Array.from({ length: 5 }, mulberry32(1));
    const b = Array.from({ length: 5 }, mulberry32(1));
    const c = Array.from({ length: 5 }, mulberry32(2));
    assert.deepStrictEqual(a, b, 'same seed must give the same sequence');
    assert.notDeepStrictEqual(a, c, 'a different seed must give a different sequence');
  });
});
