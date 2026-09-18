import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { SearchGridUrlService } from './search-grid-url.service';

@Component({ selector: 'app-search-host', standalone: true, template: '' })
class SearchHostComponent {}

describe('SearchGridUrlService', () => {
  let service: SearchGridUrlService;
  let router: Router;
  let harness: RouterTestingHarness;

  beforeEach(async () => {
    spyOn(window, 'fetch').and.callFake(() =>
      Promise.resolve(new Response('[]', { status: 200 })),
    );

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        provideRouter([{ path: 'search', component: SearchHostComponent }]),
      ],
    });

    harness = await RouterTestingHarness.create();
    router = TestBed.inject(Router);
    service = TestBed.inject(SearchGridUrlService);
  });

  /** The address bar, without the origin. */
  const url = (): string => router.url;

  it('reads the grid state off the query string', async () => {
    await harness.navigateByUrl(
      '/search?record=projects&keywords=mine&sortBy=-dateUpdated&currentPage=3&pageSize=50&cols=region&type=Mines',
    );

    expect(service.state()).toEqual({
      keywords: 'mine',
      record: 'projects',
      scope: 'names',
      sortBy: '-dateUpdated',
      currentPage: 3,
      pageSize: 50,
      hiddenColumns: ['region'],
      filters: { type: 'Mines' },
    });
  });

  it('writes a sort change back to the address bar', async () => {
    await harness.navigateByUrl('/search?record=projects&keywords=mine');

    service.setSort('name', '+');
    await harness.fixture.whenStable();

    expect(url()).toBe('/search?keywords=mine&record=projects&sortBy=%2Bname');
  });

  it('flips the direction when the same column is sorted again', async () => {
    await harness.navigateByUrl('/search?record=projects&sortBy=%2Bname');

    service.setSort('name', '+');
    await harness.fixture.whenStable();

    expect(url()).toBe('/search?record=projects&sortBy=-name');
  });

  it('resets to page one when a filter changes', async () => {
    await harness.navigateByUrl('/search?record=projects&currentPage=4');

    service.setFilter('region', ['Peace']);
    await harness.fixture.whenStable();

    expect(url()).toBe('/search?record=projects&sortBy=-datePosted&region=Peace');
  });

  it('drops a filter the caller clears', async () => {
    await harness.navigateByUrl('/search?record=projects&region=Peace&type=Mines');

    service.setFilter('region', null);
    await harness.fixture.whenStable();

    expect(url()).toBe('/search?record=projects&sortBy=-datePosted&type=Mines');
  });

  it('keeps the record type and page size when everything else is cleared', async () => {
    await harness.navigateByUrl('/search?record=projects&keywords=mine&region=Peace&pageSize=50');

    service.clearAll();
    await harness.fixture.whenStable();

    expect(url()).toBe('/search?record=projects&sortBy=-datePosted&pageSize=50');
  });

  it('leaves a value the defaults already state out of the query string', async () => {
    service.setDefaults({ defaultRecord: 'projects', defaultSort: '-dateUpdated' });
    await harness.navigateByUrl('/search?record=projects');

    service.setKeyword('mine');
    await harness.fixture.whenStable();

    expect(url()).toBe('/search?keywords=mine&sortBy=-dateUpdated');
  });
});
