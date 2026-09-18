import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

export interface GridChip {
  /** Filter id, or `keywords` for the search chip. Handed back on removal. */
  id: string;
  /** The one value this chip stands for. Absent for single-value filters. */
  value?: string;
  /** What the reader calls the filter: a column name, or `Search`. */
  label: string;
}

/**
 * What the result set has been narrowed by, one chip per value. A multi-select column contributes
 * a chip per picked value so each can be dropped on its own, and the keyword gets a chip too —
 * otherwise "Clear all" quietly throws away something the row never showed.
 */
@Component({
  selector: 'app-chip-row',
  standalone: true,
  imports: [],
  templateUrl: './chip-row.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class ChipRowComponent {
  chips = input<GridChip[]>([]);

  removed = output<GridChip>();
  clearedAll = output<void>();

  /** Two values of one multi-select filter need different names to be told apart. */
  removeLabel(chip: GridChip): string {
    return chip.value ? `Remove ${chip.label} ${chip.value}` : `Remove ${chip.label}`;
  }
}
