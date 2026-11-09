'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { compare } = require('../../scripts/eslint-size-freeze.cjs');

const baseline = { 'src/big.js': { 'max-lines': [500], complexity: [30, 25] } };

test('an unchanged tree passes and keeps its ceilings', () => {
  const { next, problems } = compare(baseline, structuredClone(baseline));

  assert.deepStrictEqual(problems, []);
  assert.deepStrictEqual(next, baseline);
});

test('a new file over the ceiling fails and is not added to the baseline', () => {
  const { next, problems } = compare(baseline, { ...baseline, 'src/new.js': { 'max-lines': [420] } });

  assert.deepStrictEqual(problems, ['new src/new.js max-lines: 420 is over the limit']);
  assert.strictEqual(next['src/new.js'], undefined);
});

test('a recorded file that grows fails and keeps its old ceiling', () => {
  const { next, problems } = compare(baseline, { 'src/big.js': { 'max-lines': [510], complexity: [30, 25] } });

  assert.deepStrictEqual(problems, ['grown src/big.js max-lines: 510 is over ceiling 500']);
  assert.deepStrictEqual(next['src/big.js']['max-lines'], [500]);
});

test('a deleted file is a stale entry that tightening drops', () => {
  const { next, problems } = compare(baseline, {});

  assert.strictEqual(problems.length, 3);
  assert.ok(problems.every((p) => p.startsWith('stale src/big.js')), problems.join('\n'));
  assert.deepStrictEqual(next, {});
});

test('a shrunk function is stale and tightening lowers its ceiling', () => {
  const { next, problems } = compare(baseline, { 'src/big.js': { 'max-lines': [500], complexity: [30, 21] } });

  assert.deepStrictEqual(problems, ['stale src/big.js complexity: 21 is under ceiling 25, run --tighten']);
  assert.deepStrictEqual(next['src/big.js'].complexity, [30, 21]);
});
