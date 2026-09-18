import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { routes } from './app.routes';

/**
 * The index search and document content screens were folded into one page, so their links and
 * bookmarks have to land on the same results the reader asked for.
 */
describe('app routes', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRouter(routes)] });
  });

  const go = async (url: string) => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl(url);
    return router.url;
  };

  it('sends an old index search link to the search page', async () => {
    expect(await go('/index')).toBe('/search');
  });

  it('sends an old content search link to the search page, inside documents', async () => {
    expect(await go('/content')).toBe('/search?record=documents&scope=inside');
  });

  it('carries the words from an old link over as the keyword', async () => {
    expect(await go('/index?q=Cariboo%20Gold')).toBe('/search?keywords=Cariboo%20Gold');
  });

  it('keeps the inside-documents scope alongside the carried words', async () => {
    expect(await go('/content?q=caribou'))
      .toBe('/search?record=documents&scope=inside&keywords=caribou');
  });

  // The old screens held sort and tab state the grid reads from different keys; a guessed
  // translation would open on a view nobody asked for.
  it('drops an old parameter the search page has no place for', async () => {
    expect(await go('/index?q=mine&sortBy=name&scopeTab=documents')).toBe('/search?keywords=mine');
  });
});
