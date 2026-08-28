# Map technology evaluation

Status: Proposed
Date: 2026-08-28

Owns this topic for the workspace. `eagle-public/docs/map-technology.md` covers that
app's own map and links here for the comparison.

## Why this exists

Two apps draw maps: DEMI's map explorer and eagle-public's project list. Both need
more than they do today: many layers at once, user-drawn shapes, and pins. This
page records what we run now, what the options are, and which one to move to.

## What we run today

Both apps use the same setup, and neither installs it as a dependency.

| | DEMI frontend | eagle-public (`react` branch) |
|---|---|---|
| Library | Leaflet 1.9.4 | Leaflet 1.9.4 |
| Clustering | leaflet.markercluster 1.4.1 | leaflet.markercluster 1.5.3 |
| Loaded from | unpkg.com script tags | unpkg.com script tags |
| Typed as | `declare const L: any` | `@types/leaflet` on a CDN global |
| Basemap | OpenStreetMap tiles direct (CARTO light_all in prod) | Esri `server.arcgisonline.com` |
| Polygons | 281 boundaries, Cosmos plus 1.2 MB static GeoJSON | none |
| Drawing | none | none |

Files: `frontend/src/app/components/map-explorer/map-explorer.component.ts` (1,191
lines), `frontend/src/index.html` lines 23-35; eagle-public
`src/app/pages/projects/projlist-map.tsx` (501 lines), `index.html` lines 21-34.

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

## Recommendation

**OpenLayers 10.10.**

The deciding factor is that drawing is part of the library rather than a plugin. The
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

MapLibre stays defensible if developer experience matters more than dependency
count. It has the better React story and an official Angular binding, and Terra Draw
is healthy. It is second, not wrong.

**Do not migrate if the scope stays where it is.** Leaflet plus Geoman-free would
cover 281 polygons, drawing and pins with one added dependency and no rewrite. Move
to OpenLayers when the layer list grows past what we have now or drawing becomes a
real feature rather than a demo. Migrating a working map to render the same 281
polygons is not worth doing on its own.

Avoid Mapbox GL JS v3. It is proprietary and metered: the licence limits use to
Mapbox products and ends when the account lapses, pricing is 50,000 free map loads
then five US dollars per thousand with no cap, the bundle is 487 kB, and the SDK
reports usage data from whatever page it runs on.

## Fix regardless of which library wins

These are problems with how the map is wired, not with Leaflet.

1. **Scripts load from unpkg.com at runtime.** A public service depends on a third
   party CDN staying up. In DEMI the three markercluster and Keycloak tags carry no
   `integrity` hash, so a compromised or swapped file would execute unchallenged.
   Install the packages and bundle them.
2. **DEMI draws basemap tiles from `tile.openstreetmap.org` directly.** The OSM
   Foundation tile usage policy does not allow this for production traffic. Prod uses
   CARTO instead; the demo path should not point at OSM either.
3. **`proj4` and `@types/proj4` are in `frontend/package.json` and nothing imports
   them.** Delete them.
4. **No screen reader can read a map.** Whatever we pick, WCAG 2.2 AA needs a
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
