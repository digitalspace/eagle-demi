import { TestBed } from '@angular/core/testing';
import { excerptAround, highlightParts, toTerms } from './highlight';
import { HighlightComponent } from './highlight.component';

describe('search highlighting', () => {
  it('keeps words of two characters or more, without their quotes or repeats', () => {
    expect(toTerms('"fish habitat" a fish')).toEqual(['fish', 'habitat']);
    expect(toTerms('')).toEqual([]);
  });

  it('marks the matched substring, not the whole word', () => {
    expect(highlightParts('Resediment control', ['sediment'])).toEqual([
      { text: 'Re', hit: false },
      { text: 'sediment', hit: true },
      { text: ' control', hit: false },
    ]);
  });

  it('merges two terms that overlap into one run', () => {
    expect(highlightParts('sediment', ['sediment', 'diment'])).toEqual([
      { text: 'sediment', hit: true },
    ]);
  });

  it('leaves text with no term untouched', () => {
    expect(highlightParts('Mine permit', [])).toEqual([{ text: 'Mine permit', hit: false }]);
  });

  it('starts a collapsed excerpt at the first hit rather than at the top', () => {
    const text = `${'a'.repeat(300)} fish habitat`;

    expect(excerptAround(text, ['fish'], { length: 40 })).toBe(`…${'a'.repeat(40)}…`);
    // A hit already near the top leaves the excerpt where the record starts.
    expect(excerptAround('fish habitat', ['fish'], { length: 40 })).toBe('fish habitat');
  });

  it('renders each hit as a mark and the rest as plain text', () => {
    const fixture = TestBed.createComponent(HighlightComponent);
    fixture.componentRef.setInput('text', 'Resediment control');
    fixture.componentRef.setInput('terms', ['sediment']);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const marks = Array.from(host.querySelectorAll('mark'));
    expect(marks.length).toBe(1);
    expect(marks[0].className).toBe('display-grid__hit');
    expect(marks[0].textContent).toBe('sediment');
    // No phantom space either side of the mark: the word has to read as one word.
    expect(host.textContent).toBe('Resediment control');
  });
});
