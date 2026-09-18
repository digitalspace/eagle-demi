import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import type { GridColumn } from '../../../search/grid-types';
import { DEFAULT_RECORD, RECORD_TYPES, toSearchParams } from '../../../search/grid-url';
import { recordConfig } from '../../../search/record-types';
import { UserdataService, type SavedQuery } from '../../../services/userdata.service';
import { ADVANCED_FILTERS_ID } from './advanced-filters.component';
import { SavedQueryDialogComponent } from '../saved-query-dialog.component';

type Row = Record<string, unknown>;

/**
 * The bar over the grid: what was counted, the column picker, the More filters switch and the
 * reader's saved queries.
 */
@Component({
  selector: 'app-grid-toolbar',
  standalone: true,
  imports: [SavedQueryDialogComponent],
  templateUrl: './grid-toolbar.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class GridToolbarComponent {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private userdata = inject(UserdataService);

  private saveDialog = viewChild(SavedQueryDialogComponent);

  /** What the rows are, for the count: "1–25 of 340 documents". */
  noun = input('records');
  page = input(1);
  pageSize = input(25);
  total = input(0);
  /** No total yet. A count of nothing would read "No documents" before the first answer lands. */
  loading = input(false);
  /** A keyword or a filter is narrowing the set, so the count says what it counted. */
  narrowed = input(false);
  columns = input<GridColumn<Row>[]>([]);
  hiddenColumns = input<string[]>([]);
  /** How many advanced filters are applied; drives the badge on More filters. */
  filterCount = input(0);
  panelOpen = input(false);

  toggledColumn = output<string>();
  toggledPanel = output<void>();

  readonly panelId = ADVANCED_FILTERS_ID;

  columnsOpen = signal(false);
  queriesOpen = signal(false);

  readonly queries = this.userdata.queries;

  countText = computed(() => {
    if (this.loading()) return '';
    const total = this.total();
    if (total === 0) return `No ${this.noun()}`;
    const last = Math.min(this.page() * this.pageSize(), total);
    // A page past the end of the result set would otherwise read "51-5 of 5".
    const first = Math.min((this.page() - 1) * this.pageSize() + 1, last);
    const range = `${this.n(first)}–${this.n(last)} of ${this.n(total)} ${this.noun()}`;
    return this.narrowed() ? `${range} matching` : range;
  });

  isShown(column: GridColumn<Row>): boolean {
    return !!column.locked || !this.hiddenColumns().includes(column.key);
  }

  toggleColumns(): void {
    this.columnsOpen.update((open) => !open);
  }

  toggleQueries(): void {
    this.queriesOpen.update((open) => !open);
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    this.columnsOpen.set(false);
    this.queriesOpen.set(false);
  }

  openSaveDialog(event: Event): void {
    this.saveDialog()?.open(event.currentTarget as HTMLElement, this.currentParams());
  }

  /** The record type a saved query replays, read back out of its own params. */
  recordLabel(query: SavedQuery): string {
    const record = new URLSearchParams(query.params).get('record');
    return recordConfig(RECORD_TYPES.find((type) => type === record) ?? DEFAULT_RECORD).label;
  }

  openQuery(query: SavedQuery): void {
    this.queriesOpen.set(false);
    void this.router.navigateByUrl(`/search?${query.params}`);
  }

  deleteQuery(query: SavedQuery): void {
    void this.userdata.deleteQuery(query.slug);
  }

  /** The address bar as it stands, which is what a saved query replays. */
  private currentParams(): string {
    return toSearchParams(this.route.snapshot.queryParams).toString();
  }

  private n(value: number): string {
    return value.toLocaleString('en-CA');
  }
}
