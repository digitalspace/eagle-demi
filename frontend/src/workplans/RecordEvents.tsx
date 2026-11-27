import { useMemo, useState } from 'react';
import type { MarkStyle } from './chart-types';
import { count } from './format';
import { RowSwatch } from './RecordChart';
import { EVENT_CATS, defaultEventSel, eventList, type EventEntry, type EventGroup, type RecordEvents as RecordEventData } from './record-event-list';
import type { EventCat } from './record-types';
import type { RecordHighlight } from './use-record-model';

export interface RecordEventsProps {
  events: RecordEventData;
  /** Project and Act: the filter and "Show all" reset on another record. */
  recordKey: string;
  hl: RecordHighlight;
}

const Glyph = ({ g }: { g: string }) => (
  <span className="wp-rec-gbox" aria-hidden="true">
    <span className={g} />
  </span>
);

function Entry({ it, hl }: { it: EventEntry; hl: RecordHighlight }) {
  const picked = hl.pickId === it.id;
  const cls = ['wp-rec-erow', it.cls, hl.hlId === it.id ? 'hl' : '', picked ? 'sel' : ''].filter(Boolean).join(' ');
  return (
    <li className={cls}>
      <button
        type="button"
        className="wp-rec-esel"
        data-ev={it.id}
        aria-pressed={picked}
        aria-label={it.label}
        onMouseEnter={() => hl.onHover(it.id, true)}
        onMouseLeave={() => hl.onHover(it.id, false)}
        onFocus={() => hl.onHover(it.id, true)}
        onBlur={() => hl.onHover(it.id, false)}
        onClick={() => hl.onPick(it.id)}
      >
        <span className="wp-rec-ed">
          {it.date}
          {it.dateEnd && ` ${it.dateEnd}`}
        </span>
        <Glyph g={it.g} />
        <span className="wp-rec-en">
          {it.name}
          {it.tag && <span className="wp-rec-etag">{it.tag}</span>}
          {(it.countText || it.len) && <span className="wp-rec-ecount">{[it.countText, it.len].filter(Boolean).join(', ')}</span>}
        </span>
        <span className="wp-rec-eph" title={it.phase?.name}>
          {it.phase && (
            <>
              <RowSwatch sw={it.phase.sw} cls={it.phase.swCls} />
              <span>{it.phase.name}</span>
            </>
          )}
        </span>
      </button>
      {picked && it.hasMark && (
        <div className="wp-rec-eact">
          <button type="button" className="wp-btn wp-btn--secondary" onClick={(event) => hl.showMark(event.currentTarget, it.id)}>
            Show on chart
          </button>
        </div>
      )}
    </li>
  );
}

/** Column names over a list; the entries' own accessible names say the same, so screen readers skip it. */
const Cols = ({ phase }: { phase: boolean }) => (
  <div className="wp-rec-ecols" aria-hidden="true">
    <span>Date</span>
    <span />
    <span>Event</span>
    <span>{phase ? 'Phase' : ''}</span>
  </div>
);

const colourStyle = (colour: string): MarkStyle => ({ '--pc': colour });

/** The later works: their own short list beside the assessment's events, since they are works and not its events. */
function After({ g, hl, onMore }: { g: EventGroup; hl: RecordHighlight; onMore: () => void }) {
  return (
    <div className="wp-rec-eafter" style={g.colour ? colourStyle(g.colour) : undefined}>
      <h3 className="wp-rec-sthead" id={g.id}>
        <RowSwatch sw={g.sw} cls={g.swCls} />
        {g.name}
      </h3>
      <Cols phase={false} />
      <ol className="wp-rec-elist" id={g.listId} aria-labelledby={g.id}>
        {g.items.map((it) => (
          <Entry key={it.id} it={it} hl={hl} />
        ))}
      </ol>
      {g.more && (
        <button type="button" className="wp-btn wp-btn--secondary wp-rec-emore" aria-expanded={g.more.expanded} aria-controls={g.listId} onClick={onMore}>
          {g.more.text}
        </button>
      )}
    </div>
  );
}

/** The filter and the later works' "Show all" of one record; both start over on another record. */
function useEventView(events: RecordEventData, recordKey: string) {
  const [sel, setSel] = useState<{ key: string; cats: EventCat[] } | null>(null);
  const [all, setAll] = useState<{ key: string; on: boolean } | null>(null);
  const start = useMemo(() => defaultEventSel(events), [events]);
  const cats = sel?.key === recordKey ? sel.cats : start;
  const awAll = all?.key === recordKey && all.on;
  const view = useMemo(() => eventList(events, cats, awAll), [events, cats, awAll]);
  return {
    view,
    pick: (next: EventCat[]) => setSel({ key: recordKey, cats: next }),
    toggleAll: () => setAll({ key: recordKey, on: !awAll }),
  };
}

/** "Events": filter buttons, the entries by date, then the later works; each entry lights its mark on the chart. */
export function RecordEvents({ events, recordKey, hl }: RecordEventsProps) {
  const { view, pick, toggleAll } = useEventView(events, recordKey);
  if (!view.has) return null;
  const setCats = (next: EventCat[]) => {
    pick(next);
    hl.reset();
  };
  return (
    <section className="wp-rec-blk" aria-labelledby="ev-title">
      <header className="wp-rec-evhead">
        <div className="wp-rec-bhead">
          <h2 id="ev-title">Events</h2>
          <span className="wp-rec-emeta" aria-live="polite">
            {view.countText}
          </span>
        </div>
        <div className="wp-rec-evtools">
          {view.hasChips && (
            <div className="wp-rec-chips" role="group" aria-label="Show events">
              {view.chips.map((c) => (
                <button key={c.label} type="button" className="wp-tbtn" aria-pressed={c.pressed} onClick={() => setCats(c.cats)}>
                  {c.label}
                  <span className="wp-rec-cnt">{count(c.count)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </header>
      <div className={view.after && view.hasChips ? 'wp-rec-ecolumns wp-rec-ecolumns--two' : 'wp-rec-ecolumns'}>
        {view.hasChips && (
          <div className="wp-rec-emain">
            <Cols phase />
            {view.rows.length > 0 ? (
              <ol className="wp-rec-elist" aria-labelledby="ev-title">
                {view.rows.map((it) => (
                  <Entry key={it.id} it={it} hl={hl} />
                ))}
              </ol>
            ) : (
              <p className="wp-rec-enone">No events of this kind.</p>
            )}
          </div>
        )}
        {view.after && (
          <After
            g={view.after}
            hl={hl}
            onMore={() => {
              toggleAll();
              hl.reset();
            }}
          />
        )}
      </div>
      {view.hasMore && (
        <button type="button" className="wp-btn wp-btn--secondary wp-rec-emore" onClick={() => setCats([...EVENT_CATS])}>
          {view.moreText}
        </button>
      )}
    </section>
  );
}
