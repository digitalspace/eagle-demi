import { Fragment, useCallback, useMemo, useState } from 'react';
import { byAttention, type WorkRow } from './derive';
import type { ViewProps } from './Filters';
import { plural } from './format';
import {
  COLUMNS,
  DaysCell,
  DecisionCell,
  DetailRow,
  LifecycleCell,
  NextCell,
  PhaseCell,
  WorkCell,
} from './status-list-cells';
import { StatusTiles, type TileStatus } from './StatusTiles';
import { hasDetails } from './work-notes';
import './workplans.css';
import './status-list.css';

const PAGE = 200;
const count = (n: number) => n.toLocaleString('en-CA');
const rowKey = (row: WorkRow) => `${row.work.source}:${row.work.workId}`;

/** Works sorted by attention; each status tile narrows the table to its status. */
export function StatusListView({ rows, today, bar }: ViewProps) {
  const [pressed, setPressed] = useState<TileStatus | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // The row last opened by its toggle; only its panel scrolls into view, and only until its details load.
  const [follow, setFollow] = useState<string | null>(null);
  const unfollow = useCallback(() => setFollow(null), []);
  const shown = useMemo(
    () => (pressed ? rows.filter((row) => row.status === pressed) : [...rows]).sort(byAttention),
    [rows, pressed],
  );
  const visible = shown.slice(0, limit);
  const more = Math.min(PAGE, shown.length - visible.length);
  // A followed row hidden before its details load would jump the page when shown again.
  if (follow && !visible.some((row) => rowKey(row) === follow)) setFollow(null);

  const toggle = (key: string) => {
    const next = new Set(open);
    if (!next.delete(key)) next.add(key);
    setOpen(next);
    setFollow(next.has(key) ? key : follow === key ? null : follow);
  };

  const press = (status: TileStatus) => {
    setPressed((current) => (current === status ? null : status));
    setLimit(PAGE);
  };

  return (
    <div className="sl">
      <StatusTiles rows={rows} pressed={pressed} onPress={press} />
      {bar?.({ summary: `Sorted by attention · ${plural(shown.length, 'work')}` })}
      <div className="panel panel--scroll sl-region">
        <table className="sl-table">
          <caption className="visually-hidden">Works, sorted by attention</caption>
          <thead>
            <tr>
              <th scope="col" className="sl-col--work">Work</th>
              <th scope="col" className="sl-col--phase">Current phase</th>
              <th scope="col" className="sl-col--days">Days in phase</th>
              <th scope="col" className="sl-col--next">Next milestone</th>
              <th scope="col" className="sl-col--life">
                Lifecycle <span className="sl-th-note">(start → decision)</span>
              </th>
              <th scope="col" className="sl-col--decision">Est. decision</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const key = rowKey(row);
              const isOpen = open.has(key);
              return (
                <Fragment key={key}>
                  <tr>
                    <WorkCell row={row} details={hasDetails(row) ? { open: isOpen, onToggle: () => toggle(key) } : null} />
                    <PhaseCell row={row} today={today} />
                    <DaysCell row={row} />
                    <NextCell row={row} today={today} />
                    <LifecycleCell row={row} />
                    <DecisionCell row={row} />
                  </tr>
                  {isOpen && <DetailRow row={row} follow={follow === key} onFollowed={unfollow} />}
                </Fragment>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={COLUMNS} className="sl-empty">
                  No works match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="sl-footer">
        <span role="status">
          Showing {visible.length > 0 ? `1–${count(visible.length)}` : '0'} of {count(shown.length)}
        </span>
        {more > 0 && (
          <button type="button" className="sl-more" onClick={() => setLimit((n) => n + PAGE)}>
            Show {more} more
          </button>
        )}
        <span className="sl-footer__actions">
          <button type="button" className="wp-chip wp-chip--placeholder" disabled title="Not available yet">
            Columns
          </button>
          <button type="button" className="wp-chip wp-chip--placeholder" disabled title="Not available yet">
            Export
          </button>
        </span>
      </div>
    </div>
  );
}
