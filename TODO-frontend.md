# TODO — DEMI frontend

Rules as in `TODO-rbac.md`: append before doing, strike with a reason, date measurements.

- [x] **Map basemap shows "API KEY REQUIRED" tiles.** The Angular map loaded CARTO `light_all`,
      which needs a key (seen on test 2026-08-28). Done in the React app: `frontend/src/map/basemaps.tsx`
      uses keyless Esri ArcGIS Online tiles, each with its own attribution, and ships no key.
