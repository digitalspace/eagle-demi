import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { GridColumn, SortState } from '../../../search/grid-types';

type Row = Record<string, unknown>;

/** The table's heading row. Every column sorts; the one in force says which way it is sorted. */
@Component({
  // A `tr` cannot be wrapped in an element, so the component takes the row over as its selector.
  selector: 'tr[app-grid-header]',
  standalone: true,
  imports: [],
  templateUrl: './grid-header.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class GridHeaderComponent {
  columns = input<GridColumn<Row>[]>([]);
  sort = input<SortState | null>(null);

  sorted = output<string>();

  isActive(column: GridColumn<Row>): boolean {
    return this.sort()?.key === column.key;
  }

  ariaSort(column: GridColumn<Row>): string | null {
    if (!this.isActive(column)) return null;
    return this.sort()?.dir === 'asc' ? 'ascending' : 'descending';
  }

  arrow(column: GridColumn<Row>): string {
    if (!this.isActive(column)) return '⇅';
    return this.sort()?.dir === 'asc' ? '▲' : '▼';
  }
}
