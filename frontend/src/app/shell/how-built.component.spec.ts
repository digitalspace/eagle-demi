import { TestBed } from '@angular/core/testing';
import { HowBuiltComponent } from './how-built.component';

describe('HowBuiltComponent', () => {
  /** Renders the panel for one screen key and returns its root element. */
  async function render(screenKey: string): Promise<HTMLElement> {
    await TestBed.configureTestingModule({ imports: [HowBuiltComponent] }).compileComponents();
    const fixture = TestBed.createComponent(HowBuiltComponent);
    fixture.componentRef.setInput('screenKey', screenKey);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  // The heading and the sidebar link are two names for one screen, so they have to read the same.
  it('titles the panel with the screen name the sidebar shows', async () => {
    const el = await render('project');
    expect(el.querySelector('.panel__title')?.textContent).toContain('How AI Project Summary is built');
  });

  it('keeps the search summary screen named apart from the project one', async () => {
    const el = await render('summary');
    expect(el.querySelector('.panel__title')?.textContent).toContain('How AI Search Summary is built');
  });
});
