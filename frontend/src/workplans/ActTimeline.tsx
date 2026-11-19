import { useMemo, useState } from 'react';
import { plural } from './format';
import { Segmented } from './Segmented';
import { GROUP_BYS, groupKeyOf, groupsOf, holdsOpenWork, spanOf, yearsOf, type Group, type GroupBy, type SortBy } from './timeline-rows';
import { ZOOMS, type Zoom } from './timeline-scale';
import { TimelineGroup, type GroupProps } from './TimelineGroup';

/** Above this many groups a panel starts them folded, so a big Act mounts only group heads. */
const FOLD_OVER = 12;

export interface ActProps extends Pick<GroupProps, 'today' | 'opened' | 'onDetails' | 'unfollow' | 'onJump' | 'pairs'> {
  /** The Act's shown rows, split by `groupsOf(rows, 'act')`; may be empty. */
  act: Group;
  id: string;
  open: boolean;
  onToggle: (key: string, open: boolean) => void;
  groupBy: Exclude<GroupBy, 'act'>;
  onGroupBy: (key: string, by: Exclude<GroupBy, 'act'>) => void;
  zoom: Zoom;
  onZoom: (key: string, zoom: Zoom) => void;
  sort: SortBy;
  /** A reader's fold or unfold of a group, by group key; wins over the default. */
  folds: ReadonlyMap<string, boolean>;
  onFold: (key: string, open: boolean) => void;
  /** Works in this Act before the filters, when the screen counts them. */
  total?: number;
  onShowAllStates?: () => void;
}

function EmptyNote({ hidden, onShowAllStates }: { hidden: number; onShowAllStates?: () => void }) {
  return (
    <div className="timeline__act-empty">
      <p>
        {hidden > 0
          ? `${plural(hidden, 'work')} in this Act ${hidden === 1 ? 'is' : 'are'} hidden by the filters.`
          : 'No works match these filters.'}
      </p>
      {hidden > 0 && onShowAllStates && (
        <button type="button" className="wp-chip wp-chip--accent" onClick={onShowAllStates}>
          Show every work state
        </button>
      )}
    </div>
  );
}

/** One Act as a folding panel: its own Group by and Zoom, and each group of it on its own axis. */
export function ActTimeline(props: ActProps) {
  const { act, id, open, onToggle, groupBy, onGroupBy, zoom, onZoom, sort, folds, onFold, total, onShowAllStates, ...rowProps } = props;
  const [toToday, setToToday] = useState(0);
  const groups = useMemo(
    () => groupsOf(act.rows, groupBy, rowProps.today, sort).map((group) => ({ ...group, key: groupKeyOf(act.key, group.key) })),
    [act, groupBy, rowProps.today, sort],
  );
  const span = useMemo(() => spanOf(act.rows, rowProps.today), [act.rows, rowProps.today]);
  const folded = groups.length > FOLD_OVER;
  const goToToday = () => (zoom === 'fit' ? onZoom(act.key, 'quarter') : setToToday((n) => n + 1));
  const empty = act.rows.length === 0;

  return (
    <details
      className="timeline__act"
      id={id}
      open={open}
      onToggle={(event) => event.currentTarget.open !== open && onToggle(act.key, event.currentTarget.open)}
    >
      <summary className="timeline__act-head">
        <span className="timeline__act-name">{act.label}</span>
        <span className="timeline__act-meta">{span ? yearsOf(span) : 'No works match'}</span>
        <span className="timeline__act-meta">{plural(act.rows.length, 'work')}</span>
        {act.overdue > 0 && <span className="timeline__pill">{act.overdue} overdue</span>}
      </summary>
      {open && (
        <div className="timeline__act-body" role="region" aria-label={`${act.label} timeline`}>
          {empty ? (
            <EmptyNote hidden={total ?? 0} onShowAllStates={onShowAllStates} />
          ) : (
            <>
              <div className="timeline__act-tools">
                <Segmented label="Group by" options={GROUP_BYS} value={groupBy} onChange={(by) => onGroupBy(act.key, by)} />
                <Segmented label="Zoom" labelHidden options={ZOOMS} value={zoom} onChange={(next) => onZoom(act.key, next)} />
                {holdsOpenWork(act.rows) && (
                  <button type="button" className="wp-chip wp-chip--accent" onClick={goToToday}>
                    Today
                  </button>
                )}
              </div>
              {groups.map((group) => (
                <TimelineGroup
                  key={group.key}
                  {...rowProps}
                  group={group}
                  open={folds.get(group.key) ?? !folded}
                  onToggle={onFold}
                  zoom={zoom}
                  toToday={toToday}
                />
              ))}
            </>
          )}
        </div>
      )}
    </details>
  );
}
