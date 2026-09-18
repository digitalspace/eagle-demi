import { Component, viewChild } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { GuidedTourComponent } from './guided-tour.component';

/** A page with one stand-in control per `data-tour` key, and a button that starts the tour. */
@Component({
  standalone: true,
  imports: [GuidedTourComponent],
  template: `
    <button #opener type="button" (click)="start(opener)">Take the tour</button>
    <div data-tour="search">search box</div>
    <div data-tour="types">record types</div>
    <div data-tour="more">more filters</div>
    <app-guided-tour />
  `,
})
class TourHostComponent {
  tour = viewChild.required(GuidedTourComponent);

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
