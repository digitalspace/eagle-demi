'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  parseArgs,
  fold,
  ladder,
  classifyLabel,
  tokenCoverage
} = require('../../src/scripts/probe-phrase-presence');

// No Cosmos call anywhere in this file. The classification ladder is pure string logic and is the
// part that can be wrong quietly; the transport fails loudly. Only the first needs pinning.

test('parseArgs requires a labels file and rejects nonsense', () => {
  assert.throws(() => parseArgs([]), /--labels/);
  assert.throws(() => parseArgs(['--labels', 'l.jsonl', '--max-chunks', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--labels', 'l.jsonl', '--nope']), /unknown argument/);
});

test('the ladder is a partition: the tightest matching rung wins', () => {
  const phrase = 'Tumbler Ridge';
  assert.strictEqual(ladder('near Tumbler Ridge today', phrase).rung, 'exact');
  // Same words, different whitespace and case — looser, so it must NOT report exact.
  assert.strictEqual(ladder('near tumbler\n  ridge today', phrase).rung, 'whitespace');
});

test('punctuation and dash differences land at punct, not despaced', () => {
  // An en-dash is not folded to a hyphen by NFKD; mapping all punctuation to space is what
  // catches it. If this ever reports `despaced`, the rung-2 transform has regressed.
  assert.strictEqual(ladder('the Kitimat–Summit corridor', 'Kitimat-Summit').rung, 'punct');
  assert.strictEqual(ladder('at St. John today', 'St John').rung, 'punct');
});

test('word-JOINING lands at despaced/joined — the defect under suspicion', () => {
  const v = classifyLabel('to voice my opposition',
    ['Laren: Iwant tovoicemyopposition to theKitimat-Summit project']);
  assert.strictEqual(v.class, 'despaced');
  assert.strictEqual(v.despacedKind, 'joined');
  // The evidence string is what makes the verdict checkable by a human.
  assert.match(v.evidence, /tovoicemyopposition/);
});

test('character-SPACING lands at despaced/split — opposite defect, same rung', () => {
  // The rung is symmetric, so the class alone would conflate two defects with opposite fixes.
  const v = classifyLabel('Tumbler Ridge', ['the Tum ble r Ridge area is']);
  assert.strictEqual(v.class, 'despaced');
  assert.strictEqual(v.despacedKind, 'split');
});

test('a seam-straddling phrase is straddle-*, and the same phrase in one chunk is not', () => {
  const straddled = classifyLabel('the environmental protection and mitigation plan',
    ['... the environmental protection', 'and mitigation plan shall ...']);
  assert.strictEqual(straddled.class, 'straddle-whitespace');

  const contained = classifyLabel('the environmental protection and mitigation plan',
    ['... the environmental protection and mitigation plan shall ...']);
  assert.strictEqual(contained.class, 'exact');
});

test('chunks are joined in the order given, so the caller must sort — pinned here', () => {
  // Cosmos SELECT * returns no order. The script sorts by chunkIndex before calling in; this pins
  // that a WRONG order genuinely fails, which is why the sort is not optional.
  const wrongOrder = classifyLabel('environmental protection and mitigation',
    ['and mitigation plan shall ...', '... the environmental protection']);
  assert.notStrictEqual(wrongOrder.class, 'straddle-whitespace');

  const rightOrder = classifyLabel('environmental protection and mitigation',
    ['... the environmental protection', 'and mitigation plan shall ...']);
  assert.strictEqual(rightOrder.class, 'straddle-whitespace');
});

test('a textless control scores absent with zero coverage', () => {
  const v = classifyLabel('Morrison Lake concentrations', ['<!-- image -->', '| | |']);
  assert.strictEqual(v.class, 'absent');
  assert.strictEqual(v.coverage, 0);
  assert.deepStrictEqual(v.missingTokens.sort(), ['concentrations', 'lake', 'morrison']);
});

test('a document with no chunks is its own class, never absent', () => {
  // Folding it into `absent` would conflate "extraction lost the text" with "never chunked",
  // which are different findings with different fixes.
  assert.strictEqual(classifyLabel('anything', []).class, 'no-chunks');
});

test('coverage is a fraction against the despaced document, not a boolean', () => {
  // `tumbler` must be found inside `tumblerridge` — the haystack is deliberately the most generous
  // form, so a low coverage means the letters really are not there.
  const { coverage, missingTokens } = tokenCoverage('Tumbler Ridge helipad', fold('the tumblerridge area').despaced);
  assert.strictEqual(coverage, 0.6667);
  assert.deepStrictEqual(missingTokens, ['helipad']);
});

test('fold maps every despaced character back to its original position', () => {
  // The evidence slice is built through this map; an off-by-one here prints the wrong span and
  // makes every despaced verdict unverifiable.
  const f = fold('a-b c');
  assert.strictEqual(f.despaced, 'abc');
  assert.strictEqual(f.spaced, 'a b c');
  assert.deepStrictEqual(f.toNf.map(i => 'a-b c'[i]), ['a', 'b', 'c']);
});
