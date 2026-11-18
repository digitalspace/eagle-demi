import { useId } from 'react';
import './workplans.css';

/** A labelled row of buttons, one pressed at a time. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  labelHidden = false,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  /** The label still names the group for screen readers. */
  labelHidden?: boolean;
}) {
  const id = useId();
  return (
    <div className="wp-segmented">
      <span id={id} className={labelHidden ? 'visually-hidden' : 'wp-segmented__label'}>
        {label}
      </span>
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
    </div>
  );
}
