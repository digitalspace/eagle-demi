import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ActTimeline } from './ActTimeline';
import { ChipSelect } from './ChipSelect';
import { rowKey, type WorkRow } from './derive';
import type { ViewProps } from './Filters';
import { plural } from './format';
import { transitionPairsOf } from './timeline-markers';
import { Legend } from './timeline-parts';
import { defaultZoomOf, groupKeyOf, groupsOf, SORTS, type Group, type GroupBy, type SortBy } from './timeline-rows';
import { drawnKinds, spansOf, type Zoom } from './timeline-scale';
import type { Opened } from './TimelineRow';
import './timeline.css';

const ACTS = [2018, 2002, 1996];

/**
 * Act panels, newest first. While the shown works span two or more Acts, an Act they miss still gets an empty
 * panel, so its note can say the filters hide it; a search or Act filter that hits one Act shows that panel alone.
 */
function panelsOf(rows: WorkRow[], today: string): Group[] {
  const acts = groupsOf(rows, 'act', today);
  if (acts.length < 2) return acts;
  const byKey = new Map(acts.map((act) => [act.key, act]));
  const known = ACTS.map((year) => byKey.get(`act-${year}`) ?? { key: `act-${year}`, label: `${year} Act`, rows: [], overdue: 0 });
  return [...known, ...acts.filter((act) => !known.includes(act))];
}

/** Values the reader set, by key; a key never set reads its default. */
function useOverrides<T>(): [ReadonlyMap<string, T>, (key: string, value: T) => void] {
  const [map, setMap] = useState<ReadonlyMap<string, T>>(new Map());
  const set = useCallback(
    (key: string, value: T) => setMap((prev) => (prev.get(key) === value ? prev : new Map(prev).set(key, value))),
    [],
  );
  return [map, set];
}

interface Target {
  kind: 'row' | 'panel';
  id: string;
  n: number;
}

/** Moves focus to the row or panel last jumped to, once its panel and group have opened. */
function useJump(container: RefObject<HTMLDivElement | null>) {
  const [target, setTarget] = useState<Target | null>(null);
  useLayoutEffect(() => {
    if (!target) return;
    const el =
      target.kind === 'panel'
        ? document.getElementById(target.id)
        : [...(container.current?.querySelectorAll<HTMLElement>('[data-row]') ?? [])].find((row) => row.dataset.row === target.id);
    const box = container.current;
    // Wide, only the Act list scrolls; scrolling the page too would leave a gap under the timeline.
    if (target.kind === 'panel' && el && box && box.scrollHeight > box.clientHeight) {
      box.scrollBy?.({ top: el.getBoundingClientRect().top - box.getBoundingClientRect().top });
    } else {
      el?.scrollIntoView?.({ block: 'nearest' });
    }
    el?.querySelector<HTMLElement>(target.kind === 'panel' ? 'summary' : '.timeline__name')?.focus({ preventScroll: true });
  }, [target, container]);
  return useCallback((kind: Target['kind'], id: string) => setTarget((prev) => ({ kind, id, n: (prev?.n ?? 0) + 1 })), []);
}

/** One timeline per Act, each group in it on its own axis; Sort and the legend apply to every panel. */
export function TimelineView({ rows, today, bar, actTotals, onShowAllStates }: ViewProps) {
  const baseId = useId();
  const [sort, setSort] = useState<SortBy>('start');
  const [panels, setPanel] = useOverrides<boolean>();
  const [groupBys, setGroupBy] = useOverrides<Exclude<GroupBy, 'act'>>();
  const [zooms, setZoom] = useOverrides<Zoom>();
  const [folds, setFold] = useOverrides<boolean>();
  // Held here, not per row, so open details survive a group folding or a Group by change.
  const [opened, setOpened] = useState<Opened>({ open: new Set(), follow: null });
  const toggleDetails = useCallback(
    (key: string) =>
      setOpened(({ open, follow }) => {
        const next = new Set(open);
        if (!next.delete(key)) next.add(key);
        return { open: next, follow: next.has(key) ? key : follow === key ? null : follow };
      }),
    [],
  );
  const unfollow = useCallback(() => setOpened((prev) => (prev.follow === null ? prev : { ...prev, follow: null })), []);
  const container = useRef<HTMLDivElement>(null);
  const jumpTo = useJump(container);

  const acts = useMemo(() => panelsOf(rows, today), [rows, today]);
  const pairs = useMemo(() => transitionPairsOf(rows), [rows]);
  const drawn = useMemo(() => drawnKinds(rows, today, { layers: 'all' }), [rows, today]);
  const approx = useMemo(
    () => rows.some((row) => spansOf(row, today).some((span) => span.approx.start || span.approx.end)),
    [rows, today],
  );
  // A followed row hidden before its details load would jump the page when shown again.
  if (opened.follow && !rows.some((row) => rowKey(row) === opened.follow)) unfollow();

  // A fold hides rows, so the followed one stops being followed.
  const fold = (key: string, open: boolean) => {
    setFold(key, open);
    unfollow();
  };
  const togglePanel = (key: string, open: boolean) => {
    setPanel(key, open);
    unfollow();
  };
  const onJump = useCallback(
    (key: string) => {
      const row = rows.find((candidate) => rowKey(candidate) === key);
      if (!row) return;
      const act = groupsOf([row], 'act', today)[0].key;
      setPanel(act, true);
      setFold(groupKeyOf(act, groupsOf([row], groupBys.get(act) ?? 'project', today)[0].key), true);
      jumpTo('row', key);
    },
    [rows, today, groupBys, setPanel, setFold, jumpTo],
  );

  return (
    <>
      {bar?.()}
      <section className="panel timeline" aria-label="Timeline">
        <div className="timeline__toolbar">
          <ChipSelect label="Sort" options={SORTS} value={sort} onChange={(v) => v && setSort(v)} />
          <Legend drawn={drawn} approx={approx} />
        </div>
        {acts.length > 1 && (
          <nav className="timeline__jumps" aria-label="Acts">
            <ul>
              {acts.map((act) => (
                <li key={act.key}>
                  <a
                    href={`#${baseId}-${act.key}`}
                    onClick={(event) => {
                      event.preventDefault();
                      setPanel(act.key, true);
                      jumpTo('panel', `${baseId}-${act.key}`);
                    }}
                  >
                    <b>{act.label}</b> {plural(act.rows.length, 'work')}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
        {rows.length ? (
          <div className="timeline__acts" ref={container}>
            {acts.map((act) => (
              <ActTimeline
                key={act.key}
                act={act}
                id={`${baseId}-${act.key}`}
                open={panels.get(act.key) ?? act.rows.length > 0}
                onToggle={togglePanel}
                groupBy={groupBys.get(act.key) ?? 'project'}
                onGroupBy={setGroupBy}
                zoom={zooms.get(act.key) ?? defaultZoomOf(act)}
                onZoom={setZoom}
                sort={sort}
                folds={folds}
                onFold={fold}
                total={actTotals?.[Number(act.key.slice(4))]}
                onShowAllStates={onShowAllStates}
                today={today}
                opened={opened}
                onDetails={toggleDetails}
                unfollow={unfollow}
                onJump={onJump}
                pairs={pairs}
              />
            ))}
          </div>
        ) : (
          <p className="timeline__empty">No works match these filters. Clear a filter to see more.</p>
        )}
      </section>
    </>
  );
}
