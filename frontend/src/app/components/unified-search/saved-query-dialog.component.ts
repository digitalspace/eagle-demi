import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewEncapsulation,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { UserdataService } from '../../services/userdata.service';

export const SAVED_QUERY_NAME_MAX = 80;

/**
 * Names the current search and saves it, so the reader can come back to it from the toolbar.
 *
 * Unencapsulated: this stylesheet also dresses the saved-query rows the toolbar renders in its
 * own menu, which sits outside this component's template.
 */
@Component({
  selector: 'app-saved-query-dialog',
  standalone: true,
  imports: [],
  templateUrl: './saved-query-dialog.component.html',
  styleUrls: ['./saved-query-dialog.css'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class SavedQueryDialogComponent {
  private userdata = inject(UserdataService);

  private dialogRef = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  /** The button that opened the dialog, so focus goes back to it rather than to the top. */
  private opener: HTMLElement | null = null;
  private params = '';

  readonly maxLength = SAVED_QUERY_NAME_MAX;

  name = signal('');
  saving = signal(false);
  error = signal('');

  valid = computed(() => {
    const length = this.name().trim().length;
    return length > 0 && length <= SAVED_QUERY_NAME_MAX;
  });

  /** `params` is the query string the saved entry replays, without its leading `?`. */
  open(opener: HTMLElement, params: string): void {
    this.opener = opener;
    this.params = params;
    this.name.set('');
    this.error.set('');
    this.dialogRef()?.nativeElement.showModal();
  }

  onInput(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
  }

  close(): void {
    this.dialogRef()?.nativeElement.close();
  }

  /** Escape, Cancel and a finished save all arrive here, so focus returns either way. */
  onClose(): void {
    this.opener?.focus();
    this.opener = null;
  }

  async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.valid() || this.saving()) return;
    this.error.set('');
    this.saving.set(true);
    // saveQuery reloads /me/data on success, which is what refreshes the toolbar's list.
    const saved = await this.userdata.saveQuery(this.name().trim(), this.params);
    this.saving.set(false);
    if (saved) this.close();
    else this.error.set(this.userdata.error());
  }
}
