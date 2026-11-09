'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

const { compare, judge } = require('../../scripts/eslint-size-freeze.cjs');

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

function tighten(t, current) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'size-freeze-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'baseline.json');
  fs.writeFileSync(file, JSON.stringify(baseline));
  const printed = [];
  t.mock.method(process.stderr, 'write', (line) => printed.push(line));
  const code = judge('--tighten', file, current);
  t.mock.restoreAll();
  return { code, printed, written: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('--tighten with only stale entries exits 0 and writes the lower ceilings', (t) => {
  const { code, printed, written } = tighten(t, { 'src/big.js': { 'max-lines': [480], complexity: [30, 25] } });

  assert.strictEqual(code, 0);
  assert.deepStrictEqual(printed, []);
  assert.deepStrictEqual(written['src/big.js']['max-lines'], [480]);
});

test('--tighten with a grown offender exits 1 and prints it', (t) => {
  const { code, printed } = tighten(t, { 'src/big.js': { 'max-lines': [510], complexity: [30, 21] } });

  assert.strictEqual(code, 1);
  assert.deepStrictEqual(printed, ['grown src/big.js max-lines: 510 is over ceiling 500\n']);
});
