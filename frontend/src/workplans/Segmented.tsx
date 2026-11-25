import { useId, type KeyboardEvent, type ReactNode } from 'react';
import './workplans.css';
import './chart-controls.css';

const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** A labelled row of buttons, one pressed at a time; `radio` makes it a radio group with arrow keys. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  labelHidden = false,
  radio = false,
}: {
  label: string;
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  /** The label still names the group for screen readers. */
  labelHidden?: boolean;
  /** Radio group: one tab stop on the checked option, arrows, Home and End move and select. */
  radio?: boolean;
}) {
  const id = useId();
  const checked = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const last = options.length - 1;
    const to =
      event.key === 'Home' ? 0 : event.key === 'End' ? last : event.key in STEP ? checked + STEP[event.key] : null;
    if (to === null || last < 0) return;
    event.preventDefault();
    const next = (to + options.length) % options.length;
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
    if (next !== checked) onChange(options[next].value);
  };

  return (
    <div className="wp-segmented">
      <span id={id} className={labelHidden ? 'visually-hidden' : 'wp-segmented__label'}>
        {label}
      </span>
      {radio ? (
        <div
          className="wp-tgroup"
          role="radiogroup"
          aria-labelledby={id}
          aria-orientation="horizontal"
        >
          {options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              className="wp-tbtn"
              role="radio"
              aria-checked={index === checked && option.value === value}
              tabIndex={index === checked ? 0 : -1}
              onKeyDown={onKeyDown}
              onClick={() => onChange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : (
        <div className="wp-segmented__options" role="group" aria-labelledby={id}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className="wp-segmented__option"
              aria-pressed={option.value === value}
              onClick={() => onChange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
