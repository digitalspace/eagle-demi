import { useId } from 'react';
import { Segmented } from './Segmented';
import { ZOOMS, type Zoom } from './time-scale';
import './chart-controls.css';


interface YearPick {
  years: number[];
  /** '' while no year is picked. */
  value: string;
  onChange: (year: number | null) => void;
}

/**
 * Five zoom levels, Zoom out, Zoom in and Today. `stacked` puts the label above and ends with a year select
 * (Overview); `inline` puts the label beside and ends with the live range text (Record page).
 */
export function TimeScale({
  layout,
  zoom,
  onZoom,
  onToday,
  todayDisabled = false,
  year,
  range,
}: {
  layout: 'stacked' | 'inline';
  zoom: Zoom;
  onZoom: (zoom: Zoom) => void;
  onToday: () => void;
  /** Today is always off at the whole range; set this when today is outside the chart too. */
  todayDisabled?: boolean;
  /** Stacked only. */
  year?: YearPick;
  /** Inline only, such as "Showing Jan 2019 to Dec 2023". */
  range?: string;
}) {
  const labelId = useId();
  const yearId = useId();
  const at = Math.max(0, ZOOMS.findIndex((level) => level.value === zoom));
  const step = (by: number) => {
    const next = ZOOMS[at + by];
    if (next) onZoom(next.value);
  };
  // aria-disabled, not disabled, so focus stays on a button that reaches the end of the range.
  const off = { out: at === 0, in: at === ZOOMS.length - 1, today: at === 0 || todayDisabled };

  const controls = (
    <>
      <Segmented label="Time scale" labelHidden radio options={ZOOMS} value={zoom} onChange={onZoom} />
      <button type="button" className="wp-btn wp-btn--secondary wp-btn--icon" aria-label="Zoom out" aria-disabled={off.out} onClick={() => step(-1)}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M3 8h10" />
        </svg>
      </button>
      <button type="button" className="wp-btn wp-btn--secondary wp-btn--icon" aria-label="Zoom in" aria-disabled={off.in} onClick={() => step(1)}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M3 8h10M8 3v10" />
        </svg>
      </button>
      <button type="button" className="wp-btn wp-btn--secondary" aria-disabled={off.today} onClick={() => {
          if (!off.today) onToday();
        }}>
        Today
      </button>
    </>
  );

  if (layout === 'inline') {
    return (
      <div className="wp-timescale wp-timescale--inline" role="group" aria-labelledby={labelId}>
        <span id={labelId} className="wp-timescale__label">
          Time scale
        </span>
        {controls}
        <span className="wp-timescale__range" aria-live="polite">
          {range}
        </span>
      </div>
    );
  }

  return (
    <div className="wp-timescale wp-timescale--stacked" role="group" aria-labelledby={labelId}>
      <span id={labelId} className="wp-timescale__label">
        Time scale
      </span>
      <div className="wp-timescale__controls">
        {controls}
        {year && (
          <>
            <label className="visually-hidden" htmlFor={yearId}>
              Go to year
            </label>
            <select
              id={yearId}
              className="wp-dsel wp-timescale__year"
              value={year.value}
              onChange={(event) => year.onChange(event.target.value ? Number(event.target.value) : null)}
            >
              <option value="">Year</option>
              {year.years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
    </div>
  );
}
