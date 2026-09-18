import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { PASSAGE_LOCATOR, type PassageHit, type PassageRow } from '../../../search/grid-types';
import { HighlightComponent } from './highlight.component';
import { RecordLinkComponent } from './record-link.component';

/**
 * Passages a row shows before it is expanded. Two carry enough of the document's own words to
 * judge the hit, and still leave the next file name on the screen.
 */
const COLLAPSED_PASSAGES = 2;

/**
 * The API wraps each hit in `<mark>`. The list marks the terms itself, from plain text, so the
 * markup is stripped rather than injected: an excerpt is index output, not trusted HTML.
 */
const MARK_TAG = /<\/?mark>/g;

/**
 * The documents tab with the scope set to inside the documents: one row per file, and under the
 * file name the passages the index matched rather than the record's fields. Renders inside the
 * grid box, because it borrows the list row's own meta, headline and Show more styles.
 */
@Component({
  selector: 'app-passage-list',
  standalone: true,
  imports: [HighlightComponent, RecordLinkComponent],
  templateUrl: './passage-list.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class PassageListComponent {
  rows = input<PassageRow[]>([]);
  /** Search terms from `toTerms`, for the highlights. */
  terms = input<string[]>([]);
  loading = input(false);

  /** The file has no address of its own, so the press asks the page for a presigned one. */
  downloadRequested = output<string>();

  private open = new Set<string>();

  isOpen(row: PassageRow): boolean {
    return this.open.has(row.id);
  }

  toggle(row: PassageRow): void {
    if (!this.open.delete(row.id)) this.open.add(row.id);
  }

  shown(row: PassageRow): PassageHit[] {
    return this.isOpen(row) ? row.passages : row.passages.slice(0, COLLAPSED_PASSAGES);
  }

  rest(row: PassageRow): number {
    return row.passages.length - COLLAPSED_PASSAGES;
  }

  meta(row: PassageRow): string[] {
    return [row.date, row.type, row.author].filter((part): part is string => !!part);
  }

  passageCount(total: number): string {
    return `${total} matching passage${total === 1 ? '' : 's'}`;
  }

  moreLabel(row: PassageRow): string {
    if (this.isOpen(row)) return 'Show fewer passages';
    const rest = this.rest(row);
    return `${rest} more passage${rest === 1 ? '' : 's'}`;
  }

  /** One passage as plain words, for the highlight to mark. */
  passageText(hit: PassageHit): string {
    return hit.text.replace(MARK_TAG, '');
  }

  locatorLabel(hit: PassageHit): string {
    return PASSAGE_LOCATOR.label(hit);
  }

  locatorHref(row: PassageRow, hit: PassageHit): string | undefined {
    return PASSAGE_LOCATOR.href(row, hit);
  }
}
