'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  score,
  parseArgs,
  parseLabels,
  rankOf,
  summarize
} = require('../../src/scripts/score-retrieval');

// No AI Search call anywhere in this file. The scoring arithmetic is the part that can be wrong
// quietly; the transport is the part that fails loudly. Only the first needs pinning.

test('parseArgs requires a labels file', () => {
  assert.throws(() => parseArgs([]), /--labels/);
});

test('parseArgs defaults fuzzy ON, because that is the path the frontend sends', () => {
  assert.strictEqual(parseArgs(['--labels', 'l.jsonl']).fuzzy, true);
  assert.strictEqual(parseArgs(['--labels', 'l.jsonl', '--no-fuzzy']).fuzzy, false);
});

test('parseArgs rejects a nonsense --top rather than scoring against it', () => {
  assert.throws(() => parseArgs(['--labels', 'l.jsonl', '--top', '0']), /positive integer/);
});

test('parseLabels keeps source line numbers so a miss names the line to re-label', () => {
  const labels = parseLabels(
    '# labels for the worst stratum, 2026-08-03\n' +
    '\n' +
    '{"documentId":"doc-a","phrase":"Tumbler Ridge"}\n' +
    '{"documentId":"doc-b","phrase":"Fort St. John","note":"cover page"}\n'
  );

  assert.strictEqual(labels.length, 2);
  assert.strictEqual(labels[0].line, 3);
  assert.strictEqual(labels[1].line, 4);
  assert.strictEqual(labels[1].note, 'cover page');
});

// The denominator rule. A skipped bad line would shrink `scored` and silently RAISE recall, which
// is the one way a scorecard can be wrong in the flattering direction.
test('parseLabels throws on a malformed line instead of skipping it', () => {
  assert.throws(() => parseLabels('{"documentId":"doc-a"'), /line 1: not valid JSON/);
  assert.throws(() => parseLabels('{"phrase":"no id here"}'), /line 1: missing documentId/);
  assert.throws(() => parseLabels('{"documentId":"doc-a","phrase":"  "}'), /line 1: missing phrase/);
  assert.throws(() => parseLabels('# nothing but a comment\n'), /no labels/);
});

test('rankOf is 1-based and 0 means absent', () => {
  const items = [
    { documentId: 'doc-x', chunkId: 'c1' },
    { documentId: 'doc-a', chunkId: 'c2' }
  ];
  assert.strictEqual(rankOf(items, 'doc-a'), 2);
  assert.strictEqual(rankOf(items, 'doc-missing'), 0);
  assert.strictEqual(rankOf([], 'doc-a'), 0);
});

// Several chunks of one document can hit. Someone looking for the document cares where it FIRST
// appears; counting its later chunks would score the same document as if it ranked worse.
test('rankOf takes the best placement when a document hits more than once', () => {
  const items = [
    { documentId: 'doc-a', chunkId: 'c1' },
    { documentId: 'doc-a', chunkId: 'c2' }
  ];
  assert.strictEqual(rankOf(items, 'doc-a'), 1);
});

test('summarize computes recall@k over the labels that were actually queried', () => {
  const results = [
    { documentId: 'a', phrase: 'p', line: 1, rank: 1 },
    { documentId: 'b', phrase: 'p', line: 2, rank: 3 },
    { documentId: 'c', phrase: 'p', line: 3, rank: 9 },
    { documentId: 'd', phrase: 'p', line: 4, rank: 0 }
  ];
  const s = summarize(results, 10);

  assert.strictEqual(s.labels, 4);
  assert.strictEqual(s.scored, 4);
  assert.strictEqual(s.found, 3);
  assert.strictEqual(s.recallAt[1], 0.25);
  assert.strictEqual(s.recallAt[5], 0.5);
  assert.strictEqual(s.recallAt[10], 0.75);
  assert.deepStrictEqual(s.misses.map(m => m.documentId), ['d']);
  assert.deepStrictEqual(s.rankedBelowFirst.map(m => m.documentId), ['b', 'c']);
});

// recall@1 cannot tell "ranked second" from "absent", and those are very different failures —
// one is a ranking problem, the other means the words are not in the index at all.
test('summarize reports MRR, which separates a near miss from a total miss', () => {
  const nearMiss = summarize([{ documentId: 'a', phrase: 'p', line: 1, rank: 2 }], 10);
  const totalMiss = summarize([{ documentId: 'a', phrase: 'p', line: 1, rank: 0 }], 10);

  assert.strictEqual(nearMiss.recallAt[1], 0);
  assert.strictEqual(totalMiss.recallAt[1], 0);
  assert.strictEqual(nearMiss.mrr, 0.5);
  assert.strictEqual(totalMiss.mrr, 0);
});

// Folding a transport failure into the misses would blame the corpus for a network error.
test('summarize excludes errored labels from the denominator and reports them apart', () => {
  const results = [
    { documentId: 'a', phrase: 'p', line: 1, rank: 1 },
    { documentId: 'b', phrase: 'p', line: 2, rank: 0, error: 'ETIMEDOUT' }
  ];
  const s = summarize(results, 10);

  assert.strictEqual(s.labels, 2);
  assert.strictEqual(s.scored, 1);
  assert.strictEqual(s.errored, 1);
  assert.strictEqual(s.recallAt[1], 1);
  assert.deepStrictEqual(s.misses, []);
  assert.strictEqual(s.errors[0].error, 'ETIMEDOUT');
});

// Past --top every k can only ever look like a miss, so reporting it as recall would invent a
// failure the run never measured.
test('summarize omits recall@k beyond --top and names what it did not measure', () => {
  const s = summarize([{ documentId: 'a', phrase: 'p', line: 1, rank: 1 }], 3);

  assert.deepStrictEqual(Object.keys(s.recallAt), ['1']);
  assert.deepStrictEqual(s.recallKsNotMeasured, [5, 10, 20, 50]);
});

// The regression this pins: a consumer reading recallAt['50'] off a run that never measured 50.
// Every k the run DID measure must be present, so nobody has to fall back to a default that
// silently substitutes a shallower number for a deeper one.
test('summarize reports the deep cutoffs when --top actually reaches them', () => {
  const results = [1, 12, 30, 45, 0].map((rank, i) => ({
    documentId: `d${i}`, phrase: 'p', line: i + 1, rank
  }));

  const s = summarize(results, 50);

  assert.deepStrictEqual(Object.keys(s.recallAt), ['1', '5', '10', '20', '50']);
  assert.deepStrictEqual(s.recallKsNotMeasured, []);
  assert.strictEqual(s.recallAt[10], 0.2);
  assert.strictEqual(s.recallAt[50], 0.8);
});

// The reason this guard exists, found by running the CLI locally before it had one: with
// SEARCH_ENDPOINT unset, searchChunks() returns [] by design, and the report came back a
// confident `recall@1: 0` against a service it had never contacted. A zero that means "unset app
// setting" and a zero that means "unfindable corpus" must not print the same.
test('score refuses to run when search is unconfigured, rather than reporting 0% recall', async () => {
  const labelsFile = path.join(os.tmpdir(), 'score-retrieval-guard.jsonl');
  fs.writeFileSync(labelsFile, '{"documentId":"doc-a","phrase":"Tumbler Ridge"}\n');
  const saved = process.env.SEARCH_ENDPOINT;
  delete process.env.SEARCH_ENDPOINT;

  try {
    await assert.rejects(
      () => score(['--labels', labelsFile]),
      /SEARCH_ENDPOINT is not set/
    );
  } finally {
    if (saved !== undefined) process.env.SEARCH_ENDPOINT = saved;
    fs.rmSync(labelsFile, { force: true });
  }
});

test('summarize returns nulls rather than NaN when nothing could be scored', () => {
  const s = summarize([{ documentId: 'a', phrase: 'p', line: 1, rank: 0, error: 'boom' }], 10);

  assert.strictEqual(s.scored, 0);
  assert.strictEqual(s.mrr, null);
  assert.strictEqual(s.recallAt[1], null);
});
