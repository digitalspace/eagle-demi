import { useId, useMemo, type ReactNode } from 'react';
import { ChipSelect } from './ChipSelect';
import { STATUS_LABEL, type WorkRow, type WorkStatus } from './derive';
import { plural } from './format';
import { WORK_STATE_LABEL, type WorkState } from './work-state';
import { workTypeOf } from './work-types';

export interface WorkFilters {
  /** Matched, case-insensitive, against the work title, the project name and the work type name. */
  query: string;
  /** Null: every state the view shows. */
  state: WorkState | null;
  act: number | null;
  type: string | null;
  status: WorkStatus | null;
  /** Current phase name; the List only. */
  phase: string | null;
  /** Off: works the public read would hide (`shownAfterFlip` false) are left out. */
  showHidden: boolean;
}

/** The filter bar, rendered by each view. `lead` goes first in the row; `summary` replaces the "N works" count. */
export type BarSlot = (slots?: { lead?: ReactNode; summary?: ReactNode }) => ReactNode;

/** Props of each view: `rows` arrive already narrowed by the bar. */
export interface ViewProps {
  rows: WorkRow[];
  today: string;
  bar?: BarSlot;
}

const ACTS = [1996, 2002, 2018];
// Closed and inactive come from Work state, so the two filters cannot contradict each other.
const STATUSES = (Object.keys(STATUS_LABEL) as WorkStatus[]).filter((status) => status !== 'closed' && status !== 'inactive');

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: string }) {
  return (
    <button type="button" className="wp-chip" aria-pressed={pressed} onClick={onClick}>
      {children}
      {pressed && (
        <span className="wp-chip__clear" aria-hidden="true">
          ×
        </span>
      )}
    </button>
  );
}

/** One labelled set of chips; pressing the active chip clears it. */
function ChipGroup<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T | null;
  onChange: (value: T | null) => void;
}) {
  const id = useId();
  return (
    <div className="wp-filters__group" role="group" aria-labelledby={id}>
      <span id={id} className="wp-filters__label">
        {label}
      </span>
      {options.map((option) => (
        <Chip
          key={option.value}
          pressed={option.value === value}
          onClick={() => onChange(option.value === value ? null : option.value)}
        >
          {option.label}
        </Chip>
      ))}
    </div>
  );
}

const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);

function useOptions(rows: WorkRow[]) {
  return useMemo(() => {
    const types = new Map(
      rows.flatMap((row): [string, string][] => (row.work.workTypeCode ? [[row.work.workTypeCode, workTypeOf(row).name]] : [])),
    );
    const phases = new Set(rows.flatMap((row) => (row.current?.name ? [row.current.name] : [])));
    return {
      types: [...types].map(([code, name]) => ({ value: code, label: name })).sort(byLabel),
      phases: [...phases].map((name) => ({ value: name, label: name })).sort(byLabel),
    };
  }, [rows]);
}

/**
 * Search, Work state and the other filters over `rows`, plus the switch that brings back hidden works.
 * `value` holds what this view applies; a change comes back as the fields that changed.
 */
export function Filters({
  rows,
  value,
  onChange,
  states,
  withStatus,
  withPhase,
  count,
  lead,
  summary,
}: {
  rows: WorkRow[];
  value: WorkFilters;
  onChange: (change: Partial<WorkFilters>) => void;
  /** Work state options; none hides the chip. */
  states: readonly WorkState[];
  withStatus: boolean;
  withPhase: boolean;
  count: number;
  lead?: ReactNode;
  summary?: ReactNode;
}) {
  const { types, phases } = useOptions(rows);
  return (
    <div className="wp-filters">
      {lead}
      <label className="wp-search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-4-4" />
        </svg>
        <input
          type="search"
          className="wp-search__input"
          aria-label="Search works"
          placeholder="Search works"
          value={value.query}
          onChange={(event) => onChange({ query: event.target.value })}
        />
      </label>
      {states.length > 0 && (
        <ChipSelect
          label="Work state"
          options={states.map((state) => ({ value: state, label: WORK_STATE_LABEL[state] }))}
          value={value.state}
          onChange={(state) => onChange({ state })}
          clearable
        />
      )}
      {withPhase && (
        <ChipSelect label="Phase" options={phases} value={value.phase} onChange={(phase) => onChange({ phase })} clearable />
      )}
      <ChipGroup
        label="Act"
        options={ACTS.map((year) => ({ value: year, label: String(year) }))}
        value={value.act}
        onChange={(act) => onChange({ act })}
      />
      <ChipGroup label="Work type" options={types} value={value.type} onChange={(type) => onChange({ type })} />
      {withStatus && (
        <ChipGroup
          label="Status"
          options={STATUSES.map((status) => ({ value: status, label: STATUS_LABEL[status] }))}
          value={value.status}
          onChange={(status) => onChange({ status })}
        />
      )}
      <Chip pressed={value.showHidden} onClick={() => onChange({ showHidden: !value.showHidden })}>
        Show replaced and hidden
      </Chip>
      <span className="wp-filters__count" aria-live="polite">
        {summary ?? plural(count, 'work')}
      </span>
    </div>
  );
}
