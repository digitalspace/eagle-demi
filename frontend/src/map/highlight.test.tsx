import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { highlightField } from './highlight';

const show = (nodes: ReturnType<typeof highlightField>) =>
  render(<span data-testid="field">{nodes}</span>);

const field = () => screen.getByTestId('field');
const marks = () => [...field().querySelectorAll('mark')].map((mark) => mark.textContent);

describe('highlightField', () => {
  it('marks every occurrence of a query token, whatever its case', () => {
    show(highlightField(null, 'Copper Ridge copper mine', 'copper'));
    expect(field()).toHaveTextContent('Copper Ridge copper mine');
    expect(marks()).toEqual(['Copper', 'copper']);
  });

  it('marks each whitespace-separated token', () => {
    show(highlightField(undefined, 'Copper Ridge Mine', 'ridge mine'));
    expect(marks()).toEqual(['Ridge', 'Mine']);
  });

  it('treats a query token as text, not as a pattern', () => {
    show(highlightField(null, 'Phase 1 (amended)', '(amended)'));
    expect(marks()).toEqual(['(amended)']);
  });

  it('marks nothing when nothing was typed', () => {
    show(highlightField(null, 'Copper Ridge', ''));
    expect(field()).toHaveTextContent('Copper Ridge');
    expect(marks()).toEqual([]);
  });

  it('prefers what the index matched over what the browser can find', () => {
    // The analyzer stems, so it marks "flooding" for a search of "flood"; a regex would not.
    show(highlightField('Peace River <mark>flooding</mark>', 'Peace River flooding', 'flood'));
    expect(marks()).toEqual(['flooding']);
  });

  it('decodes the escaped entities in server markup exactly once', () => {
    show(highlightField('Smith &amp; Sons <mark>Mine</mark>', 'ignored', 'mine'));
    expect(field()).toHaveTextContent('Smith & Sons Mine');
    expect(marks()).toEqual(['Mine']);
  });

  it('never builds an element out of markup in the field text', () => {
    show(highlightField('<mark>A</mark> <img src=x onerror=alert(1)>', 'ignored', ''));
    expect(field().querySelector('img')).toBeNull();
    expect(field()).toHaveTextContent('<img src=x onerror=alert(1)>');
  });
});
