import { kindClassOf } from './timeline-rows';
import { ticksFor, type Scale, type SpanKind } from './timeline-scale';

const ALWAYS: [SpanKind, string][] = [
  ['past', 'Completed'],
  ['current', 'Current phase'],
  ['upcoming', 'Upcoming'],
  ['overrun', 'Overdue'],
];
/** Kinds the design has no key for, shown only while some row draws them. */
const WHEN_DRAWN: [SpanKind, string][] = [
  ['incomplete', 'Not completed'],
  ['suspended', 'Suspended'],
  ['extension', 'Extension'],
  ['interregnum', 'Interregnum'],
  ['comment-period', 'Comment period'],
  ['decision', 'Decision'],
  ['section-13', 'Section 13 order'],
  ['transition-in', 'From earlier Act'],
  ['transition-out', 'To next Act'],
];

/** `approx`: some bar has a bound that is not a real date. */
export function Legend({ drawn, approx = false }: { drawn: ReadonlySet<SpanKind>; approx?: boolean }) {
  const items = [...ALWAYS, ...WHEN_DRAWN.filter(([kind]) => drawn.has(kind))];
  return (
    <ul className="timeline__legend" aria-label="Legend">
      {items.map(([kind, label]) => (
        <li key={kind}>
          {/* Swatches reuse the bar and mark classes, so the legend can never drift from the rows. */}
          <span
            className={`timeline__swatch ${kindClassOf(kind)}${kind === 'current' ? ' timeline__bar--review' : ''}`}
            aria-hidden="true"
          />
          {label}
        </li>
      ))}
      {approx && (
        <li>
          <span className="timeline__swatch timeline__bar--past timeline__bar--approx-start" aria-hidden="true" />
          Approximate dates
        </li>
      )}
    </ul>
  );
}

export function Axis({ scale }: { scale: Scale }) {
  const { top, bottom } = ticksFor(scale);
  return (
    <div className="timeline__axis">
      {[top, bottom].map((ticks, tier) => (
        <div key={tier} className={`timeline__tier timeline__tier--${tier ? 'bottom' : 'top'}`}>
          {ticks.map((tick) => (
            <span key={tick.x} className="timeline__tick" style={{ left: tick.x, width: tick.width }}>
              {tick.label}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
