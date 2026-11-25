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

const KEY: readonly [glyph: string, label: string][] = [
  ['g dflag', 'Decision'],
  ['g dia', 'Milestone'],
  ['g cp', 'Comment period'],
  ['g ring', 'Other event'],
];

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
        <Glyph g={it.g} />
        <span className="wp-rec-ed">
          <span>{it.date}</span>
          {it.dateEnd && (
            <>
              <span>{it.dateEnd}</span>
              <span className="wp-rec-el">{it.len}</span>
            </>
          )}
        </span>
        <span className="wp-rec-en">
          {it.name}
          {it.countText && <span className="wp-rec-ecount">{it.countText}</span>}
        </span>
        <span className="wp-rec-egap">
          <span>{it.gap}</span>
          <span className="wp-rec-gbar" style={it.gapStyle} />
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

const colourStyle = (colour: string): MarkStyle => ({ '--pc': colour });

function Group({ g, hl, onMore }: { g: EventGroup; hl: RecordHighlight; onMore: () => void }) {
  return (
    <div className="wp-rec-egrp" style={g.colour ? colourStyle(g.colour) : undefined}>
      <h3 className="wp-rec-sthead" id={g.id}>
        <RowSwatch sw={g.sw} cls={g.swCls} />
        {g.name}
      </h3>
      {g.more && (
        <button type="button" className="wp-btn wp-btn--secondary wp-rec-emore" aria-expanded={g.more.expanded} aria-controls={g.listId} onClick={onMore}>
          {g.more.text}
        </button>
      )}
      {g.hiddenText && <p className="wp-rec-ehid">{g.hiddenText}</p>}
      {g.items.length > 0 && (
        <ol className="wp-rec-elist" id={g.listId} aria-labelledby={g.id}>
          {g.items.map((it) => (
            <Entry key={it.id} it={it} hl={hl} />
          ))}
        </ol>
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

/** "Events": filter buttons, a symbol key, and the entries grouped by step; each entry lights its mark on the chart. */
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
          <span className="wp-rec-emeta">{view.countText}</span>
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
          <ul className="wp-rec-evkey" aria-label="Symbols in this list">
            {KEY.map(([g, label]) => (
              <li key={label}>
                <Glyph g={g} />
                {label}
              </li>
            ))}
            {view.hasXpt && (
              <li>
                <Glyph g="g xpt" />
                Time limit extension
              </li>
            )}
            <li>
              <span className="wp-rec-gbar wp-rec-gbar--key" aria-hidden="true" />
              Grey bar: time since the entry before
            </li>
          </ul>
        </div>
      </header>
      <div className="wp-rec-egrid">
        {view.groups.map((g) => (
          <Group
            key={g.key}
            g={g}
            hl={hl}
            onMore={() => {
              toggleAll();
              hl.reset();
            }}
          />
        ))}
      </div>
      {view.hasMore && (
        <button type="button" className="wp-btn wp-btn--secondary wp-rec-emore" onClick={() => setCats([...EVENT_CATS])}>
          {view.moreText}
        </button>
      )}
    </section>
  );
}
