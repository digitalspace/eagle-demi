import { memo, useId, useMemo, useRef, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { dayMonthYear } from '../dates';
import { WorkPill } from '../screens/SheetWorksPanel';
import { rowKey, toneOf, type WorkRow } from './derive';
import { plural } from './format';
import { activeByQuarter } from './timeline-activity';
import { daysOf, summaryOf, type Group } from './timeline-rows';
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
  const name =
    span.kind === 'suspended' ? `Suspended${span.name ? ` under ${span.name}` : ''}` : span.name || 'Unnamed phase';
  return `${name}, ${dayMonthYear(span.start)} to ${dayMonthYear(span.end)}`;
}

/** Scrolls an open panel into view, never so far that its row goes under the head. */
function reveal(panel: HTMLElement) {
  const box = panel.closest<HTMLElement>('.timeline__scroll');
  const head = box?.querySelector<HTMLElement>('.timeline__head');
  const row = panel.closest('li')?.previousElementSibling;
  if (!box || !head || !row) return;
  const top = box.getBoundingClientRect().top + box.clientTop;
  const below = panel.getBoundingClientRect().bottom - (top + box.clientHeight);
  const room = row.getBoundingClientRect().top - top - head.offsetHeight;
  if (below > 0 && room > 0) box.scrollTop += Math.min(below, room);
}

/** Rows with their details open; `follow` is the one last opened, scrolled along until its details load. */
export interface Opened {
  open: ReadonlySet<string>;
  follow: string | null;
}

interface RowProps {
  row: WorkRow;
  scale: Scale;
  today: string;
  open: boolean;
  follow: boolean;
  toggle: (key: string) => void;
  unfollow: () => void;
}

const TimelineRow = memo(function TimelineRow({ row, scale, today, open, follow, toggle, unfollow }: RowProps) {
  const detailsId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  useFollowDetails(panelRef, open && follow, reveal, unfollow);
  const spans = spansOf(row, today);
  const tone = toneOf(row);
  const tagX = xOf(scale, tagDayOf(spans, today)) + 4;
  const details = hasDetails(row) ? { id: detailsId, open, toggle: () => toggle(rowKey(row)) } : undefined;
  return (
    <>
      <li className="timeline__row">
        <RowLeft row={row} details={details} />
        <div className="timeline__lane" aria-hidden="true">
          {spans.map((span, i) => {
            const left = xOf(scale, dayNumber(span.start));
            const width = Math.max(2, xOf(scale, dayNumber(span.end)) - left);
            const current = span.kind === 'current';
            return (
              <span
                key={i}
                className={`timeline__bar timeline__bar--${span.kind}${current ? ` timeline__bar--${tone}` : ''}`}
                style={{ left, width }}
                title={titleOf(span, row)}
              >
                {current && span.name && <span className="timeline__label">{span.name}</span>}
              </span>
            );
          })}
          {!spans.length && <span className="timeline__undated">No dated phases</span>}
          {row.suspended && (
            <span
              className="timeline__note"
              // Slides back left by however much it would run past the lane end.
              style={{
                left: tagX,
                translate: `min(0px, calc(${scale.width - tagX}px - 100%))`,
              }}
            >
              Suspended{row.suspendedUnder ? ` ${row.suspendedUnder}` : ''}
            </span>
          )}
        </div>
        <span className="visually-hidden">{summaryOf(row)}</span>
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

/** Quarter cells across the group head's lane, shaded by how many of the group's works are active. */
function Activity({ rows, scale }: { rows: WorkRow[]; scale: Scale }) {
  const cells = useMemo(() => activeByQuarter(rows, scale), [rows, scale]);
  return (
    <span className="timeline__activity" aria-hidden="true">
      {cells.map((cell) => (
        <span
          key={cell.start}
          className="timeline__heat"
          title={`${cell.label}: ${plural(cell.count, 'active work')}`}
          style={{
            left: xOf(scale, cell.start),
            width: (cell.end - cell.start) * scale.pxPerDay,
            '--heat': `${Math.round(8 + (80 * cell.count) / rows.length)}%`,
          } as CSSProperties}
        />
      ))}
    </span>
  );
}

export function TimelineGroup({
  group,
  open,
  onToggle,
  scale,
  today,
  opened,
  onDetails,
  unfollow,
}: {
  group: Group;
  open: boolean;
  onToggle: (key: string, open: boolean) => void;
  scale: Scale;
  today: string;
  opened: Opened;
  onDetails: (key: string) => void;
  unfollow: () => void;
}) {
  return (
    <details className="timeline__group" open={open} onToggle={(event) => onToggle(group.key, event.currentTarget.open)}>
      <summary className="timeline__group-head">
        <span className="timeline__group-label">
          <span className="timeline__group-name">{group.label}</span>
          <span className="timeline__group-meta">
            <span className="timeline__group-count">{plural(group.rows.length, 'work')}</span>
            {group.overdue > 0 && <span className="timeline__pill">{group.overdue} overdue</span>}
          </span>
        </span>
        <Activity rows={group.rows} scale={scale} />
      </summary>
      {open && (
        <ul className="timeline__rows">
          {group.rows.map((row) => (
            <TimelineRow
              key={rowKey(row)}
              row={row}
              scale={scale}
              today={today}
              open={opened.open.has(rowKey(row))}
              follow={opened.follow === rowKey(row)}
              toggle={onDetails}
              unfollow={unfollow}
            />
          ))}
        </ul>
      )}
    </details>
  );
}
