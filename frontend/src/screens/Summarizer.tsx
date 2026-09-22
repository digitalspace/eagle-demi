import { useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchSearchSummary, searchRetry } from '../api/search';
import { useDownload } from '../hooks/useDownload';
import { cad } from '../dates';

const searchBox: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '0.8rem 1rem 0.8rem 3rem',
  border: 'var(--layout-border-width-small) solid var(--surface-color-border-default)',
  borderRadius: 'var(--layout-border-radius-small)',
  font: 'var(--typography-regular-body)',
};

const askButton: CSSProperties = {
  background: 'var(--surface-color-primary-default)',
  color: 'var(--surface-color-background-white)',
  border: 'none',
  borderRadius: 'var(--layout-border-radius-small)',
  padding: '0.8rem 1.6rem',
  font: 'var(--typography-bold-body)',
  cursor: 'pointer',
};

const downloadButton: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'var(--typography-bold-small-body)',
  color: 'var(--typography-color-link)',
  textDecoration: 'underline',
  cursor: 'pointer',
};

const SKELETON_PILLS = [1, 2, 3];

/** The one-line answer for a null summary that came with a reason. */
function reasonText(reason: string): string {
  switch (reason) {
    case 'no_results':
      return 'Nothing in the registry matched that. Try different or fewer words.';
    case 'disabled':
      return 'The summariser is switched off in this environment.';
    case 'not_configured':
      return 'The summariser is enabled but not yet configured. This is a deployment issue, not your query.';
    case 'mock_mode':
      return 'Demo mode is active, so no live registry data is available to summarise.';
    case 'timeout':
      return 'The summariser took too long to answer. Try again, or narrow the question.';
    default:
      return 'The summariser could not answer that. The search results themselves are unaffected.';
  }
}

/**
 * The AI Summary page. Step 5 of the search pipeline on a surface of its own — see wiki ADR-006.
 *
 * It briefly lived as a panel on deep-search, where it fired a model call on every debounced
 * keystroke of an ordinary keyword search. Here it runs only when someone asks a question.
 */
export function Summarizer() {
  const [query, setQuery] = useState('');
  /** The question a running answer belongs to; typing does not disturb it until Ask is pressed. */
  const [asked, setAsked] = useState('');
  const download = useDownload();

  const answer = useQuery({
    queryKey: ['search-summary', asked],
    // The signal is consumed, so React Query aborts this read once nothing observes it — on
    // unmount, and when a newer question takes the key.
    queryFn: ({ signal }) => fetchSearchSummary(asked, { signal }),
    enabled: !!asked,
    ...searchRetry,
  });

  /**
   * Submit on Enter or on the button — NOT on input.
   *
   * Index search debounces keystrokes because its legs are cheap index reads. This leg costs
   * tokens and several seconds, so it is explicit: the user finishes their question, then asks.
   */
  const ask = () => {
    const next = query.trim();
    // Asking nothing clears the answer rather than stranding the last one above an empty box.
    if (!next) setAsked('');
    else if (next === asked) void answer.refetch();
    else setAsked(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') ask();
  };

  const loading = !!asked && answer.isFetching;
  // React Query keeps the last answer beside isError; a failed re-ask must not leave that answer
  // on screen under a fresh error, so the whole answer goes when the read fails.
  const answered = loading || answer.isError ? null : answer.data;
  const summary = answered?.summary ?? null;
  const citations = answered?.citations ?? [];
  const cost = answered?.estimatedCostCad ?? null;
  const usage = answered?.usage ?? null;
  // A failed read and a null answer with a reason land in the same place: the callout below.
  const reason = loading ? null : answer.isError ? 'error' : (answered?.reason ?? null);

  return (
    <>
      <div className="screen-header">
        <div className="screen-header__text">
          <h1>AI Search Summary</h1>
          <p>
            The registry is searched exactly as content search searches it, and the top matching passages are
            summarised. Every claim cites the passage it came from.
          </p>
        </div>
      </div>

      <section className="panel panel--padded">
        <div style={{ display: 'flex', gap: 'var(--layout-margin-small)', flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', flex: 1, minWidth: '18rem' }}>
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: '1rem',
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--typography-color-secondary)',
              }}
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="16.5" y1="16.5" x2="21" y2="21" />
            </svg>
            <input
              id="demi-search-summary"
              type="text"
              placeholder="e.g. pipeline watercourse crossing mitigation"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
              disabled={loading}
              aria-label="Ask a question of the registry"
              style={searchBox}
            />
          </div>
          <button type="button" onClick={ask} disabled={loading || !query.trim()} style={askButton}>
            {loading ? 'Asking…' : 'Ask'}
          </button>
        </div>
        <p className="panel__lede" style={{ marginTop: 'var(--layout-margin-small)' }}>
          Keywords work better than full sentences. Answers are generated from retrieved passages only and cannot
          draw on anything outside the registry.
        </p>
      </section>

      {summary ? (
        <>
          <section className="panel panel--padded">
            <h2
              className="panel__title panel__title--inline"
              style={{ display: 'flex', alignItems: 'center', gap: 'var(--layout-margin-small)', flexWrap: 'wrap' }}
            >
              Answer
              <span className="pill pill--info">AI-generated from the sources below</span>
            </h2>
            {/* Model output as a text node: never markup, so nothing it wrote can render as HTML. */}
            <p style={{ font: 'var(--typography-regular-body)', margin: 0 }}>{summary}</p>
            {cost !== null && (
              <div
                style={{
                  marginTop: 'var(--layout-margin-medium)',
                  paddingTop: 'var(--layout-margin-small)',
                  borderTop: 'var(--layout-border-width-small) solid var(--surface-color-border-default)',
                  font: 'var(--typography-regular-label)',
                  color: 'var(--typography-color-secondary)',
                }}
              >
                est. {cad(cost)}
                {usage && ` · ${usage.prompt_tokens} tokens in / ${usage.completion_tokens} out`} · estimated from
                list rates, not billed amounts
              </div>
            )}
          </section>

          {citations.length > 0 && (
            <section className="panel panel--scroll">
              <h2 className="panel__title">Sources</h2>
              <table style={{ minWidth: '40rem' }}>
                <thead>
                  <tr>
                    <th style={{ width: '4rem' }} />
                    <th>Document</th>
                    <th>Project</th>
                    <th style={{ width: '6rem' }}>Passage</th>
                    <th style={{ width: '7rem', textAlign: 'right' }} />
                  </tr>
                </thead>
                <tbody>
                  {citations.map((c) => (
                    <tr key={c.chunkId}>
                      <td>
                        <span className="pill pill--neutral">[{c.n}]</span>
                      </td>
                      <td className="cell__title">{c.documentName}</td>
                      <td className="cell--muted">{c.projectName}</td>
                      <td className="cell--muted cell--nowrap">{c.pageNumber}</td>
                      <td className="cell--right cell--nowrap">
                        {/* documentId and projectId are both resolved behind the caller's ACL,
                            so the row fetches its own link without a second search. */}
                        <button
                          type="button"
                          onClick={() => void download.start(c.documentId, c.projectId, c.chunkId)}
                          disabled={download.busyId === c.chunkId}
                          style={downloadButton}
                        >
                          {download.busyId === c.chunkId ? 'Preparing…' : 'Download'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {download.error && <p className="footnote">{download.error}</p>}
            </section>
          )}
        </>
      ) : loading ? (
        <section className="panel panel--padded" aria-busy="true">
          <p className="visually-hidden">Retrieving passages and summarising…</p>
          <div aria-hidden="true">
            <h2
              className="panel__title panel__title--inline"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--layout-margin-small)',
                flexWrap: 'wrap',
              }}
            >
              Answer
              <span className="pill" style={{ padding: 0 }}>
                <span className="skeleton skeleton--text" style={{ width: '12rem' }} />
              </span>
            </h2>
            <p style={{ font: 'var(--typography-regular-body)', margin: 0 }}>
              <span className="skeleton skeleton--text" style={{ width: '100%' }} />
              <span className="skeleton skeleton--text" style={{ width: '98%' }} />
              <span className="skeleton skeleton--text" style={{ width: '70%' }} />
            </p>
            <div style={{ display: 'flex', gap: 'var(--layout-margin-small)', marginTop: 'var(--layout-margin-medium)' }}>
              {SKELETON_PILLS.map((i) => (
                <span key={i} className="pill" style={{ padding: 0 }}>
                  <span className="skeleton skeleton--text" style={{ width: '2.5rem' }} />
                </span>
              ))}
            </div>
          </div>
        </section>
      ) : (
        reason && (
          // A null summary WITH a reason is an answer, not a failure. Say which.
          <section className="panel panel--padded">
            <div className="callout">
              <p style={{ margin: 0 }}>{reasonText(reason)}</p>
            </div>
          </section>
        )
      )}

      <p className="footnote">
        A long natural-language question narrows retrieval to nothing and the model is never called, so the tool
        says so rather than answering from outside the corpus.
      </p>
    </>
  );
}
