'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseKeepIds, readKeepIds } = require('../../src/utils/keep-ids');

test('parseKeepIds drops full-line and trailing # comments', () => {
  assert.deepStrictEqual(parseKeepIds('# spare these\nabc  # Pacific Link\ndef#note\n'), ['abc', 'def']);
});

test('parseKeepIds skips blank and whitespace-only lines', () => {
  assert.deepStrictEqual(parseKeepIds('\n  abc  \n\t\n\r\ndef\r\n'), ['abc', 'def']);
});

test('parseKeepIds drops duplicates, keeping the first position', () => {
  assert.deepStrictEqual(parseKeepIds('b\na\nb\nc\na\n'), ['b', 'a', 'c']);
});

test('parseKeepIds keeps file order rather than sorting', () => {
  assert.deepStrictEqual(parseKeepIds('zeta\nalpha\nmid\n'), ['zeta', 'alpha', 'mid']);
});

test('readKeepIds parses the file it reads', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-ids-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'keep.txt');
  fs.writeFileSync(file, '# header\nabc\nabc\ndef\n');

  assert.deepStrictEqual(readKeepIds(file), ['abc', 'def']);
});

test('readKeepIds throws ENOENT for a missing file', () => {
  const missing = path.join(os.tmpdir(), 'keep-ids-absent', 'nope.txt');
  assert.throws(() => readKeepIds(missing), { code: 'ENOENT' });
});
