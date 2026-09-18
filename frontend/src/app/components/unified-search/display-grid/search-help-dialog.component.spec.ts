import { Component, viewChild } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { SearchHelpDialogComponent } from './search-help-dialog.component';

/** A page with the link that opens the help, so focus has somewhere to go back to. */
@Component({
  standalone: true,
  imports: [SearchHelpDialogComponent],
  template: `
    <button #opener type="button" (click)="open(opener)">Search help</button>
    <app-search-help-dialog (startTour)="tours = tours + 1" />
  `,
})
class HelpHostComponent {
  help = viewChild.required(SearchHelpDialogComponent);
  tours = 0;

  open(opener: HTMLElement): void {
    this.help().open(opener);
  }
}

describe('SearchHelpDialogComponent', () => {
  let fixture: ComponentFixture<HelpHostComponent>;
  let opener: HTMLButtonElement;

  function dialog(): HTMLDialogElement {
    const found = fixture.nativeElement.querySelector('dialog') as HTMLDialogElement | null;
    if (!found) throw new Error('No dialog on the page');
    return found;
  }

  function buttonNamed(label: string): HTMLButtonElement {
    const found = Array.from(dialog().querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === label || button.getAttribute('aria-label') === label,
    );
    if (!found) throw new Error(`No "${label}" button in the dialog`);
    return found;
  }

  /**
   * The `close` event is queued, and this browser stalls a spec that waits for it, so the handler
   * is driven the way the browser would drive it.
   */
  function closed(): void {
    dialog().dispatchEvent(new Event('close'));
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HelpHostComponent] });
    fixture = TestBed.createComponent(HelpHostComponent);
    fixture.detectChanges();
    opener = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
  });

  afterEach(() => {
    // A dialog left open sits in the top layer over every spec that follows.
    if (dialog().open) dialog().close();
  });

  function open(): void {
    opener.focus();
    opener.click();
    fixture.detectChanges();
  }

  it('opens modally, so the browser holds focus inside it', () => {
    open();

    expect(dialog().open).toBe(true);
    // `:modal` is true of `showModal()` and false of `show()` — and `show()` is the change that
    // would lose the browser's own focus trap, Escape and inert background.
    expect(dialog().matches(':modal')).toBe(true);
    expect(dialog().getAttribute('aria-labelledby')).toBe('search-help-title');
    expect(document.activeElement).toBe(dialog());
  });

  it('hands focus back to the control that opened it', () => {
    open();
    buttonNamed('Close search help').click();
    closed();

    // The assertion that fails if `onClose` stops focusing the opener: focus falls to the body.
    expect(document.activeElement).toBe(opener);
    expect(fixture.componentInstance.help().opened()).toBe(false);
  });

  it('leaves focus to the tour rather than pulling it back when the close event lands', () => {
    open();
    buttonNamed('Take the tour').click();

    expect(fixture.componentInstance.tours).toBe(1);
    expect(dialog().open).toBe(false);

    // Stands in for the tour card, which takes focus as the tour starts — before the browser has
    // delivered the dialog's queued `close` event.
    const tourCard = document.createElement('button');
    document.body.appendChild(tourCard);
    tourCard.focus();
    closed();

    // The assertion that fails if `onTakeTour` stops clearing the restore: the late close handler
    // drags focus off the tour and back to the link.
    expect(document.activeElement).toBe(tourCard);
    tourCard.remove();
  });
});
