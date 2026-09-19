import type { ReactNode } from 'react';

/**
 * Search-result marking as React nodes.
 *
 * The Angular screen handed an HTML string to `[innerHTML]` and needed a sanitiser to make that
 * safe. Here the parts are split apart and handed back as nodes, so React escapes every text run
 * and the only element this module can produce is `<mark>`.
 */

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
};

/** Server markup arrives HTML-escaped; React escapes again on the way out, so undo it once here. */
function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|#x27);/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity);
}

const escapeRegex = (token: string): string => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Split on the `<mark>` tags the index wrote; odd parts are what its analyzer matched. */
function fromServerMarkup(markup: string): ReactNode[] {
  return markup
    .split(/<\/?mark>/i)
    .map((part, index) =>
      index % 2 === 1 ? <mark key={index}>{decodeEntities(part)}</mark> : decodeEntities(part),
    );
}

/** Mark every occurrence of a whitespace-separated query token, case-insensitively. */
function markTokens(text: string, query: string): ReactNode[] {
  if (!text) return [];
  const tokens = query.split(/\s+/).filter(Boolean).map(escapeRegex);
  if (!tokens.length) return [text];
  const pattern = new RegExp(`(${tokens.join('|')})`, 'gi');
  return text
    .split(pattern)
    .map((part, index) => (index % 2 === 1 ? <mark key={index}>{part}</mark> : part));
}

/**
 * One result field, preferring what the search service matched.
 *
 * The index stems, so a search for `flood` matches `flooding` and a regex in the browser marks
 * neither. The fallback is not dead: Cosmos results carry no highlights, and neither does a field
 * whose text the frontend substituted, so client marking stays the answer for both.
 */
export function highlightField(
  serverMarkup: string | undefined | null,
  text: string | undefined,
  query: string,
): ReactNode[] {
  if (serverMarkup) return fromServerMarkup(serverMarkup);
  return markTokens(text ?? '', query);
}
