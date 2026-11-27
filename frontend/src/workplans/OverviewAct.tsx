import { useCallback, useLayoutEffect, useRef } from 'react';
import { useLocation } from 'react-router';
import type { MarkStyle } from './chart-types';
import { plural } from './format';
import type { AxisLine } from './overview-axis';
import type { OverviewShared } from './Overview';
import { edgeStyle } from './overview-plot';
import { OverviewRow } from './OverviewRow';
import { ScrollWindow } from './ScrollWindow';
import type { OverviewActData } from './use-overview-acts';
import { useEdgePass } from './use-edge-pass';

type ActYear = OverviewActData['year'];

const mod = (base: string, cls: string) => (cls ? `${base} ${base}--${cls}` : base);

const Grid = ({ lines, hi }: { lines: readonly AxisLine[]; hi?: boolean }) => (
  <div className={hi ? 'wp-ov-ovl wp-ov-ovl--hi' : 'wp-ov-ovl'} aria-hidden="true">
    {lines.map((line, i) => (
      <span key={i} className={mod('wp-ov-gl', line.cls)} style={{ left: `${line.x}%` }} />
    ))}
  </div>
);

function Axis({ act, onScroll }: { act: OverviewActData; onScroll: () => void }) {
  if (!act.ticks) return null;
  const spanStyle: MarkStyle = { '--span': act.span };
  return (
    <div className="wp-ov-axis">
      <div className="wp-ov-axv" onScroll={onScroll}>
        <div className="wp-ov-axt" style={spanStyle}>
          <div className="wp-ov-axp">
            {act.ticks.ticks.map((tick, i) => (
              <span key={`t${i}`} className={mod('wp-ov-tk', tick.cls)} style={{ left: `${tick.x}%` }} />
            ))}
            {act.ticks.tlabels.map((label, i) => (
              <span
                key={`l${i}`}
                className={mod('wp-ov-tkl', label.cls)}
                style={{ left: `${label.x}%` }}
                title={label.title !== label.text ? label.title : undefined}
              >
                {label.text}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Calls the latest `fn` through a function that never changes, so memoised rows skip the page's tooltip renders. */
function useStable<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}

/** One Act: its sticky head (title beside the axis and scroll window) and, while open, its rows box. */
export function OverviewAct({ act, shared }: { act: OverviewActData; shared: OverviewShared }) {
  const { year } = act;
  const { search } = useLocation();
  const open = !shared.closed.has(year);
  const { headRef, rowsRef, range, onRowsScroll, onAxisScroll } = useEdgePass(act, open);
  const goRow = useStable((to: ActYear, projectId: string) => shared.goRow(to, projectId));
  const { register, scroll, params } = shared;

  const box = useCallback(
    (el: HTMLDivElement | null) => {
      rowsRef.current = el;
      register(year, el);
    },
    [rowsRef, register, year],
  );

  // Opening a closed Act while zoomed puts it on today or its latest date, once its box is drawn.
  const reopened = useRef(false);
  useLayoutEffect(() => {
    if (!open || !reopened.current) return;
    reopened.current = false;
    if (params.zoom !== 'whole') scroll({ to: 'open' }, year);
  }, [open, params.zoom, scroll, year]);
  const toggle = () => {
    reopened.current = !open;
    shared.tip.hide();
    shared.setOpen(year, !open);
  };

  const spanStyle: MarkStyle = { '--span': act.span };
  const headId = `act-h-${year}`;
  const bodyId = `act-b-${year}`;
  return (
    <section className="wp-ov-act" id={`act-${year}`} aria-labelledby={headId} style={edgeStyle}>
      <div className={open ? 'wp-ov-shead wp-ov-shead--on' : 'wp-ov-shead'} ref={headRef}>
        <div className="wp-ov-acthead">
          <h2 id={headId}>
            <button className="wp-ov-actbtn" type="button" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 6l4 4 4-4" />
              </svg>
              {year} Act
            </button>
          </h2>
        </div>
        {open && (
          <div className="wp-ov-shr">
            <Axis act={act} onScroll={onAxisScroll} />
            <ScrollWindow act={act} box={rowsRef} valueText={range} today={shared.today} />
          </div>
        )}
      </div>
      {open && (
        <div id={bodyId}>
          {act.rows.length === 0 && <p className="wp-ov-empty">{act.emptyText}</p>}
          <div
            ref={box}
            className="wp-ov-tlx"
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region needs a keyboard stop
            tabIndex={0}
            role="region"
            aria-label={`${year} Act timeline, ${plural(act.rows.length, 'row')}. Use the arrow keys to scroll sideways.`}
            onScroll={onRowsScroll}
          >
            <div
              className="wp-ov-rows"
              style={spanStyle}
              onMouseMove={(event) => shared.tip.hitTest(event, '.wp-ov-nc')}
              onMouseLeave={shared.tip.hideSoon}
            >
              {act.ticks && <Grid lines={act.ticks.grid} />}
              {act.ticks && <Grid lines={act.ticks.gridHi} hi />}
              {act.rows.map((data) => (
                <OverviewRow
                  key={data.cand.row.project.projectId}
                  year={year}
                  data={data}
                  today={shared.today}
                  from={search}
                  goRow={goRow}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
