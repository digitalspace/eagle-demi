/**
 * Marking search hits in plain text, and the excerpt that starts at the first one. Pure functions,
 * so the row components, the passage list and the specs all read the same match scanner.
 */

/** Terms shorter than this match inside almost every word, so the row would be all highlight. */
const MIN_TERM_LENGTH = 2;

export interface ExcerptOptions {
  /** A hit at or before this offset is close enough to the top that the excerpt starts at 0. */
  window?: number;
  /** Characters of run-up kept in front of a later hit, so the match has context. */
  before?: number;
  /** How much text the excerpt carries. Matches the clamp length the list row uses. */
  length?: number;
}

/**
 * The keyword as match terms: whitespace-separated words with quotes stripped. Quoted phrases are
 * a search-side concept — the API decides what a `"exact phrase"` matches, and the highlight only
 * has to mark the words that came back.
 */
export function toTerms(keyword: string | undefined): string[] {
  if (!keyword) return [];
  const terms: string[] = [];
  for (const word of keyword.split(/\s+/)) {
    const stripped = word.replace(/["']/g, '').trim();
    if (stripped.length >= MIN_TERM_LENGTH && !terms.includes(stripped)) {
      terms.push(stripped);
    }
  }
  return terms;
}

interface Span {
  from: number;
  to: number;
}

/** Every match of every term, overlaps merged, in reading order. */
function matchSpans(text: string, terms: string[]): Span[] {
  const found: Span[] = [];

  for (const term of terms) {
    if (term.length < MIN_TERM_LENGTH) continue;
    // A case-blind regex, not `toLowerCase()`: lowering "İ" adds a character and shifts every offset after it.
    const needle = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
    for (const match of text.matchAll(needle)) {
      found.push({ from: match.index, to: match.index + match[0].length });
    }
  }

  found.sort((a, b) => a.from - b.from || a.to - b.to);

  const merged: Span[] = [];
  for (const span of found) {
    const last = merged[merged.length - 1];
    // Two terms that overlap ("sediment" and "diment") must not nest one <mark> inside another.
    if (last && span.from <= last.to) {
      last.to = Math.max(last.to, span.to);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/** One run of the text, and whether the search matched it. */
export interface HighlightPart {
  text: string;
  hit: boolean;
}

/**
 * The text split into matched and unmatched runs. A substring match, not a word one: typing
 * "sediment" marks the middle of "resediment", which is what the API matched on.
 */
export function highlightParts(text: string, terms: string[]): HighlightPart[] {
  const spans = terms.length > 0 ? matchSpans(text, terms) : [];
  if (spans.length === 0) return [{ text, hit: false }];

  const parts: HighlightPart[] = [];
  let at = 0;
  for (const span of spans) {
    if (span.from > at) parts.push({ text: text.slice(at, span.from), hit: false });
    parts.push({ text: text.slice(span.from, span.to), hit: true });
    at = span.to;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}

/**
 * A collapsed body starts at the first hit rather than at the top: a match buried in paragraph
 * three is no use if the row shows paragraph one. A hit already near the top leaves the excerpt
 * where it is, so the common case reads as the record was written.
 */
export function excerptAround(
  text: string,
  terms: string[],
  options: ExcerptOptions = {},
): string {
  const { window = 140, before = 80, length = 260 } = options;
  const cut = (value: string, leading: boolean): string => {
    const tail = value.length > length ? '…' : '';
    return (leading ? '…' : '') + value.slice(0, length) + tail;
  };

  const spans = terms.length > 0 ? matchSpans(text, terms) : [];
  const first = spans[0];
  if (!first || first.from <= window) return cut(text, false);

  const from = Math.max(0, first.from - before);
  return cut(text.slice(from), from > 0);
}
