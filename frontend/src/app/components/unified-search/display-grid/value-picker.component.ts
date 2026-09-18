import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { ValueOption } from '../../../search/grid-types';

/** Over this many values a checkbox list stops being readable and the typeahead takes over. */
const TYPEAHEAD_FROM = 40;

/**
 * A column's multi-select filter: a button that opens a list of the values the column holds.
 *
 * Past forty options the list gets a typeahead box, the same affordance the document type picker
 * gives its long list, because scrolling several hundred checkboxes is not a way to find one.
 */
@Component({
  selector: 'app-value-picker',
  standalone: true,
  imports: [],
  templateUrl: './value-picker.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class ValuePickerComponent {
  /** The column's label; the button reads "Filter by <label>". */
  label = input.required<string>();
  options = input<ValueOption[]>([]);
  selected = input<string[]>([]);

  changed = output<string[]>();

  open = signal(false);
  typed = signal('');

  picked = computed(() => this.options().filter((option) => this.selected().includes(option.value)));

  typeahead = computed(() => this.options().length > TYPEAHEAD_FROM);

  shown = computed(() => {
    const term = this.typed().trim().toLowerCase();
    if (!term) return this.options();
    return this.options().filter((option) => option.label.toLowerCase().includes(term));
  });

  buttonText = computed(() => {
    const picked = this.picked();
    if (picked.length === 0) return 'All';
    return picked.length === 1 ? picked[0].label : `${picked.length} selected`;
  });

  fullList = computed(() =>
    this.picked().length ? this.picked().map((option) => option.label).join(', ') : null,
  );

  toggleOpen(): void {
    this.open.update((open) => !open);
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') this.open.set(false);
  }

  onType(event: Event): void {
    this.typed.set((event.target as HTMLInputElement).value);
  }

  toggleValue(value: string): void {
    const current = this.selected();
    this.changed.emit(
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    );
  }

  clear(): void {
    this.changed.emit([]);
  }
}
