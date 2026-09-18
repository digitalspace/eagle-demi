import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RecordDetailComponent, type RecordDetail } from './record-detail.component';

const documentRecord: RecordDetail = {
  title: 'Wildlife Management Plan',
  meta: [],
  fields: [
    { label: 'Date posted', value: '2025-03-04' },
    { label: 'Document type', value: 'Report' },
  ],
  documentId: 'd1',
};

function mount(): { page: HTMLElement; detail: RecordDetailComponent; detectChanges: () => void } {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(RecordDetailComponent);
  fixture.detectChanges();
  return {
    page: fixture.nativeElement as HTMLElement,
    detail: fixture.componentInstance,
    detectChanges: () => fixture.detectChanges(),
  };
}

describe('RecordDetailComponent', () => {
  it('names itself by its title, so the dialog is announced as the record', () => {
    const { page, detail, detectChanges } = mount();

    detail.open(documentRecord);
    detectChanges();

    const dialog = page.querySelector('dialog');
    const title = page.querySelector('#record-detail-title');
    expect(dialog?.getAttribute('aria-labelledby')).toBe('record-detail-title');
    expect(title?.textContent).toContain('Wildlife Management Plan');
  });

  it('asks the page for the file rather than minting a URL itself', () => {
    const { page, detail, detectChanges } = mount();
    const asked: string[] = [];
    detail.downloadRequested.subscribe((id) => asked.push(id));

    detail.open(documentRecord);
    detectChanges();
    const download = Array.from(page.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Download',
    );
    download?.click();

    expect(asked).toEqual(['d1']);
  });

  it('names the page the record has of its own on the link that goes there', () => {
    const { page, detail, detectChanges } = mount();

    detail.open({
      title: 'Ajax Mine',
      meta: [],
      fields: [],
      link: { href: '/projects/p1', label: 'Open project page' },
    });
    detectChanges();

    const link = page.querySelector<HTMLAnchorElement>('.record-detail__actions a');
    expect(link?.textContent).toContain('Open project page');
    expect(link?.getAttribute('href')).toBe('/projects/p1');
  });
});
