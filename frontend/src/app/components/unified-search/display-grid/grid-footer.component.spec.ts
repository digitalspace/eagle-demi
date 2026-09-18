import { ComponentFixture, TestBed } from '@angular/core/testing';
import { GridFooterComponent } from './grid-footer.component';
import { PAGE_SIZES } from '../../../search/grid-url';

describe('GridFooterComponent', () => {
  let fixture: ComponentFixture<GridFooterComponent>;

  async function mount(page: number, pageSize: number, total: number): Promise<HTMLElement> {
    fixture = TestBed.createComponent(GridFooterComponent);
    fixture.componentRef.setInput('page', page);
    fixture.componentRef.setInput('pageSize', pageSize);
    fixture.componentRef.setInput('total', total);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  /** A chip by the text it shows: the page numbers and the sizes are both drawn as chips. */
  function chip(host: HTMLElement, text: string): HTMLButtonElement {
    const found = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).filter(
      (button) => button.textContent?.trim() === text,
    );
    expect(found.length).withContext(`one chip reading "${text}"`).toBe(1);
    return found[0];
  }

  function pagerChips(host: HTMLElement): string[] {
    return Array.from(host.querySelectorAll('.display-grid__pager li')).map((item) =>
      (item.textContent ?? '').trim(),
    );
  }

  beforeEach(() => TestBed.configureTestingModule({ imports: [GridFooterComponent] }));

  it('offers every page size, pressing only the one in use', async () => {
    const host = await mount(1, 25, 500);

    const sizes = Array.from(
      host.querySelectorAll<HTMLButtonElement>('.display-grid__footer-group button'),
    );
    expect(sizes.map((button) => button.textContent?.trim())).toEqual(
      PAGE_SIZES.map((size) => String(size)),
    );
    expect(sizes.map((button) => button.getAttribute('aria-pressed'))).toEqual([
      'false',
      'true',
      'false',
      'false',
    ]);
  });

  it('emits the size the reader picked, not the one in use', async () => {
    const host = await mount(1, 25, 500);
    const picked: number[] = [];
    fixture.componentInstance.pageSizeChange.subscribe((size: number) => picked.push(size));

    chip(host, '100').click();
    chip(host, '10').click();

    expect(picked).toEqual([100, 10]);
  });

  it('draws the ends, a window around the current page, and gaps between', async () => {
    const host = await mount(9, 10, 300);

    // 30 pages, current 9: first, gap, 7-11, gap, last.
    expect(pagerChips(host)).toEqual(['‹', '1', '…', '7', '8', '9', '10', '11', '…', '30', '›']);
    expect(chip(host, '9').getAttribute('aria-current')).toBe('page');
    expect(chip(host, '8').getAttribute('aria-current')).toBeNull();
  });

  it('emits the exact page a number chip names', async () => {
    const host = await mount(9, 10, 300);
    const pages: number[] = [];
    fixture.componentInstance.pageChange.subscribe((page: number) => pages.push(page));

    chip(host, '30').click();
    chip(host, '7').click();
    chip(host, '1').click();

    expect(pages).toEqual([30, 7, 1]);
  });

  it('steps one page from the arrows and stays put on the current page', async () => {
    const host = await mount(9, 10, 300);
    const pages: number[] = [];
    fixture.componentInstance.pageChange.subscribe((page: number) => pages.push(page));

    host.querySelector<HTMLButtonElement>('[aria-label="Previous page"]')!.click();
    host.querySelector<HTMLButtonElement>('[aria-label="Next page"]')!.click();
    chip(host, '9').click();

    expect(pages).toEqual([8, 10]);
  });

  it('spends the arrow that has nowhere to go', async () => {
    const first = await mount(1, 10, 300);
    expect(first.querySelector<HTMLButtonElement>('[aria-label="Previous page"]')!.disabled).toBe(
      true,
    );
    expect(first.querySelector<HTMLButtonElement>('[aria-label="Next page"]')!.disabled).toBe(false);

    const last = await mount(30, 10, 300);
    expect(last.querySelector<HTMLButtonElement>('[aria-label="Previous page"]')!.disabled).toBe(
      false,
    );
    expect(last.querySelector<HTMLButtonElement>('[aria-label="Next page"]')!.disabled).toBe(true);
  });

  it('draws both halves at an empty total, so the row does not appear as results arrive', async () => {
    const host = await mount(1, 25, 0);

    expect(host.querySelector('.display-grid__footer-label')?.textContent?.trim()).toBe('Per page');
    expect(pagerChips(host)).toEqual(['‹', '1', '›']);
  });

  /* A page past the end is reachable from a shared URL; the pager clamps to the last page rather
     than drawing a page that holds nothing. */
  it('clamps a page past the end to the last one', async () => {
    const host = await mount(99, 25, 60);

    expect(pagerChips(host)).toEqual(['‹', '1', '2', '3', '›']);
    expect(chip(host, '3').getAttribute('aria-current')).toBe('page');
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Next page"]')!.disabled).toBe(true);
  });

  /* The footer row spaces two children apart: the sizes left, the pager right. display-grid.reset
     .css flattens this host so those two become the row's own children, which only holds while the
     component's root stays exactly that pair. */
  it('roots the page sizes and the pager as its only two children', async () => {
    const host = await mount(1, 25, 500);

    expect(
      Array.from(host.children).map(
        (child) => `${child.tagName.toLowerCase()}.${child.getAttribute('class') ?? ''}`,
      ),
    ).toEqual(['div.display-grid__footer-group', 'nav.']);
  });
});
