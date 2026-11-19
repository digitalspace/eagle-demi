import { memo, useId, useRef } from 'react';
import { Link } from 'react-router';
import { dayMonthYear } from '../dates';
import { WorkPill } from '../screens/SheetWorksPanel';
import { rowKey, toneOf, type WorkRow } from './derive';
import { plural } from './format';
import { markerSummaryOf } from './timeline-markers';
import { daysOf, kindClassOf, MARK_KINDS, railOf, summaryOf, undatedTextOf } from './timeline-rows';
import { dayNumber, spansOf, tagDayOf, xOf, type Scale, type Span } from './timeline-scale';
import { useFollowDetails } from './use-follow-details';
import { hasDetails, projectDetailsPath } from './work-notes';
import { workTypeOf } from './work-types';
import { DetailsToggle, WorkDetails } from './WorkDetails';

/** The sticky columns: work title with its Details toggle, work type, days in phase. */
function RowLeft({ row, details }: { row: WorkRow; details?: { id: string; open: boolean; toggle: () => void } }) {
  const type = workTypeOf(row);
  const title = row.work.title || 'Untitled work';
  const days = daysOf(row);
  return (
    <div className="timeline__left">
      <span className="timeline__work">
        <Link className="timeline__name" to={projectDetailsPath(row.work.projectId)} title={title}>
          {title}
        </Link>
        {/* WorkPill takes no title; its own text is the tooltip once CSS cuts it short. */}
        <span
          className="timeline__flag"
          ref={(el) => {
            if (el) el.title = el.textContent ?? '';
          }}
        >
          <WorkPill work={row.work} />
        </span>
        {details && (
          <DetailsToggle
            className="timeline__toggle"
            title={title}
            controls={details.id}
            open={details.open}
            onToggle={details.toggle}
          />
        )}
      </span>
      <abbr className="timeline__type" title={type.name}>
        {type.code}
      </abbr>
      <span className={`timeline__days${row.overdue ? ' timeline__days--over' : ''}`} title={days} aria-hidden="true">
        {days}
      </span>
    </div>
  );
}

/** A bar's hover text: phase and dates, or how far the overrun runs past the planned end. */
function titleOf(span: Span, row: WorkRow): string {
  if (span.kind === 'overrun') return `${plural(row.daysOver, 'day')} overdue`;
  if (span.layer === 'marker') return `${span.name}, ${dayMonthYear(span.start)}`;
  const name =
    span.kind === 'suspended' ? `Suspended${span.name ? ` under ${span.name}` : ''}` : span.name || 'Unnamed phase';
  const about = (approx: boolean) => (approx ? 'about ' : '');
  return `${name}, ${about(span.approx.start)}${dayMonthYear(span.start)} to ${about(span.approx.end)}${dayMonthYear(span.end)}`;
}

/** Bars for phases, overruns and suspensions; marks for every other kind, shaped by its modifier. */
function classOf(span: Span, tone: string): string {
  if (MARK_KINDS.has(span.kind)) return `timeline__mark ${kindClassOf(span.kind)}`;
  const names = ['timeline__bar', kindClassOf(span.kind)];
  if (span.kind === 'current') names.push(`timeline__bar--${tone}`);
  if (span.approx.start) names.push('timeline__bar--approx-start');
  if (span.approx.end) names.push('timeline__bar--approx-end');
  return names.join(' ');
}

const LAYER_ORDER = { overlay: 0, phase: 1, marker: 2 } as const;

/** Places a tag `left` px into the lane, slid back left by however much it would run past the lane end. */
const tagStyle = (left: number, scale: Scale) => ({ left, translate: `min(0px, calc(${scale.width - left}px - 100%))` });

/** Scrolls an open panel into view, never so far that its row goes above the top of the Act list. */
function reveal(panel: HTMLElement) {
  const box = panel.closest<HTMLElement>('.timeline__acts');
  const row = panel.closest('li')?.previousElementSibling;
  if (!box || !row) return;
  const top = box.getBoundingClientRect().top + box.clientTop;
  const below = panel.getBoundingClientRect().bottom - (top + box.clientHeight);
  const room = row.getBoundingClientRect().top - top;
  if (below > 0 && room > 0) box.scrollTop += Math.min(below, room);
}

/** Rows with their details open; `follow` is the one last opened, scrolled along until its details load. */
export interface Opened {
  open: ReadonlySet<string>;
  follow: string | null;
}

export interface RowProps {
  row: WorkRow;
  scale: Scale;
  today: string;
  open: boolean;
  follow: boolean;
  toggle: (key: string) => void;
  unfollow: () => void;
  /** `rowKey` of the other part of a work that switched Act, when that part is shown. */
  partner?: string;
  /** Opens the panel and group of the row with this key, and moves focus to it. */
  onJump: (key: string) => void;
}

/** "To 2002 Act, 30 Apr 2003" and "From 1996 Act" tags; a button to the other part when it is shown. */
function SwitchTags({ spans, scale, partner, onJump }: { spans: Span[]; scale: Scale; partner?: string; onJump: (key: string) => void }) {
  return spans
    .filter((span) => span.kind === 'transition-out' || span.kind === 'transition-in')
    .map((span) => {
      const label = span.kind === 'transition-out' ? `${span.name}, ${dayMonthYear(span.start)}` : (span.name ?? '');
      const style = tagStyle(xOf(scale, dayNumber(span.start)) + 6, scale);
      return partner ? (
        <button key={span.kind} type="button" className="timeline__tag" style={style} onClick={() => onJump(partner)}>
          {label}
        </button>
      ) : (
        <span key={span.kind} className="timeline__tag timeline__tag--plain" style={style}>
          {label}
        </span>
      );
    });
}

export const TimelineRow = memo(function TimelineRow({ row, scale, today, open, follow, toggle, unfollow, partner, onJump }: RowProps) {
  const detailsId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  useFollowDetails(panelRef, open && follow, reveal, unfollow);
  const spans = spansOf(row, today, { layers: 'all' }).sort((a, b) => LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer]);
  const rail = railOf(row, today);
  const tone = toneOf(row);
  const tagX = xOf(scale, tagDayOf(spans, today)) + 4;
  const details = hasDetails(row) ? { id: detailsId, open, toggle: () => toggle(rowKey(row)) } : undefined;
  const summary = [summaryOf(row, today), markerSummaryOf(row, today)].filter(Boolean).join(' ');
  return (
    <>
      <li className={`timeline__row${row.work.shownAfterFlip === false ? ' timeline__row--hidden' : ''}`} data-row={rowKey(row)}>
        <RowLeft row={row} details={details} />
        <div className="timeline__lane">
          <span className="timeline__draw" aria-hidden="true">
            {rail && rail.end > rail.start && (
              <span
                className="timeline__rail"
                style={{ left: xOf(scale, rail.start), width: (rail.end - rail.start) * scale.pxPerDay }}
              />
            )}
            {spans.map((span, i) => {
              const left = xOf(scale, dayNumber(span.start));
              const width = span.layer === 'marker' ? undefined : Math.max(2, xOf(scale, dayNumber(span.end)) - left);
              const current = span.kind === 'current';
              return (
                <span key={i} className={classOf(span, tone)} style={{ left, width }} title={titleOf(span, row)}>
                  {current && span.name && <span className="timeline__label">{span.name}</span>}
                </span>
              );
            })}
            {!spans.some((span) => span.layer === 'phase') && <span className="timeline__undated">{undatedTextOf(row)}</span>}
            {row.suspended && (
              <span className="timeline__note" style={tagStyle(tagX, scale)}>
                Suspended{row.suspendedUnder ? ` ${row.suspendedUnder}` : ''}
              </span>
            )}
          </span>
          <SwitchTags spans={spans} scale={scale} partner={partner} onJump={onJump} />
        </div>
        <span className="visually-hidden">{summary}</span>
      </li>
      {open && (
        <li className="timeline__detail">
          <div className="timeline__detail-body" ref={panelRef}>
            <WorkDetails row={row} id={detailsId} />
          </div>
        </li>
      )}
    </>
  );
});
