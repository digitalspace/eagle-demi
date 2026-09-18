import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { gridCollator } from '../../../search/grid-types';

/** A date column filters by year: the whole range in one control, no calendar to open. */
@Component({
  selector: 'app-year-picker',
  standalone: true,
  imports: [],
  templateUrl: './year-picker.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class YearPickerComponent {
  /** The column's label; the control reads "Filter by <label>". */
  label = input.required<string>();
  /** Distinct years, in any order. Newest first is applied here so callers need not sort. */
  years = input<string[]>([]);
  value = input('');

  changed = output<string>();

  newestFirst = computed(() =>
    [...new Set(this.years())].sort((a, b) => gridCollator.compare(b, a)),
  );

  onChange(event: Event): void {
    this.changed.emit((event.target as HTMLSelectElement).value);
  }
}
