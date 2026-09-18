import { Component, signal, viewChild } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { GuidedTourComponent } from './guided-tour.component';

/**
 * A page with one stand-in control per `data-tour` key, and a button that starts the tour. Each
 * control can be taken off the page mid-walk, which is what a breakpoint or a tab switch does.
 */
@Component({
  standalone: true,
  imports: [GuidedTourComponent],
  template: `
    <button #opener type="button" (click)="start(opener)">Take the tour</button>
    @if (showSearch()) {
      <div data-tour="search">search box</div>
    }
    @if (showTypes()) {
      <div data-tour="types">record types</div>
    }
    @if (showMore()) {
      <div data-tour="more">more filters</div>
    }
    <app-guided-tour />
  `,
})
class TourHostComponent {
  tour = viewChild.required(GuidedTourComponent);
  showSearch = signal(true);
  showTypes = signal(true);
  showMore = signal(true);

  start(opener: HTMLElement): void {
    this.tour().start(opener);
  }
}

function card(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.display-grid__tour-card');
}

function cardButton(label: string): HTMLButtonElement {
  const found = Array.from(card()?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (button) => button.textContent?.trim() === label,
  );
  if (!found) throw new Error(`No "${label}" button on the tour card`);
  return found;
}

function counter(): string {
  return card()?.querySelector('.display-grid__tour-count')?.textContent?.trim() ?? '';
}

function title(): string {
  return card()?.querySelector('.display-grid__tour-title')?.textContent?.trim() ?? '';
}

function press(key: string, options: KeyboardEventInit = {}): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }));
}

describe('GuidedTourComponent', () => {
  let fixture: ComponentFixture<TourHostComponent>;
  let opener: HTMLButtonElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [TourHostComponent] });
    fixture = TestBed.createComponent(TourHostComponent);
    fixture.detectChanges();
    opener = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
  });

  afterEach(() => {
    // A tour left open holds the page inert and keeps a document-level key listener.
    fixture.componentInstance.tour().end();
    fixture.detectChanges();
  });

  function start(): void {
    opener.focus();
    opener.click();
    fixture.detectChanges();
  }

  it('counts only the steps this page can show, and walks them in order', () => {
    start();

    expect(counter()).toBe('Step 1 of 3');
    expect(title()).toBe('One search box');

    cardButton('Next').click();
    fixture.detectChanges();

    expect(counter()).toBe('Step 2 of 3');
    expect(title()).toBe('Pick a record type');

    cardButton('Back').click();
    fixture.detectChanges();

    expect(counter()).toBe('Step 1 of 3');
  });

  /** What takes a control away under the reader: a breakpoint change, reported as a resize. */
  function relayout(): void {
    window.dispatchEvent(new Event('resize'));
    fixture.detectChanges();
  }

  // Next counts what is on the page now, so with nothing left after this control the walk is over
  // rather than spotlighting a control that has gone.
  it('ends the walk when the only control after this one has gone', () => {
    start();
    cardButton('Next').click();
    fixture.detectChanges();
    expect(counter()).toBe('Step 2 of 3');

    fixture.componentInstance.showMore.set(false);
    fixture.detectChanges();

    cardButton('Next').click();
    fixture.detectChanges();

    expect(card()).toBeNull();
  });

  // The gone control hands its slot to the one after it. Landing back on step 1 would walk the
  // reader through steps they have already seen.
  it('moves on to the next control when the lit one goes mid-walk', () => {
    start();
    cardButton('Next').click();
    fixture.detectChanges();
    expect(title()).toBe('Pick a record type');

    fixture.componentInstance.showTypes.set(false);
    fixture.detectChanges();
    relayout();

    expect(title()).toBe('Filters that are not columns');
    expect(counter()).toBe('Step 2 of 2');
  });

  it('ends the tour and hands focus back when every control has gone', () => {
    start();
    const host = fixture.componentInstance;
    host.showSearch.set(false);
    host.showTypes.set(false);
    host.showMore.set(false);
    fixture.detectChanges();

    relayout();

    expect(card()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes on Escape', () => {
    start();
    expect(card()).not.toBeNull();

    press('Escape');
    fixture.detectChanges();

    expect(card()).toBeNull();
  });

  it('hands focus back to the control that started it', () => {
    start();
    expect(card()).toBe(document.activeElement as HTMLElement);

    cardButton('Skip tour').click();
    fixture.detectChanges();

    // The assertion that fails if `end()` stops focusing the opener: focus falls to the body.
    expect(document.activeElement).toBe(opener);
  });

  it('keeps Tab inside the card, so the last control wraps to the first', () => {
    start();
    const last = cardButton('Next');
    const first = cardButton('Skip tour');
    last.focus();

    press('Tab');

    expect(document.activeElement).toBe(first);

    press('Tab', { shiftKey: true });

    expect(document.activeElement).toBe(last);
  });

  it('makes the page inert bar the control the step is lighting', () => {
    start();

    expect(document.querySelector('[data-tour="search"]')?.hasAttribute('inert')).toBe(false);
    expect(document.querySelector('[data-tour="types"]')?.hasAttribute('inert')).toBe(true);

    cardButton('Next').click();
    fixture.detectChanges();

    expect(document.querySelector('[data-tour="search"]')?.hasAttribute('inert')).toBe(true);
    expect(document.querySelector('[data-tour="types"]')?.hasAttribute('inert')).toBe(false);
  });
});
