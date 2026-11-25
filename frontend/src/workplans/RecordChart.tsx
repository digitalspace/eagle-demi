import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useMarkTip, type MarkTipControl } from './MarkTip';
import { pxAt, rangeAt, recordTicks, todayScroll, zoomAnchor, type RecordGeometry } from './record-axis';
import { jumpToPart } from './record-limits';
import { LABEL_GAP_PX, LABEL_PX, setScroll, trackWindow } from './record-scroll';
import type { RecordModel } from './record-model';
import { RecordLegend } from './RecordLegend';
import { f3, type ChartRow, type RecordMark, type RecordRow, type Tag } from './record-types';
import type { RecordHighlight } from './use-record-model';

/** A "Back to the list" button this close to the right edge sits left of its mark. */
const BACK_FLIP_PX = 190;

export const Chevron = ({ d }: { d: string }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
    <path d={d} />
  </svg>
);

export const TagView = ({ tag }: { tag: Tag }) => <span className={`wp-tag wp-tag--${tag.tone}`}>{tag.text}</span>;

interface MarkContext {
  bind: MarkTipControl['bind'];
  hl: RecordHighlight;
  width: number;
}

function MarkView({ m, ctx }: { m: RecordMark; ctx: MarkContext }) {
  const { hlId, backId, backToList } = ctx.hl;
  const lit = !!m.id && m.id === hlId;
  const at = m.backAt ?? m.left;
  const flip = ctx.width * (at / 100) > ctx.width - BACK_FLIP_PX;
  return (
    <>
      <span className={lit ? `${m.cls} hl` : m.cls} style={m.style} data-mid={m.id || undefined} {...ctx.bind(m.tip)}>
        {m.label}
      </span>
      {!!m.id && m.id === backId && (
        <button
          type="button"
          className={`wp-btn wp-btn--secondary wp-rec-backbtn${flip ? ' flip' : ''}`}
          style={{ left: `${f3(at)}%` }}
          onClick={(event) => backToList(event.currentTarget, m.id)}
        >
          Back to the list
        </button>
      )}
    </>
  );
}

/** A row or group swatch: a plain colour, a chart mark drawn small with its own classes, or the empty box when it has neither. */
export const RowSwatch = ({ sw, cls }: { sw: CSSProperties; cls: string }) => (
  <span className="wp-rec-sw" style={sw}>
    {(cls || !sw.background) && <span className={cls || 'none'} />}
  </span>
);

function RowName({ r, onToggle }: { r: RecordRow; onToggle: (workId: string) => void }) {
  const ex = r.expand;
  if (ex) {
    return (
      <button type="button" className="wp-rec-disc" aria-expanded={ex.open} aria-label={ex.text} onClick={() => onToggle(ex.workId)}>
        <Chevron d={ex.open ? 'M3 6l5 5 5-5' : 'M6 3l5 5-5 5'} />
        <RowSwatch sw={r.sw} cls={r.glyph} />
        <span className="wp-rec-tt">{r.name}</span>
      </button>
    );
  }
  return (
    <span className="wp-rec-sname">
      <RowSwatch sw={r.sw} cls={r.glyph} />
      <span>{r.name}</span>
    </span>
  );
}

function RowLabel({ r, onToggle }: { r: RecordRow; onToggle: (workId: string) => void }) {
  const chg = r.chg;
  return (
    <div className="wp-rec-clabel">
      <span className="wp-rec-cl1">
        <RowName r={r} onToggle={onToggle} />
        {r.tag && <TagView tag={r.tag} />}
        {r.tags2.map((t) => (
          <TagView key={t.text} tag={t} />
        ))}
      </span>
      {r.line2 && <span className="wp-rec-cl2">{r.line2}</span>}
      {r.limText && (
        <span className="wp-rec-cl3">
          {r.limText}
          {r.flag && <span className="wp-rec-cwarn">{r.flag}</span>}
        </span>
      )}
      {r.warn && <span className="wp-rec-cwarn">{r.warn}</span>}
      {r.pass && <span className="wp-rec-cpass">{r.pass}</span>}
      {chg && (
        <a
          className="wp-rec-chglink"
          href={chg.href}
          aria-label={chg.label}
          onClick={(event) => {
            event.preventDefault();
            jumpToPart(event.currentTarget, chg.headId);
          }}
        >
          {chg.text}
        </a>
      )}
    </div>
  );
}

interface RowProps {
  r: ChartRow;
  track: CSSProperties;
  ctx: MarkContext;
  onToggle: (workId: string) => void;
  onJump: (projectId: string, act: number) => void;
}

function ChartRowView({ r, track, ctx, onToggle, onJump }: RowProps) {
  if (r.type === 'head') {
    return (
      <div className={`wp-rec-crow wp-rec-ghead ${r.cls}`.trim()}>
        <div className="wp-rec-clabel">
          <h3 className="wp-rec-gtitle">{r.name}</h3>
          {r.line2 && <span className="wp-rec-cl2">{r.line2}</span>}
        </div>
        <div className="wp-rec-ctrack" style={track} />
      </div>
    );
  }
  if (r.type === 'note') {
    return (
      <div className="wp-rec-crow wp-rec-cnote">
        <div className="wp-rec-clabel">
          <p className="wp-rec-notep">{r.name}</p>
        </div>
        <div className="wp-rec-ctrack" style={track} />
      </div>
    );
  }
  const jump = r.jump;
  return (
    <div className={`wp-rec-crow ${r.cls}`.trim()} style={r.rowStyle}>
      <RowLabel r={r} onToggle={onToggle} />
      <div className="wp-rec-ctrack" style={track}>
        {r.isEmpty && (
          <span className="wp-rec-tnote">
            {r.emptyText}
            {jump && (
              <button type="button" className="wp-btn wp-btn--link" onClick={() => onJump(jump.projectId, jump.act)}>
                {jump.text}
              </button>
            )}
          </span>
        )}
        {r.marks.map((m, i) => (
          <MarkView key={i} m={m} ctx={ctx} />
        ))}
      </div>
    </div>
  );
}

/** Stable keys, so a row keeps its element (and its focused control) when an expand adds rows above others. */
function rowKeys(rows: readonly ChartRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base = `${r.type}|${r.name}|${r.type === 'row' ? (r.expand?.workId ?? r.cls) : ''}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}|${n}`;
  });
}

export interface RecordChartProps {
  model: RecordModel;
  geo: RecordGeometry;
  /** Project and Act: a new record opens on `first`, a zoom on the same one keeps its centre. */
  recordKey: string;
  today: string;
  first: number;
  /** Goes up by one on each Today press: scroll today to the centre. */
  todayRequest: number;
  onRange: (text: string) => void;
  onViewPx: (px: number) => void;
  hl: RecordHighlight;
  onToggle: (workId: string) => void;
  onJump: (projectId: string, act: number) => void;
}

/** Keeps the view across record, zoom and width changes, Today presses, and reports the range on scroll. */
function useChartScroll({ geo, recordKey, today, first, todayRequest, onRange, onViewPx }: RecordChartProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const axis = useRef<HTMLDivElement>(null);
  const [labelPx, setLabelPx] = useState(LABEL_PX);
  const view = useRef<{ key: string; geo: RecordGeometry; at: number } | null>(null);
  const frame = useRef(0);
  const geoNow = useRef(geo);
  useLayoutEffect(() => {
    geoNow.current = geo;
  }, [geo]);

  const report = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const el = scroller.current;
      if (el) onRange(rangeAt(geoNow.current, el.scrollLeft));
    });
  }, [onRange]);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    if (axis.current) axis.current.scrollLeft = el.scrollLeft;
    if (view.current) view.current.at = el.scrollLeft;
    report();
  }, [report]);

  // Focus on an off-screen axis mark scrolls the clip box itself; the rows follow, and a clamped scroller pulls the axis back.
  const onAxisScroll = useCallback(() => {
    const el = scroller.current;
    const ax = axis.current;
    if (!el || !ax || Math.abs(ax.scrollLeft - el.scrollLeft) < 1) return;
    el.scrollLeft = ax.scrollLeft;
    if (Math.abs(ax.scrollLeft - el.scrollLeft) >= 1) ax.scrollLeft = el.scrollLeft;
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      const w = trackWindow(el);
      setLabelPx(w.labelPx);
      onViewPx(w.viewPx);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onViewPx]);

  // A new record, or a zoom from Whole range, opens on the first dated phase; between zoom levels the centre date stays.
  useLayoutEffect(() => {
    const el = scroller.current;
    const was = view.current;
    if (!el || (was?.key === recordKey && was.geo === geo)) return;
    const anchor = was?.key === recordKey ? zoomAnchor(was.geo, was.at) : null;
    setScroll(el, axis.current, anchor?.mode === 'centre' ? pxAt(geo, anchor.day) - geo.viewPx / 2 : pxAt(geo, first) - LABEL_GAP_PX);
    view.current = { key: recordKey, geo, at: el.scrollLeft };
    report();
  }, [recordKey, geo, first, report]);

  const todayDone = useRef(todayRequest);
  useEffect(() => {
    const el = scroller.current;
    if (!el || todayRequest === todayDone.current) return;
    todayDone.current = todayRequest;
    const x = todayScroll(geo, today);
    if (x != null) setScroll(el, axis.current, x);
  }, [todayRequest, geo, today]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  return { scroller, axis, labelPx, onScroll, onAxisScroll };
}

/** Legend, All marks, the sticky axis row and every chart row of one record. */
export function RecordChart(props: RecordChartProps) {
  const { model, geo, hl, onToggle, onJump } = props;
  const { rootRef, tooltip, bind } = useMarkTip();
  const { scroller, axis, labelPx, onScroll, onAxisScroll } = useChartScroll(props);
  const { ticks, grid } = useMemo(() => recordTicks(geo), [geo]);
  const keys = useMemo(() => rowKeys(model.rows), [model.rows]);
  const track: CSSProperties = { width: `${geo.width}px` };
  const ctx: MarkContext = { bind, hl, width: geo.width };

  return (
    <div className="wp-rec-chartblk" ref={rootRef}>
      <RecordLegend model={model} />
      <div className="wp-rec-chart">
        <div className="wp-rec-axisrow">
          <span className="wp-rec-axlab">Phase, dates, days</span>
          <div className="wp-rec-axclip" ref={axis} onScroll={onAxisScroll}>
            <div className="wp-rec-axtrack" style={track}>
              {ticks.map((t, i) => (
                <span key={`t${i}`} className={`tick ${t.kind}`} style={{ left: `${f3(t.left)}%` }}>
                  {t.label}
                </span>
              ))}
              {model.axisMarks.map((m, i) => (
                <MarkView key={`m${i}`} m={m} ctx={ctx} />
              ))}
            </div>
          </div>
        </div>
        <div
          ref={scroller}
          className="wp-rec-dscroll"
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region needs a keyboard stop
          tabIndex={0}
          role="region"
          aria-label="Timeline rows. Use the arrow keys to scroll sideways in time."
          onScroll={onScroll}
        >
          <div className="wp-rec-dinner" style={{ width: `${geo.width + labelPx}px` }}>
            <div className="wp-rec-under" style={track}>
              {grid.map((left, i) => (
                <span key={i} className="wp-rec-gline" style={{ left: `${f3(left)}%` }} />
              ))}
            </div>
            <div className="wp-rec-over" style={track}>
              {model.vlines.map((v, i) => (
                <span key={i} className={v.cls} style={{ left: `${f3(v.left)}%` }} />
              ))}
            </div>
            {model.rows.map((r, i) => (
              <ChartRowView key={keys[i]} r={r} track={track} ctx={ctx} onToggle={onToggle} onJump={onJump} />
            ))}
          </div>
        </div>
      </div>
      {tooltip}
    </div>
  );
}
