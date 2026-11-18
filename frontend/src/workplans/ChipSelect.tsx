import { useRef } from 'react';
import './workplans.css';

/**
 * A native `<select>` laid over a pill reading "Label" when empty and "Label: Option" when set.
 * `clearable` adds an "All" option and, once set, a × button named "Clear <label>".
 */
export function ChipSelect<T extends string | number>({
  label,
  options,
  value,
  onChange,
  clearable = false,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T | null;
  onChange: (value: T | null) => void;
  clearable?: boolean;
}) {
  const select = useRef<HTMLSelectElement>(null);
  const chosen = options.find((option) => option.value === value);
  const pick = (raw: string) => onChange(options.find((option) => String(option.value) === raw)?.value ?? null);
  // The × unmounts once cleared; focus moves to the select so it does not fall to the page.
  const clear = () => {
    onChange(null);
    select.current?.focus();
  };
  return (
    // Only a filter that can be cleared shows as set; a setting like Sort always has a value.
    <span className={`wp-chip-select${clearable && chosen ? ' wp-chip-select--set' : ''}`}>
      <span className="wp-chip-select__text" aria-hidden="true">
        {chosen ? `${label}: ${chosen.label}` : label}
      </span>
      <select
        ref={select}
        className="wp-chip-select__native"
        aria-label={label}
        value={chosen ? String(chosen.value) : ''}
        onChange={(event) => pick(event.target.value)}
      >
        {(clearable || !chosen) && <option value="">All</option>}
        {options.map((option) => (
          <option key={option.value} value={String(option.value)}>
            {option.label}
          </option>
        ))}
      </select>
      {clearable && chosen && (
        <button type="button" className="wp-chip-select__clear" aria-label={`Clear ${label}`} onClick={clear}>
          <span aria-hidden="true">×</span>
        </button>
      )}
    </span>
  );
}
