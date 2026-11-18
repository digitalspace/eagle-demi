import { useId, useMemo } from 'react';
import { STATUS_LABEL, type WorkRow, type WorkStatus } from './derive';
import { workTypeOf } from './timeline-rows';

export interface WorkFilters {
  act: number | null;
  type: string | null;
  status: WorkStatus | null;
  /** Off: works the public read would hide (`shownAfterFlip` false) are left out. */
  showHidden: boolean;
}

const ACTS = [1996, 2002, 2018];
const STATUSES = Object.keys(STATUS_LABEL) as WorkStatus[];

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

/** Act, work type and, with `withStatus`, status chips over `rows`, plus the switch that brings back hidden works. */
export function Filters({
  rows,
  value,
  onChange,
  withStatus,
}: {
  rows: WorkRow[];
  value: WorkFilters;
  onChange: (next: WorkFilters) => void;
  withStatus: boolean;
}) {
  const types = useMemo(() => {
    const byCode = new Map(rows.map((row) => [row.work.workTypeCode ?? '', workTypeOf(row).name]));
    return [...byCode]
      .filter(([code]) => code)
      .map(([code, name]) => ({ value: code, label: name }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [rows]);

  return (
    <div className="wp-filters">
      <ChipGroup
        label="Act"
        options={ACTS.map((year) => ({ value: year, label: String(year) }))}
        value={value.act}
        onChange={(act) => onChange({ ...value, act })}
      />
      <ChipGroup label="Work type" options={types} value={value.type} onChange={(type) => onChange({ ...value, type })} />
      {withStatus && (
        <ChipGroup
          label="Status"
          options={STATUSES.map((status) => ({ value: status, label: STATUS_LABEL[status] }))}
          value={value.status}
          onChange={(status) => onChange({ ...value, status })}
        />
      )}
      <Chip pressed={value.showHidden} onClick={() => onChange({ ...value, showHidden: !value.showHidden })}>
        Show replaced and hidden
      </Chip>
    </div>
  );
}
