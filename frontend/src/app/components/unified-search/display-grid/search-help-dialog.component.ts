import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewEncapsulation,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { ScrollLock } from './scroll-lock';

/**
 * The search help, as a modal.
 *
 * A native `<dialog>` opened with `showModal()`, so the focus trap, Escape and the `aria-modal`
 * semantics are the browser's rather than ours.
 *
 * Unencapsulated: the stylesheet is scoped by the `display-grid__help` class the way the rest of
 * the grid's overlays are, and the page that opens it carries the link this dresses.
 */
@Component({
  selector: 'app-search-help-dialog',
  standalone: true,
  imports: [],
  templateUrl: './search-help-dialog.component.html',
  styleUrls: ['./search-help-dialog.css'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class SearchHelpDialogComponent {
  startTour = output<void>();

  private dialogRef = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private readonly lock = new ScrollLock();
  /** The control that opened the dialog, so focus goes back to it rather than to the top. */
  private opener: HTMLElement | null = null;
  /** Cleared when the tour takes over: the tour owns focus from there, and returns it itself. */
  private restoreOnClose = true;

  /** Read by the opener, which tells assistive tech whether its dialog is showing. */
  opened = signal(false);

  open(opener?: HTMLElement): void {
    const element = this.dialogRef()?.nativeElement;
    if (!element) return;
    this.opener = opener ?? (document.activeElement as HTMLElement | null);
    if (!element.open) element.showModal();
    // Focus lands on the dialog rather than on its first control, so a reader hears the title
    // before the close button.
    element.focus();
    this.lock.lock(element);
    this.opened.set(true);
  }

  close(): void {
    this.dialogRef()?.nativeElement.close();
  }

  /** Escape, the X and a backdrop press all arrive here, so focus returns either way. */
  onClose(): void {
    this.lock.release();
    this.opened.set(false);
    if (this.restoreOnClose) this.opener?.focus();
    this.restoreOnClose = true;
    this.opener = null;
  }

  /**
   * A press that lands on the dialog element itself is a press on the backdrop: the backdrop is
   * painted by the dialog, and its presses retarget to it.
   */
  onPress(event: MouseEvent): void {
    if (event.target === this.dialogRef()?.nativeElement) this.close();
  }

  onTakeTour(): void {
    this.restoreOnClose = false;
    this.close();
    this.startTour.emit();
  }
}
