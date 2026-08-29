import { AfterViewInit, ElementRef, viewChild, ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { TECH, TECH_CHIP } from './screens';

@Component({
  selector: 'app-how-built',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.Eager,
  host: { '(document:keydown.escape)': 'closed.emit()' },
  template: `
    <div style="position: fixed; inset: 0; z-index: 950; background: rgba(0,0,0,0.35); display: grid; place-items: center; padding: var(--layout-padding-large);" (click)="closed.emit()">
      <div #dialog role="dialog" aria-modal="true" aria-label="How this screen is built" tabindex="-1" (click)="$event.stopPropagation()" style="width: 34rem; max-width: 100%; max-height: 80vh; overflow-y: auto; box-sizing: border-box; background: var(--surface-color-background-white); border-radius: var(--layout-border-radius-medium); box-shadow: 0 8px 30px rgba(0,0,0,0.3); padding: var(--layout-padding-large);">
        <div style="display: flex; align-items: baseline; justify-content: space-between; gap: var(--layout-margin-small);">
          <h2 class="panel__title panel__title--inline" style="margin: 0;">How {{ tech().title }} is built</h2>
          <button type="button" (click)="closed.emit()" aria-label="Close" style="background: none; border: none; cursor: pointer; font: var(--typography-bold-body); color: var(--typography-color-secondary);">✕</button>
        </div>
        <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: var(--layout-margin-medium);">
          @for (chip of tech().chips; track chip) {
            <span [style]="chipStyle">{{ chip }}</span>
          }
        </div>
        <p class="cell__sub" style="margin: var(--layout-margin-medium) 0 0;">{{ tech().note }}</p>
      </div>
    </div>
  `
})
export class HowBuiltComponent implements AfterViewInit {
  private dialog = viewChild.required<ElementRef<HTMLElement>>('dialog');

  // Focus moves into the dialog on open; the overlay has no focus trap, Escape and the backdrop close it.
  ngAfterViewInit() {
    this.dialog().nativeElement.focus();
  }

  screenKey = input.required<string>();
  closed = output<void>();

  readonly chipStyle = TECH_CHIP;
  tech = computed(() => TECH[this.screenKey()] ?? TECH['map']);
}
