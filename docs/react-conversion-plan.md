# Convert eagle-demi/frontend from Angular to React

Status: slices 1 to 6 done. The React app now lives in `frontend/`, and the Angular app is gone; the last commit with both is `0038d3e`. Where this plan says `frontend-react/`, read `frontend/`. Still open: the post-merge checks under Verification (staging deploy, real Keycloak login on test).

## Context

`frontend/` is the "DEMI Demo" app: Angular 22, 12 screens behind one Keycloak sign-in gate, 11,036 LOC of TypeScript, 2,923 LOC of templates, 4,133 LOC of CSS, 33 Karma specs. Every other new EPIC frontend is React (`eagle-demi-admin`, `eagle-public` `react` line). The unified search screen here was itself ported from eagle-public's React source into Angular, so the same feature is now kept in two frameworks. Moving this app to React ends that, lets it share the admin panel's auth, config and API code, and drops Karma and zone.js.

Outcome: same 12 screens, same URLs, same look, same deploy target, built with Vite and React. No new features.

## Approach

Build the React app beside the Angular one in `frontend-react/`. The staging deploy workflow only triggers on `frontend/**`, so nothing ships until the last PR. That PR deletes the Angular app and renames `frontend-react/` to `frontend/`, so deploy scripts and workflows barely change.

Stack, copied from `eagle-demi-admin` unless noted:

- Vite 8, React 19, TypeScript strict, `react-router` 7 with `createBrowserRouter` and lazy routes per screen.
- `keycloak-js` singleton from `eagle-demi-admin/src/api/keycloak.ts`, with one change kept from the Angular app: `onLoad` is `login-required` when a login is remembered, `check-sso` otherwise (`registry-state.service.ts` `initKeycloak()`). Keep `silent-check-sso.html`, PKCE S256, scope `openid roles`.
- `api<T>()` fetch wrapper from `eagle-demi-admin/src/api/client.ts` with origin-equality token attach and one refresh-and-retry on 401/403. This replaces the global `window.fetch` monkey-patch. The notify screen uses the same wrapper with the notify origin allowed.
- Runtime config from `public/env.js`, same merge order as `config.service.ts`: `/config/public`, then `window.__env`, then `/config` when `configEndpoint === true`.
- Auth gate in `main.tsx` plus a root component: skeleton until auth settles, sign-in screen until `isStaff()`, then the router. No per-route guards, same as today.
- TanStack Query for data, because the eagle-public search code depends on it (unverified; confirm in slice 3 and fall back to the admin `useApi` hook if not).
- Vitest and Testing Library for tests. ESLint config copied from eagle-public `react`.
- CSS moves over unchanged: `src/styles.css`, `src/styles/vendor/*`, `unified-search/*.css`, and `scripts/sync-design-css.sh`. Class names in JSX match the Angular templates so no CSS is rewritten.
- Vite dev proxy reproduces `proxy.conf.js`: `/api` with a 350 s timeout, `/notify-api` with path rewrite, targets read from `public/env.js`. Screen routes still avoid those prefixes (`/developers`).
- Drop `proj4` (imported nowhere), `rxjs`, `zone.js`.

`registry-state.service.ts` (1,811 LOC) is split, not ported whole: `api/keycloak.ts`, `api/client.ts`, `api/search.ts`, `api/documents.ts` (with `getDownloadUrl`), `api/me.ts`, `map/layers.ts` (boundary, wildfire, invasive species), and one small context for the signed-in user and filters.

The three copies of the presigned-download code (`unified-search`, `summarizer`, `project-summary`) become one `useDownload()` hook.

## Slices (one PR each, branch off `main`, worktree per slice)

1. **Scaffold and shell.** `frontend-react/` with Vite config, tsconfig, ESLint, Vitest, `public/env.js`, config loader, Keycloak, API client, telemetry and error boundary (`telemetry.service.ts`), shell (`shell/screens.ts`, `prefs.ts`, sign-in, how-built, account menu, nav), all CSS, all redirects from `app.routes.ts` (`/index`, `/content`, `/api-docs`, `/profile`, `''`, `**`). Add a `test-frontend-react` job to `pr.yaml`: lint, test, build.
2. **Simple screens.** sessions, developers, keys, links, rbac, notify, projects picker, workspace. Port `api-keys.service.ts`, `links.service.ts`, `userdata.service.ts`.
3. **Unified search.** Take the React source from eagle-public `react` (`src/app/pages/search/unified-search.tsx`, `src/app/components/display-grid/`), not the Angular port. Use the mapping table in `docs/unified-search-port-plan.md` in reverse to carry back the DEMI-only changes (record detail, saved-query dialog, `search/record-types/*`, which are plain TypeScript and copy over as is).
4. **Project summary and AI summary.** `project-summary.service.ts`, both screens, `useDownload()`.
5. **Map explorer on MapLibre.** Rebuild, not port. Details in the next section. Wire the workspace map preview here.
6. **Cutover.** Delete the Angular app, rename `frontend-react/` to `frontend/`, remove the extra CI job, check `scripts/deploy-azure.sh` (`dist` stays flat, `env.js` assertions unchanged), `scripts/point-env-js.sh`, both deploy workflows. Update `eagle-demi.wiki/Frontend.md` and `docs/unified-search-port-plan.md` status.

## Map slice: Leaflet to MapLibre

Reference is eagle-public `react`: `src/app/map/basemaps.tsx`, `src/app/pages/projects/projlist-map.tsx`, `src/app/pages/project/details-map.tsx`, `src/app/pages/projects/maplibre-test-stub.tsx`, `src/app/state/map-ui.ts`. There is no shared package, so these are copied and adapted. Leaflet, `leaflet.markercluster` and their CSS imports are dropped.

- Packages: `maplibre-gl` ^6, `@vis.gl/react-maplibre` ^8. No draw plugin, no turf.
- Worker: import `maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url` and pass `workerUrl` on every `<Map>`; add `vite/client` to tsconfig `types`. Without it GeoJSON sources never load.
- Load the map screen and the workspace preview with `lazy()`, so the roughly 1 MB of maplibre stays out of the main bundle.
- Basemap: copy `<Basemaps>` and `<MapControls>` (three keyless Esri raster basemaps, empty style, visibility toggle). This also ends the direct use of `tile.openstreetmap.org`, which breaks OSM's tile policy. DEMI gains a basemap switcher; that is the one accepted UI addition.
- Project pins: GeoJSON source with `cluster: true`, invisible hit layer, HTML `<Marker>` buttons refreshed from `querySourceFeatures`, as in `projlist-map.tsx`. Set `clusterRadius` 30 and `clusterMaxZoom` 12 to match today. The selected pin renders last with a higher z-index, replacing the `selected-marker` pane. Keep the `.demi-marker` classes.
- Regions and the three boundary types: one GeoJSON source each, fill and line layers, colours as today, hover and selected state through `setFeatureState` and paint expressions. The Leaflet canvas renderer has no equivalent and is not needed. Keep the three-tier geometry cache and the static-asset-first load.
- Wildfires: same DataBC WFS GeoJSON call, HTML markers sized by `FIRE_STATUS`. Build the popup from text nodes; today it is an unescaped HTML string from a third-party service.
- Invasive species: raster source using the WMS URL with `{bbox-epsg-3857}`, `SLD_BODY` and `CQL_FILTER` in the URL; a species change calls `setTiles`. Sits above the basemap and below boundaries. GetFeatureInfo needs a small lng/lat to EPSG:3857 helper in place of `L.CRS.EPSG3857.project()`; the existing BBOX pixel-math specs port to it. Keep the CQL quoting and the stale-response guard.
- Lasso: pointer events on the map container with `dragPan` off, points through `map.unproject`, preview and committed ring drawn from a GeoJSON source. `/me/lassos` calls unchanged.
- Camera: `flyTo` from a BC-wide view, `easeTo` otherwise, `fitBounds` on boundary and cluster click. These moves always animate. Only never-ending animations, skeleton shimmer and wildfire pulse, honour `prefers-reduced-motion`. Viewport project list from `map.getBounds()` on `moveend`, debounced 150 ms.
- Accessibility follows eagle-public: markers out of the tab order, the project rail stays the keyboard surface, map container is a labelled region.
- Behaviour change to check in review: MapLibre clustering has no spiderfy. Projects that share a centroid need another way to be picked at max zoom; first choice is the selected-project card listing co-located projects.
- Tests: copy `maplibre-test-stub.tsx`, extend the fake map with `setTiles`, `unproject`, `setFeatureState`. Port the behaviours in `map-explorer.component.spec.ts` (924 LOC): selection, camera thresholds, Escape order, lasso save, invasives filter and GetFeatureInfo, lasso-before-map race.
- CSP: check the DEMI frontend route in eagle-edge for a CSP. If one exists it needs `worker-src 'self' blob:` and `server.arcgisonline.com` in `img-src` and `connect-src`, and it can drop the OSM host. Not verified.
- `docs/map-technology.md` recommends OpenLayers for DEMI and is marked Proposed. Update it in this slice: decision is MapLibre, to share code and skills with eagle-public, and fix its stale lines (unpkg script tags, 1.2 MB asset size).

Tests move with each slice. Specs for plain logic (record types, URL state, prefs, config merge) port almost line for line. Component specs are rewritten against rendered output with Testing Library. Each slice must cover the behaviour its Angular specs covered.

## Execution

Each slice is one piece of work on its own branch, with its specs written alongside the code, a separate reviewer on each PR with a two-round cap, and a screen-by-screen visual check against test. Slices 2 to 5 depend only on slice 1 and touch separate folders, so they can run in parallel worktrees once slice 1 merges.

## Parity loop

Reference is the running Angular app, same branch, same API data, Keycloak off. It runs per screen, after the screen's slice builds and its tests pass.

- Harness: one Playwright script serves Angular on one port and React on another, feeds both the same intercepted API fixtures, and captures each screen in each state (loaded, empty, error, open dialogs and menus) at 1440, 1024 and 400 px wide. Angular captures are the reference set.
- Review: a separate reviewer compares the pairs and lists findings. The builder fixes them. The builder never edits the reference captures, the fixtures or the reviewer's checklist.
- A finding is structural when a control, label, column, state or interaction is missing or wrong, geometry is visibly off (order, alignment, wrapping, spacing beyond a few pixels), or keyboard and focus behaviour differs. Structural findings get fixed.
- Accepted without fixing: drift of a few pixels, font rasterisation, scrollbar differences, places where the React behaviour is better. Each one is written to `TODO.md` as an accepted deviation.
- Map screen: judged on layers, controls, interactions and data shown, not on pixels. The basemap, cluster shapes and renderer differ by design. The listed deviations (Esri basemaps, basemap switcher, no spiderfy) are accepted up front.
- Cap: 3 rounds per screen. Exit: a round with zero structural findings. At the cap with structural findings left: stop work on that screen, mark it blocked on the tracker, report the findings, and go back to planning. The cap is never raised mid-loop.
- Review-fix loops on each PR keep their own cap of 2 rounds.

Tracking across the work: this plan lives at `docs/react-conversion-plan.md` and the checklist at `TODO.md`; boxes are ticked only when a screen exits the loop.

## Verification

- Per slice: `yarn lint`, `yarn test`, `yarn build` in `frontend-react/`; `scripts/sync-design-css.sh --check`.
- Local browser check with Keycloak off (`public/env.js`: `configEndpoint=false`, `KEYCLOAK_ENABLED=false`, `API_LOCATION=''`, `API_PATH='/api'`), each ported screen side by side with the Angular build on another port, through the parity harness in `frontend-react/parity/`. Restore `env.js` after.
- Before cutover: a smoke script modelled on `eagle-demi-admin/scripts/e2e-smoke.mjs` that loads all 12 routes and the redirects and checks each `<h1>`. Done: `frontend/scripts/e2e-smoke.mjs`, run against `yarn preview`.
- After cutover merges: staging deploy to test, then real Keycloak login on test, reload to confirm the session holds, one search, one document download, one map lasso, one notify call.
- Prod deploy is out of scope; it follows the normal tagged release.

## Open points

- Size: about 14,000 LOC to port plus 7,500 LOC of specs. Slice 5 is the largest single risk: it changes framework and map library at once, so it gets its own side-by-side browser pass per layer and interaction.
- The unified search port landed in Angular on or after 2026-09-17. Check that work is merged before slice 3 starts, so the React version carries its final behaviour.
