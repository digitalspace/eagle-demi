import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import type { ListRowAttachment } from '../../../search/grid-types';
import { HighlightComponent } from './highlight.component';
import { excerptAround } from './highlight';
import { RecordLinkComponent } from './record-link.component';

export type { ListRowAttachment };

/**
 * Over this many characters the body is cut to an excerpt and offered a Show more. The cut is by
 * character, not by line: a line clamp shows three lines of a wide row and three of a phone row,
 * so the same record says a paragraph on a desktop and a sentence on a phone.
 */
const CLAMP_AT = 260;

export interface ListRowField {
  label: string;
  value: string;
}

/** One part of the meta line. A part with a target is rendered as an in-app link. */
export interface ListRowMeta {
  text: string;
  href?: string;
}

/** One record as the list template draws it, built by whichever page owns the record type. */
export interface ListRowData {
  meta: ListRowMeta[];
  title: string;
  href?: string;
  external?: boolean;
  body?: string;
  fields?: ListRowField[];
  attachments?: ListRowAttachment[];
}

/** One record as a block of prose rather than a row of cells: the narrow layout's card. */
@Component({
  selector: 'app-list-row',
  standalone: true,
  imports: [HighlightComponent, RecordLinkComponent],
  templateUrl: './list-row.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class ListRowComponent {
  /** Meta line parts, joined with a middot. */
  meta = input<ListRowMeta[]>([]);
  title = input('');
  href = input<string | undefined>();
  external = input(false);
  fields = input<ListRowField[]>([]);
  /** The record's own words, excerpted around the first hit until the row is expanded. */
  body = input('');
  /** Search terms from `toTerms`, for the excerpt and the highlights. */
  terms = input<string[]>([]);
  attachments = input<ListRowAttachment[]>([]);


  expanded = signal(false);

  long = computed(() => this.body().length > CLAMP_AT);

  /* Collapsed, the excerpt starts at the first hit: a match in paragraph three is no use if the
     row shows paragraph one. */
  shownBody = computed(() =>
    this.expanded() || !this.long()
      ? this.body()
      : excerptAround(this.body(), this.terms(), { length: CLAMP_AT }),
  );

  /** A body and a field list are alternatives: the records that have prose do not list fields. */
  pairs = computed(() => (this.body() ? [] : this.fields()));

  docsLabel = computed(() =>
    this.attachments().length === 1 ? '1 document' : `${this.attachments().length} documents`,
  );

  toggle(): void {
    this.expanded.update((open) => !open);
  }

  attachmentMeta(attachment: ListRowAttachment): string {
    return [attachment.type, attachment.size].filter(Boolean).join(' · ');
  }
}
