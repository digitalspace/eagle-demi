'use strict';

/**
 * The assertions are on PLAIN STRING COMPARISON of two keys, not on the key text alone: the index
 * orders `displayNameSort` by codepoint, so "does 2 come before 10" is the only question that
 * matters, and a key that looks right while comparing wrong is the bug this file exists to catch.
 */

const test = require('node:test');
const assert = require('node:assert');

const { naturalSortKey, DIGIT_WIDTH } = require('../../src/helpers/natural-sort');

/** What AI Search does with two `displayNameSort` values. */
const before = (a, b) => naturalSortKey(a) < naturalSortKey(b);

test('naturalSortKey', async (t) => {
  await t.test('pads a digit run so 2 sorts before 10', () => {
    assert.strictEqual(naturalSortKey('Item 2'), 'item 000000000002');
    assert.strictEqual(naturalSortKey('Item 10'), 'item 000000000010');
    assert.ok(before('Item 2', 'Item 10'), 'the whole point: codepoint order puts "10" first');
  });

  await t.test('pads every run, not just the first', () => {
    assert.ok(before('Appendix 2 Part 10', 'Appendix 2 Part 11'));
    assert.ok(before('Appendix 2 Part 11', 'Appendix 10 Part 1'));
  });

  await t.test('is case-insensitive', () => {
    assert.strictEqual(naturalSortKey('APPENDIX a'), naturalSortKey('appendix A'));
  });

  await t.test('folds accents, so Ébauche sorts with the Es', () => {
    assert.strictEqual(naturalSortKey('Ébauche'), 'ebauche');
    assert.ok(before('Ébauche', 'Fraser'), 'unfolded, É is above every ASCII letter');
  });

  await t.test('strips leading punctuation so "(Draft) Report" lands beside "Report"', () => {
    assert.strictEqual(naturalSortKey('(Draft) Report'), 'draft) report');
    assert.ok(before('(Draft) Report', 'Environment Plan'));
  });

  await t.test('collapses and trims whitespace', () => {
    assert.strictEqual(naturalSortKey('  Water   Quality\tPlan '), 'water quality plan');
  });

  await t.test('leaves a digit run longer than the pad width whole', () => {
    const long = '1'.repeat(DIGIT_WIDTH + 3);
    assert.strictEqual(naturalSortKey(`Permit ${long}`), `permit ${long}`);
  });

  await t.test('an absent name is an empty key, never "null"', () => {
    assert.strictEqual(naturalSortKey(null), '');
    assert.strictEqual(naturalSortKey(undefined), '');
    assert.strictEqual(naturalSortKey(''), '');
  });
});
