import { TestBed } from '@angular/core/testing';
import { PassageListComponent } from './passage-list.component';
import type { PassageRow } from '../../../search/grid-types';

function row(text: string): PassageRow {
  return {
    id: 'd1',
    name: 'Amendment #3 Application — Volume 1',
    href: 'https://files.example.gov.bc.ca/d1.pdf',
    date: '2026-02-18',
    type: 'Amendment Application',
    author: 'Proponent',
    passages: [{ locator: 1, text }],
    total: 1,
  };
}

function render(text: string, terms: string[]): HTMLElement {
  const fixture = TestBed.createComponent(PassageListComponent);
  fixture.componentRef.setInput('rows', [row(text)]);
  fixture.componentRef.setInput('terms', terms);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('PassageListComponent', () => {
  it('shows the API marks as the highlight rather than as words', () => {
    const page = render('6.2 Focal <mark>Wildlife</mark> species', ['wildlife']);

    const passage = page.querySelector('.display-grid__passage-text');
    expect(passage?.textContent).toBe('6.2 Focal Wildlife species');
    expect(passage?.querySelectorAll('mark').length).toBe(1);
    expect(passage?.querySelector('mark')?.textContent).toBe('Wildlife');
  });

  it('marks a hit once where the API and the terms name the same words', () => {
    const page = render('<mark>wildlife</mark> and <mark>wildlife</mark>', ['wildlife']);

    const passage = page.querySelector('.display-grid__passage-text');
    expect(passage?.textContent).toBe('wildlife and wildlife');
    expect(passage?.querySelectorAll('mark').length).toBe(2);
  });

  it('renders a hostile passage as text rather than injecting it', () => {
    const page = render('<script>alert(1)</script> <img src=x onerror=alert(1)> wildlife', [
      'wildlife',
    ]);

    expect(page.querySelector('script')).toBeNull();
    expect(page.querySelector('img')).toBeNull();
    expect(page.querySelector('.display-grid__passage-text')?.textContent).toContain(
      '<script>alert(1)</script>',
    );
  });
});
