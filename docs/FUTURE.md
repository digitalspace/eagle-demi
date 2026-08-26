# Future ideas

Not scheduled. Kept out of `TODO.md` so open work stays short. Added 2026-08-26.

- **One place for API keys, roles and permissions.** Today: keys minted by `POST /admin/api-keys`
  (registry, `GRANTABLE_ROLES`, `projectScope`, 90-day expiry), roles from Keycloak realm roles,
  `project:<id>` roles for scope, `SECURE_ROLES`/`WRITE_ROLES` hardcoded in `helpers/access-sql.js`.
  No UI, no single view of who holds what; eagle-api has its own separate `INTERNAL_API_KEY`
  mechanism that skips scope checks. Target: one admin surface (likely in the demo frontend's
  auth-guarded area) listing keys, roles, scopes, expiry, last use; revoke; mint. Precondition:
  a `demi-service-write` role so machine writers stop holding `demi-admin`.
- **One engine for data sources with visible syncs.** Today each source is bespoke: Track static
  file + `merge/project.js`, Eagle via seed (`seed-nosql.js`, on demand) and push (`/eagle/*`
  routes), wildfire via `sync-wildfires.js` (manual POST). No registry of sources, no last-run /
  row-count / error surface, no schedule. Target: a `sources` registry (name, kind, schedule, last
  run, counts, errors) + one runner that the existing scripts plug into, exposed on `/admin`.
  Supersedes the 2026-08-24 "no adapter layer" call once a second real source exists; until then
  the wiki `Sources-and-Status` contract stands.
- **Geo syncs as their own managed group.** Wildfire (DataBC WFS → `wildfires` + `sources.wildfire`),
  boundaries (checked-in GeoJSON → `boundaries`), the map's live DataBC layer. Same engine as
  above, geo-flavoured: bbox/centroid validation, `[lon, lat]` invariant, staleness shown on `/map`
  (`lastCalculatedAt` already rendered). Test-only until prod wants any enrichment.
