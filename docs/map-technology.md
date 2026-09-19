# Map technology evaluation

Status: Accepted
Date: 2026-08-28. Decision recorded 2026-09-19.

**Decision: MapLibre GL JS with the `@vis.gl/react-maplibre` binding.** The comparison
below still reads OpenLayers as the better library on its own merits, and that part of
it is unchanged. What settled it was the React line: eagle-public already runs MapLibre
with this binding, so DEMI's new React frontend shares the component shapes, the basemap
definitions and the team's working knowledge instead of keeping a second map stack
alive. One library across both apps is worth more here than OpenLayers' smaller build
and native WMS support.

The trade is that drawing is not in the library. DEMI needs one shape — a freehand
lasso that filters the project list — and that is about a hundred lines of pointer
handling over `map.unproject`, so no drawing dependency was added. If polygon editing,
snapping or measurement ever become real features, revisit this: at that point
Terra Draw or a move to OpenLayers goes back on the table.

Owns this topic for the workspace. `eagle-public/docs/map-technology.md` covers that
app's own map and links here for the comparison.

## Why this exists

Two apps draw maps: DEMI's map explorer and eagle-public's project list. Both need
more than they do today: many layers at once, user-drawn shapes, and pins. This
page records what we run now, what the options are, and which one to move to.

## What we run today

| | DEMI Angular frontend | DEMI React frontend | eagle-public (`react` branch) |
|---|---|---|---|
| Library | Leaflet 1.9.4 | MapLibre GL, bundled | MapLibre GL, bundled |
| Binding | `declare const L: any` | `@vis.gl/react-maplibre` | `@vis.gl/react-maplibre` |
| Loaded from | unpkg.com script tags | the app's own build | the app's own build |
| Clustering | leaflet.markercluster 1.4.1 | GeoJSON source clustering | GeoJSON source clustering |
| Basemap | OpenStreetMap tiles direct (CARTO light_all in prod) | Esri raster, keyless | Esri raster, keyless |
| Boundaries | Cosmos, served as GeoJSON | Cosmos, served as GeoJSON in two detail tiers | none |
| Drawing | freehand lasso | freehand lasso | none |

The Angular map is the line being replaced. Files:
`frontend/src/app/components/map-explorer/map-explorer.component.ts`,
`frontend/src/index.html`; React `frontend-react/src/screens/MapExplorer.tsx` with the
map modules under `frontend-react/src/map/`; eagle-public
`src/app/pages/projects/projlist-map.tsx`.

### Build cost

From `yarn build` in `frontend-react` on 2026-09-19, uncompressed then gzipped:

| Chunk | Size | Gzipped |
|---|---|---|
| `maplibre-gl` | 1,058 kB | 284 kB |
| `maplibre-gl-worker` | 508 kB | fetched as a separate file, not parsed on load |
| the React map binding and the shared map modules | 27 kB | 10 kB |
| `MapExplorer` screen | 40 kB | 14 kB |
| `MiniMap` | 0.8 kB | 0.5 kB |
| `Workspace` screen | 10 kB | 3 kB |

MapLibre is the largest thing the app ships. Nothing loads it until a screen that draws
a map is opened: the map explorer imports it directly, and the workspace's saved-area
preview is a dynamic import, so a workspace with no saved area never fetches it. The
worker is a separate asset served from the app's own origin rather than derived from the
library's module URL, which is why every map passes an explicit `workerUrl`.

### Basemaps

Keyless Esri raster tiles from `server.arcgisonline.com` — World Topographic, Light Gray
and World Imagery — replace direct use of `tile.openstreetmap.org`. The OSM Foundation's
tile usage policy does not allow a production service to draw from their tiles, and the
Angular map did exactly that outside prod. Esri's public tile services need no key and
no account. All three basemaps are added as sources up front and switched with layer
visibility, so changing basemap does not rebuild the style or drop the overlays on it.

### Clustering, and what it cannot do

Clustering is part of the GeoJSON source: MapLibre groups the points and the screen reads
the result back each frame with `querySourceFeatures`, then draws its own HTML markers.
There is no spiderfy. Leaflet's markercluster fans a fully zoomed-in cluster out into a
ring so each pin can be clicked; MapLibre has no equivalent, and projects that share a
centroid exactly stay one unpickable pin however far you zoom.

The screen answers that in the detail card instead. Selecting a project lists the other
projects whose centroid matches it exactly — same longitude and same latitude, compared
as numbers — under "Also at this location", each one a button that selects it. Exact
equality is deliberate: these are records sharing one stored point, not projects that are
merely near each other, and a distance threshold would sweep in neighbours that the map
can already separate.

## Requirements

1. Many layers at once, including polygon data, with per-layer styling and toggling.
2. Users draw shapes: polygon, rectangle, freehand. Edit the vertices. Export GeoJSON.
3. Pins with popups and clustering.

## What we checked

Endpoints probed on 2026-08-28:

- `maps.gov.bc.ca/arcgis/rest/services/province/roads_wm/MapServer` is a cached tile
  pyramid in EPSG:3857 and works as a plain XYZ source. The path is
  `/tile/{z}/{y}/{x}` — row before column, the reverse of the usual template.
- `maps.gov.bc.ca/arcgis/rest/services/base/base/MapServer` is dynamic export only,
  in EPSG:3005 (BC Albers).
- `openmaps.gov.bc.ca/geo/ows` is a GeoServer WMS. It also serves WFS and reprojects
  on request, which is how the wildfire layer already gets EPSG:4326.
- No WMTS and no vector tiles found. `gwc/service/wmts` returns 404 and `SERVICE=WMTS`
  returns an exception report. The published services page lists only WMS, REST and
  KML. Strongly indicated, not exhaustively proven.

So the protocols that matter are ArcGIS REST cached tiles, ArcGIS REST dynamic export,
and WMS. Vector tiles, if we want them, we build and host ourselves.

## Options

All four are free, with no tile lock-in: OpenLayers and Leaflet are BSD-2, MapLibre
BSD-3, deck.gl MIT.

| | OpenLayers 10.10 | MapLibre GL 6.6 | Leaflet 1.9.4 |
|---|---|---|---|
| Last stable release | 2026-07-27 | 2026-08-24 | 2023-05-18 |
| Drawing | in core: `Draw`, `Modify`, `Snap` | Terra Draw 1.32.3 plus adapter | Geoman-free 2.20.0 |
| Rectangle, circle, freehand | yes | yes | yes |
| Snapping | yes | yes | yes |
| Measure area | `ol/sphere.getArea` | `@turf/area` | turf |
| WMS | native | raster template, EPSG:3857 only | native |
| ArcGIS REST dynamic | native | no, needs conversion | `esri-leaflet` plugin |
| EPSG:3005 in browser | yes | no | proj4 plugin |
| Clustering | `ol/source/Cluster`, core | built into the source | markercluster, last released 2021 |
| Renderer | Canvas 2D | WebGL | SVG by default |
| Size, min+gzip | 82 kB tree-shaken | 251-276 kB | 41 kB plus plugins |
| React binding | none, about 30 lines of your own | `react-map-gl` 8.1.2 | `react-leaflet` 5.0.0 |
| Angular binding | none needed, same 30 lines | `@maplibre/ngx-maplibre-gl` 22.1.0 | `@bluehalo/ngx-leaflet` 22.0.0 |

Packages you end up installing:

- OpenLayers: one, `ol`. Drawing, editing, snapping, clustering, WMS, ArcGIS REST,
  reprojection and area measurement are all core modules.
- MapLibre: six — `maplibre-gl`, `react-map-gl`, `terra-draw`, the MapLibre adapter,
  `@turf/area`, `@terraformer/arcgis` — plus a reprojection proxy if we ever need a
  BC Albers dynamic service.

Performance, from Balla and Gede, ICA Abstracts 10:14, 2025: Leaflet and OpenLayers
are fastest up to 10,000 polygons and 50,000 lines; OpenLayers is close to twice as
fast as the rest at 100,000 lines; MapLibre was the slowest of the four at 50,000
polygons. The test measures first paint of static GeoJSON, not pan and zoom
smoothness, so it understates WebGL. At our scale — hundreds of polygons — every
option is fast enough.

## The case for OpenLayers, which did not win

Kept because the reasoning still holds and will matter again if drawing grows.

The deciding factor was that drawing is part of the library rather than a plugin. The
plugin graveyard in this space is crowded: `leaflet-draw` last shipped in 2018 with
467 open issues, the community `maplibre-gl-draw` fork last shipped in 2023,
`leaflet.markercluster` last shipped in 2021, and `@mapbox/mapbox-gl-draw` has had
one real fix in its last ten commits and still has no rectangle, circle, freehand or
snapping. `ol/interaction/Draw` ships and versions with OpenLayers, so that risk
disappears rather than being managed. OpenLayers also speaks every protocol BC Gov
publishes without a plugin, tree-shakes smaller than MapLibre, and is plain
TypeScript, so DEMI's Angular frontend and eagle-public's React frontend can import
the same layer definitions.

The cost is that there is no React binding worth using. That is roughly 30 lines: a
`useRef` div, a `useEffect` that builds `new Map({target})`, and
`map.setTarget(undefined)` to clean up. Angular is the same 30 lines in
`ngAfterViewInit` and `ngOnDestroy`.

What outweighed it: eagle-public had already shipped MapLibre with
`@vis.gl/react-maplibre`, DEMI's new frontend is React too, and the one shape DEMI
draws needs no drawing library at all. Two map stacks cost more than OpenLayers saves.
Go back to this section if editable geometry, snapping or area measurement are asked
for.

Avoid Mapbox GL JS v3. It is proprietary and metered: the licence limits use to
Mapbox products and ends when the account lapses, pricing is 50,000 free map loads
then five US dollars per thousand with no cap, the bundle is 487 kB, and the SDK
reports usage data from whatever page it runs on.

## Wiring problems, and where they stand

1. **Scripts loading from unpkg.com at runtime.** A public service depending on a third
   party CDN staying up, with no `integrity` hash on the markercluster and Keycloak
   tags. Fixed on the React line, which bundles everything it runs from its own build.
   Still true of `frontend/src/index.html` while the Angular map is live.
2. **Basemap tiles drawn from `tile.openstreetmap.org` directly.** Not allowed by the
   OSM Foundation's tile usage policy. Fixed on the React line by the keyless Esri
   raster basemaps above. Still true of the Angular map outside prod, which uses CARTO.
3. **`proj4` and `@types/proj4` are in `frontend/package.json` and nothing imports
   them.** Still true. Delete them.
4. **The Front Door CSP does not allow the Esri tile host.**
   The policy is `var demiCsp` in `digitalspace/eagle-edge`, `azure/main.bicep`. It
   needs `server.arcgisonline.com` in `connect-src`: maplibre-gl 6 reads raster tiles
   with `fetch`, not with `<img>`, so `img-src` needs nothing. The worker is a bundled
   asset served from this origin, so there is no `worker-src` to add and no `blob:`.
   Adding the host costs 33 characters. Front Door rejects a response header over 640
   characters and the policy is at 619, so 12 characters have to come out of the same
   policy first. The DataBC host `openmaps.gov.bc.ca` is already allowed.
5. **No screen reader can read a map.** Whatever we pick, WCAG 2.2 AA needs a
   keyboard-reachable list or table of the same features with the same filters.
   OpenLayers makes that cheap: it draws to Canvas but keeps the feature objects in
   JavaScript, so `source.getFeatures()` feeds the list view directly. Budget it as a
   feature, not a fallback.

## Open questions

- Does EAO hold an ArcGIS Enterprise entitlement? If so `@arcgis/core` becomes an
  option, and it is the only candidate with a published accessibility conformance
  report — though that report covers SDK 4.30 while the current release is 5.1.21,
  the package is 80 MB unpacked, and its Terra Draw adapter is pinned to SDK 4 and
  will not work with 5.
- DataBC publishes no rate limits or terms for high-traffic public sites. Ask them
  before pointing production at their tile cache.
- Where do user-drawn shapes get stored? DEMI has Cosmos NoSQL with spatial indexes
  and `ST_WITHIN`/`ST_INTERSECTS`. eagle-api has only `centroid`, a two-number point.
  Note that both Cosmos and Azure AI Search require counterclockwise winding order —
  a clockwise polygon means the inverse region and returns wrong results silently,
  with no error.
