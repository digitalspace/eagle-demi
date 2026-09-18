import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import type { AdvancedField, FilterValues } from '../../../search/grid-types';
import { FILTER_TEXT_MAX } from './filter-row.component';

/** The panel's element id, so the toolbar button can name it in `aria-controls`. */
export const ADVANCED_FILTERS_ID = 'display-grid-advanced-filters';

const DATE_FORMAT = 'YYYY-MM-DD';

/**
 * A typed date counts only once it is a real YYYY-MM-DD. The round trip through `Date` rejects
 * 2025-02-31, which the pattern alone accepts.
 */
export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

export interface PanelChange {
  id: string;
  /** `null` clears the filter. An unparseable date emits nothing at all. */
  value: string | null;
}

/**
 * The filterable parts of a record that no column shows: date ranges, legislation, flags.
 * Collapsed by default and `hidden` rather than removed, so the toolbar's `aria-controls` always
 * points at an element that exists.
 */
@Component({
  selector: 'app-advanced-filters',
  standalone: true,
  imports: [],
  templateUrl: './advanced-filters.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class AdvancedFiltersComponent {
  fields = input<AdvancedField[]>([]);
  values = input<FilterValues>({});
  open = input(false);

  changed = output<PanelChange>();

  readonly panelId = ADVANCED_FILTERS_ID;
  readonly dateFormat = DATE_FORMAT;
  readonly textMax = FILTER_TEXT_MAX;

  /* A date is typed a character at a time, so the field holds what was typed while the applied
     filter holds only what parsed. Without the draft the input would erase itself mid-entry. */
  private drafts = signal<Record<string, string>>({});

  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  asText(id: string): string {
    const value = this.values()[id];
    if (value == null) return '';
    return Array.isArray(value) ? value.join(',') : value;
  }

  draftOf(field: AdvancedField): string {
    return this.drafts()[field.id] ?? this.asText(field.id);
  }

  invalid(field: AdvancedField): boolean {
    const value = this.draftOf(field).trim();
    return field.kind === 'date' && value !== '' && !isValidIsoDate(value);
  }

  errorId(field: AdvancedField): string {
    return `${ADVANCED_FILTERS_ID}-${field.id}-error`;
  }

  onDate(field: AdvancedField, event: Event): void {
    const typed = (event.target as HTMLInputElement).value;
    this.drafts.update((current) => ({ ...current, [field.id]: typed }));
    if (typed.trim() === '') this.changed.emit({ id: field.id, value: null });
    else if (isValidIsoDate(typed.trim())) this.changed.emit({ id: field.id, value: typed.trim() });
    // Anything else is still being typed or is wrong: no filter change, no chip, no count.
  }

  onText(field: AdvancedField, event: Event): void {
    const typed = (event.target as HTMLInputElement).value;
    clearTimeout(this.timers.get(field.id));
    this.timers.set(
      field.id,
      setTimeout(() => this.changed.emit({ id: field.id, value: typed || null }), 300),
    );
  }

  onSelect(field: AdvancedField, event: Event): void {
    this.changed.emit({ id: field.id, value: (event.target as HTMLSelectElement).value || null });
  }

  onToggle(field: AdvancedField, event: Event): void {
    const on = (event.target as HTMLInputElement).checked;
    this.changed.emit({ id: field.id, value: on ? 'true' : null });
  }
}
