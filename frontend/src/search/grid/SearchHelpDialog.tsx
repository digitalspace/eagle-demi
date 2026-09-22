import { useEffect, useRef } from 'react';
import { ScrollLock } from './scroll-lock';
import './search-help-dialog.css';

/**
 * The search-syntax help, as a native modal. Mounted per opening; `onClose` fires for the X,
 * Escape, a backdrop press and Take the tour alike, and says which, because the tour takes over
 * focus from there rather than handing it back to the opener.
 */
export function SearchHelpDialog({ onClose }: { onClose: (startTour: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const tourNext = useRef(false);
  const closing = useRef(onClose);
  useEffect(() => {
    closing.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const lock = new ScrollLock();
    if (!element.open) element.showModal();
    // Focus lands on the dialog rather than its first control, so the title is heard first.
    element.focus();
    lock.lock(element);
    const onClosed = () => {
      lock.release();
      closing.current(tourNext.current);
    };
    // A press on the dialog element itself is a press on the backdrop it paints. Bound here, not
    // through JSX, since a click handler on a <dialog> reads to the linter as a non-interactive one.
    const onPress = (event: Event) => {
      if (event.target === element) element.close();
    };
    element.addEventListener('close', onClosed);
    element.addEventListener('click', onPress);
    return () => {
      element.removeEventListener('close', onClosed);
      element.removeEventListener('click', onPress);
      lock.release();
    };
  }, []);

  const close = () => dialog.current?.close();

  return (
    <div className="display-grid__overlay">
      <dialog
        ref={dialog}
        aria-modal="true"
        aria-labelledby="search-help-title"
        tabIndex={-1}
        className="display-grid__help"
      >
        <div className="display-grid__help-head">
          <h2 id="search-help-title" className="display-grid__help-title">
            Search help
          </h2>
          <button type="button" className="display-grid__help-close" aria-label="Close search help" onClick={close}>
            <svg
              className="display-grid__help-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>

        <div className="display-grid__help-body">
          <h3 className="display-grid__help-heading">Every word counts</h3>
          <p className="display-grid__help-text">
            A record has to hold every word you type, so each word you add narrows the results rather than widening
            them. Searching Certificate Extension returns only the records holding both words.
          </p>

          <h3 className="display-grid__help-heading">Punctuation</h3>
          <p className="display-grid__help-text">
            Punctuation is read as a space. Quotation marks do not hold words together as a phrase, and a hyphen does
            not remove what follows it — both are dropped, and the words around them are searched on their own.
          </p>

          <p className="display-grid__help-start">
            <button
              type="button"
              className="display-grid__help-tour"
              onClick={() => {
                tourNext.current = true;
                close();
              }}
            >
              <svg
                className="display-grid__help-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M10 8.5l6 3.5-6 3.5z" />
              </svg>
              Take the tour
            </button>
          </p>
        </div>
      </dialog>
    </div>
  );
}
