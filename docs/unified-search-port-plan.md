# Porting the unified search page into the DEMI Demo frontend

Plan written 2026-09-17. Replaces the index search and content search screens in `frontend/` with one search page ported from eagle-public (`react` branch, PRs #881 to #889).

## Findings

Target framework is Angular 22.1.3 (`frontend/package.json:17-30`), Karma + Jasmine, CI runs `yarn --cwd frontend lint`, `test --no-watch` and `build` (`.github/workflows/pr.yaml:88-96`). No React, no TanStack Query.

Screens to replace: index search at `/index` (`app.routes.ts:14`, nav `shell/screens.ts:18`, `components/index-search/`); content search at `/content` (`app.routes.ts:15`, `screens.ts:19`, `components/content-search/`). Both use `components/doc-type-select/`, which has no other consumer. `app.routes.ts:37` redirects `/search` to `index`. `map-explorer.component.ts:999` navigates to `/index?q=`; `app.component.ts:41` reads `q`.

All state and fetches live in `services/registry-state.service.ts`. The old screens call `/search?dataset=Project|Document&pageSize=500` (`:1343`, `:1362`), `dataset=DocumentChunk&pageSize=50&fuzzy=true` (`:1376`, flat), `dataset=List` (`:1711`), `/db/stats` (`:1774`), `/documents/:id/download` (`:1883`). Sector is filtered client-side.

Auth: shell gate (`app.component.html:19-21`), global fetch interceptor adds the bearer token (`registry-state.service.ts:746-758`). Base path `getBasePath()` = `API_PATH` or `/api`, same-origin through APIM `/*`.

DEMI API already serves everything the page needs: `GET /search` (`src/http/routes.js:124`), `GET /search/counts` (`:127`; Project, Document, RecentActivity, ProjectNotification at `controllers/search.js:1518`), Organization (`:498`), grouped `passages[]` (`:1408`), `CONTENT_SEARCH` in the public config keys (`controllers/config.js:47`).

Source: `eagle-public/src/app/pages/search/unified-search.tsx` and `src/app/components/display-grid/`. The CSS is token based (`--layout-*`, `--typography-*`, `--surface-color-*`) and namespaced under `.display-grid`, so it copies over unchanged.

## 1. Framework gap

Copy verbatim (no framework): `display-grid/types.ts`, `grid-helpers.ts`, `passage-locator.ts`, `tour-steps.ts`; the pure half of `use-grid-url-state.ts` (`parseGridParams`, `serializeGridParams`, `toApiFilters`); `search-filters.ts`; the data half of `pages/search/types/*.ts`; the nine CSS files.

Rewrite as one Angular standalone signal component per React component:

| eagle-public | eagle-demi |
|---|---|
| `unified-search.tsx` | `components/unified-search/unified-search.component.*` |
| `display-grid.tsx` with header, filter row, footer, chip row, select cell | `unified-search/display-grid/*.component.*` |
| `grid-toolbar.tsx` | `grid-toolbar.component.*` |
| `advanced-filters.tsx`, `value-picker.tsx`, `year-picker.tsx` | same names; `CustomMultiSelect` becomes a typeahead seeded from `doc-type-select` |
| `list-row.tsx`, `passage-list.tsx`, `record-link.tsx` | same names |
| `guided-tour.tsx`, `search-help-dialog.tsx` | same names |
| `highlight.tsx` | `highlight.pipe.ts` over the existing `service.highlightField` |
| `use-grid-url-state.ts` | `search-grid-url.service.ts` over `ActivatedRoute` and `Router.navigate({queryParams, replaceUrl})` |
| `use-type-counts.ts`, `use-settled.ts`, `useQuery` | `unified-search.service.ts`: one AbortController per pause, 300 ms debounce, 2 character floor, keep previous rows |
| `bulk-download.ts`, `subscribe-popover.tsx` | dropped |

Column `render` and `rowComponent` return `ReactNode` in the source. Switch them to a string or a small discriminated union the template switches on. Legacy route rewriting uses `canActivate` returning a `UrlTree` (pattern at `app.routes.ts:29-36`).

## 2. Endpoints

Every call maps to a same-origin `/api/...` path already reachable: `/search` for all four datasets, grouped `DocumentChunk`, `List`, `Organization` (new call for this frontend), `/search/counts` (keep the 404 fallback), `/api/config` for `CONTENT_SEARCH`, `/documents/:id/download` (keep the presigned path). Project links go to the in-app `/projects/:id`. Nothing is missing. The only data gap is partial `pageNumbered` coverage until the test re-extraction ends around 2026-09-22.

## 3. Scope

In: four record types with count badges, server paging, sorting and column filters, advanced filters and chips, column show and hide, copy link, skeleton rows, `scope=inside` with passages gated on `CONTENT_SEARCH`, guided tour, help dialog.

Out: bulk download and its selection column (`selectable: false`, hook kept), the notify popover (DEMI has `/notify`), eagle-public legacy redirects.

Old screen behaviour kept by folding in: the download button (as `GridColumn.onLinkClick`), server highlight with client fallback, `readPrefs().perPage` as the default page size, the map explorer `q` mapped to `keywords`.

Dropped: the 500-row client pull with client-side sector filter and the "500+" label, "Load N more", the sort select, side-by-side panels, empty-result sector chips, `/db/stats`, "Copy passage id".

## 4. Removal (phase 4)

Delete `components/index-search/*`, `components/content-search/*`, `components/doc-type-select/*`; `app.routes.ts:14-15`; `screens.ts:18-19` replaced by one `{ key: 'search', label: 'Search', group: 'Discover', path: '/search' }`; merge the two `TECH` entries (`screens.ts:48-57`) into one; invert `app.routes.ts:37`. Add `canActivate` redirects: `/index` to `/search?record=projects&keywords=<q>`, `/content` to `/search?record=documents&scope=inside&keywords=<q>`. Update `map-explorer.component.ts:999` and its spec at line 92, `app.component.spec.ts:146,160`, `app.component.ts:41`, wiki `Frontend.md:34-38`. `activePage` keeps `'search'` (`:602`).

## 5. Phases

One PR each on `main`. Every phase runs lint, test and build.

1. Engine, no UI. `frontend/src/app/search/`: `grid-types.ts`, `grid-url.ts`, `search-filters.ts`, `record-types/*.ts`, `unified-search.service.ts`. Specs: URL round trip, `filterIds` reach the wire as `and[id]=`, counts 404 fallback, abort on a newer pause, `passages[]` read. Done when the specs pass and no existing file is touched.
2. Grid, Projects and Documents, new `/search` route. Nav untouched. Specs: sort changes the URL, a filter change resets to page 1, narrow layout renders cards, tab switch keeps the keyword and clears filters, copy link. Done when real rows load from test with one request per pause per type.
3. Activities, Notifications, inside scope, download. A spec per type; passage list shows "Page N" only when `pageNumbered`; scope switch absent when the flag is off. Done when four tabs and both scopes work on test.
4. Retire the old screens. Section 4 plus a routing spec for `/index` and `/content` with `q` preserved. Done when nothing references `IndexSearchComponent` or `ContentSearchComponent` and the sidebar shows one Search entry. Done 2026-09-18: `/index` goes to `/search`, `/content` to `/search?record=documents&scope=inside`, both carrying `q` as `keywords`.
5. Tour, help, wiki. Specs: tour advances, Escape closes, focus returns; dialog traps focus.

## 6. Open decisions

1. One nav entry merging the two "How this is built" stories, or panel text switching per tab. Before phase 4.
2. Bulk download: out, or a sixth phase.
3. "Copy passage id", `/db/stats`, chunk retry: drop, or a home in the toolbar.
4. Phase 3 with mixed "Page N" coverage until about 2026-09-22, or wait.
5. Full port or narrow (phases 1 and 2 only). Before phase 1.
