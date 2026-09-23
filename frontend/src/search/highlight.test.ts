import { describe, expect, it } from 'vitest';
import { excerptAround, highlightParts, toTerms } from './highlight';

describe('toTerms', () => {
  it('keeps words of two characters or more, without their quotes or repeats', () => {
    expect(toTerms('"fish habitat" a fish')).toEqual(['fish', 'habitat']);
  });

  it('gives no terms for an empty or missing keyword', () => {
    expect(toTerms('')).toEqual([]);
    expect(toTerms(undefined)).toEqual([]);
    expect(toTerms('   ')).toEqual([]);
  });

  it('drops a word that is one character once its quotes are gone', () => {
    expect(toTerms('"a" \'b\' cd')).toEqual(['cd']);
  });
});

describe('highlightParts', () => {
  it('marks the matched substring, not the whole word', () => {
    expect(highlightParts('Resediment control', ['sediment'])).toEqual([
      { text: 'Re', hit: false },
      { text: 'sediment', hit: true },
      { text: ' control', hit: false },
    ]);
  });

  it('keeps the mark on the match after a letter whose lower case is longer', () => {
    expect(highlightParts('İzmir River', ['river'])).toEqual([
      { text: 'İzmir ', hit: false },
      { text: 'River', hit: true },
    ]);
  });

  it('matches a term holding regex characters as plain text', () => {
    expect(highlightParts('s.11 (b) sx11', ['s.11'])).toEqual([
      { text: 's.11', hit: true },
      { text: ' (b) sx11', hit: false },
    ]);
  });

  it('merges two terms that overlap into one run', () => {
    expect(highlightParts('sediment', ['sediment', 'diment'])).toEqual([{ text: 'sediment', hit: true }]);
  });

  it('merges terms that overlap only in part into one run', () => {
    expect(highlightParts('xabcdx', ['abc', 'cd'])).toEqual([
      { text: 'x', hit: false },
      { text: 'abcd', hit: true },
      { text: 'x', hit: false },
    ]);
  });

  it('leaves text with no term untouched', () => {
    expect(highlightParts('Mine permit', [])).toEqual([{ text: 'Mine permit', hit: false }]);
  });

  it('matches regardless of case and keeps the text as written', () => {
    expect(highlightParts('Fish and FISH', ['fish'])).toEqual([
      { text: 'Fish', hit: true },
      { text: ' and ', hit: false },
      { text: 'FISH', hit: true },
    ]);
  });

  it('marks hits in reading order whatever order the terms came in', () => {
    expect(highlightParts('habitat for fish', ['fish', 'habitat'])).toEqual([
      { text: 'habitat', hit: true },
      { text: ' for ', hit: false },
      { text: 'fish', hit: true },
    ]);
  });

  it('ignores a one-character term passed in directly', () => {
    expect(highlightParts('a cat', ['a'])).toEqual([{ text: 'a cat', hit: false }]);
  });
});

describe('excerptAround', () => {
  it('starts a collapsed excerpt at the first hit rather than at the top', () => {
    const text = `${'a'.repeat(300)} fish habitat`;

    expect(excerptAround(text, ['fish'], { length: 40 })).toBe(`…${'a'.repeat(40)}…`);
  });

  it('leaves the excerpt at the top when the hit is already near it', () => {
    expect(excerptAround('fish habitat', ['fish'], { length: 40 })).toBe('fish habitat');
  });

  it('keeps the run-up in front of a later hit', () => {
    const text = `${'x'.repeat(200)}fish`;

    expect(excerptAround(text, ['fish'], { before: 10, length: 14 })).toBe(`…${'x'.repeat(10)}fish`);
  });

  it('treats a hit exactly at the window edge as near the top', () => {
    const text = `${'a'.repeat(140)}fish`;

    expect(excerptAround(text, ['fish'])).toBe(text);
  });

  it('moves the excerpt once the hit is one character past the window', () => {
    const text = `${'a'.repeat(141)}fish`;

    expect(excerptAround(text, ['fish'])).toBe(`…${'a'.repeat(80)}fish`);
  });

  it('cuts long text with no terms from the top and marks the cut', () => {
    expect(excerptAround('abcdef', [], { length: 3 })).toBe('abc…');
  });
});
