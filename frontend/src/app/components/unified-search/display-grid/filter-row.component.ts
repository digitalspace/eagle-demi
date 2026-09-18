import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { FilterValue, FilterValues, GridColumn } from '../../../search/grid-types';
import { ValuePickerComponent } from './value-picker.component';
import { YearPickerComponent } from './year-picker.component';

type Row = Record<string, unknown>;

/** A typed box holds more than any name the index carries. */
export const FILTER_TEXT_MAX = 120;

/** Typing should not fire a request per keystroke; pickers and years apply at once. */
const TEXT_DEBOUNCE_MS = 300;

export interface FilterChange {
  id: string;
  value: FilterValue;
}

/** The row of controls under the headings: one per column that can narrow the set. */
@Component({
  selector: 'tr[app-filter-row]',
  standalone: true,
  imports: [ValuePickerComponent, YearPickerComponent],
  templateUrl: './filter-row.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class FilterRowComponent {
  columns = input<GridColumn<Row>[]>([]);
  values = input<FilterValues>({});

  changed = output<FilterChange>();

  readonly textMax = FILTER_TEXT_MAX;

  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  idOf(column: GridColumn<Row>): string {
    return column.filterId ?? column.key;
  }

  /**
   * One stored value as the single string a text or year control holds. Joined, not first: the URL
   * splits a value on commas, so a typed name carrying one arrives here in pieces.
   */
  asText(id: string): string {
    const value = this.values()[id];
    return Array.isArray(value) ? value.join(',') : (value ?? '');
  }

  asArray(id: string): string[] {
    const value = this.values()[id];
    if (Array.isArray(value)) return value;
    return value ? [value] : [];
  }

  onText(id: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    clearTimeout(this.timers.get(id));
    this.timers.set(
      id,
      setTimeout(() => this.changed.emit({ id, value }), TEXT_DEBOUNCE_MS),
    );
  }

  emit(id: string, value: FilterValue): void {
    this.changed.emit({ id, value });
  }
}
