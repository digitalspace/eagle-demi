import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewEncapsulation,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { ListRowAttachment } from '../../search/grid-types';
import { RecordLinkComponent } from './display-grid/record-link.component';
import type { ListRowField, ListRowMeta } from './display-grid/list-row.component';

export type { ListRowField as RecordDetailField };

/** The record's own page, offered at the foot of the sheet. */
export interface RecordDetailLink {
  href: string;
  label: string;
  /** Leaves the app, so it opens as a plain anchor in its own tab. */
  external?: boolean;
}

/**
 * One record as the dialog reads it. Built by whoever owns the record type's columns, so the
 * dialog itself knows nothing about projects, documents, updates or notifications.
 */
export interface RecordDetail {
  title: string;
  /** Unlabelled parts, as the list row draws them: date · kind · project. */
  meta: ListRowMeta[];
  fields: ListRowField[];
  /** The record's own words, in full rather than excerpted. */
  body?: string;
  attachments?: ListRowAttachment[];
  link?: RecordDetailLink;
  /** A presigned file: the id the page asks the API for on the press. */
  documentId?: string;
}

/**
 * One record read in place, rather than by leaving the result set for its own page. A native
 * `<dialog>` opened with `showModal()`, so Escape, the top layer and an inert background are the
 * browser's own rather than this app's.
 *
 * Unencapsulated: the same stylesheet dresses the grid rows that open the dialog, which sit
 * outside this component's template.
 */
@Component({
  selector: 'app-record-detail',
  standalone: true,
  imports: [RecordLinkComponent],
  templateUrl: './record-detail.component.html',
  styleUrls: ['./record-detail.component.css'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class RecordDetailComponent {
  /** A presigned file the reader asked for; the page mints the URL. */
  downloadRequested = output<string>();

  private dialogRef = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  /** What was pressed to open the dialog, so focus goes back to it rather than to the top. */
  private opener: HTMLElement | null = null;

  detail = signal<RecordDetail | null>(null);

  open(detail: RecordDetail, opener?: HTMLElement): void {
    this.opener = opener ?? null;
    this.detail.set(detail);
    this.dialogRef()?.nativeElement.showModal();
  }

  close(): void {
    this.dialogRef()?.nativeElement.close();
  }

  /** Escape, the Close button and a link that navigates all arrive here, so focus returns. */
  onClose(): void {
    this.opener?.focus();
    this.opener = null;
  }

  onDownload(documentId: string): void {
    this.downloadRequested.emit(documentId);
  }

  attachmentMeta(attachment: ListRowAttachment): string {
    return [attachment.type, attachment.size].filter(Boolean).join(' · ');
  }
}
