import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { PAGE_SIZES } from '../../../search/grid-url';

/** The page numbers a pager shows: the ends, a window around the current page, gaps between. */
export function pageNumbers(total: number, current: number): (number | 'ellipsis')[] {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);

  const pages: (number | 'ellipsis')[] = [1];
  let startPage = Math.max(2, current - 2);
  let endPage = Math.min(total - 1, current + 2);
  if (current <= 4) endPage = Math.min(5, total - 1);
  if (current >= total - 3) startPage = Math.max(2, total - 4);

  if (startPage > 2) pages.push('ellipsis');
  for (let page = startPage; page <= endPage; page += 1) pages.push(page);
  if (endPage < total - 1) pages.push('ellipsis');
  if (total > 1) pages.push(total);
  return pages;
}

/**
 * Page sizes and the pager. Both are drawn at every total — a reader who has narrowed to nothing
 * can still see the page size they are on, and the row does not change height as results arrive.
 */
@Component({
  selector: 'app-grid-footer',
  standalone: true,
  imports: [],
  templateUrl: './grid-footer.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class GridFooterComponent {
  page = input(1);
  pageSize = input(25);
  total = input(0);

  pageChange = output<number>();
  pageSizeChange = output<number>();

  readonly sizes = PAGE_SIZES;

  totalPages = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize())));
  current = computed(() => Math.min(Math.max(this.page(), 1), this.totalPages()));
  entries = computed(() => pageNumbers(this.totalPages(), this.current()));

  change(next: number | 'ellipsis'): void {
    if (next === 'ellipsis' || next === this.current() || next < 1 || next > this.totalPages()) {
      return;
    }
    this.pageChange.emit(next);
  }
}
