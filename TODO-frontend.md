# TODO — DEMI frontend

Rules as in `TODO-rbac.md`: append before doing, strike with a reason, date measurements.

- [ ] **Map basemap shows "API KEY REQUIRED" tiles.** `frontend/src/app/components/map-explorer/map-explorer.component.ts:248`
      loads `https://{s}.basemaps.cartocdn.com/light_all/...`; CARTO's free basemaps require an
      API key (seen on test 2026-08-28). Fix: switch the tile layer to a keyless source, e.g.
      OpenStreetMap standard tiles (`https://tile.openstreetmap.org/{z}/{x}/{y}.png`, attribution
      OSM only) or the BC Gov basemap, and update the attribution line at `:249`. No key in the
      frontend bundle either way.
