# Future ideas

Not scheduled. Added 2026-08-26.

- **Track pulls must keep `ea_certificate`.** The 2026-08-31 refresh of `src/data/track_projects_enriched.json` added it (342 of 382 records); a regenerated export must select it again or the field goes empty. The column holds certificate state as well as numbers ("Withdrawn", "In progress") and DEMI stores it verbatim.
- **One place for API keys, roles and permissions.** Today: keys minted by `POST /admin/api-keys`
  (registry, `GRANTABLE_ROLES`, `projectScope`, 90-day expiry), roles from Keycloak realm roles,
  `project:<id>` roles for scope, `SECURE_ROLES`/`WRITE_ROLES` hardcoded in `helpers/access-sql.js`.
  Field-level roles and levels are designed in `docs/rbac-architecture.md` (work in `TODO-rbac.md`).
  No UI, no single view of who holds what; eagle-api has its own separate `INTERNAL_API_KEY`
  mechanism that skips scope checks. Target: one admin surface (likely in the demo frontend's
  auth-guarded area) listing keys, roles, scopes, expiry, last use; revoke; mint.
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
- **Key manager / rotator.** Today rotation is a hand sequence across holders that nothing
  records together: `ADMIN_API_KEY` lives in OpenShift `demi-app-secrets` (source of truth),
  the App Service setting, and the GPU box env file; the Eagle push key in `demi-push-secret`;
  eagle-api's `SMOKE_API_KEY`; MinIO and OpenShift tokens rotate at their issuers. The 2026-08-25
  rotation showed the failure modes: a holder skipped is a silent revert on the next infra
  deploy, App Service needs stop/start before the new value serves, and single-key auth means a
  window. Target: one place that knows every credential, its holders, age and expiry (registry
  keys already carry `expiresAt`), can mint the next value, write it to every holder in the safe
  order, verify with a real call, and alert before expiry. Dual-key acceptance (`*_NEXT`) on the
  readers would remove the window. Same admin surface as the API-key/role manager above.
- **Stop re-logging in (`az`, `oc`).** `oc`: dev/test already use ServiceAccount tokens in the
  kube contexts (`eagle-automation`, no expiry); only prod still needs Daniel's own login, by
  choice. `az`: a user login cannot be auto-renewed — `AADSTS50173` is the tenant revoking the
  refresh token under its sign-in-frequency/MFA policy, and nothing scripted can answer MFA.
  Fix = a non-human identity for this box: a service principal (client secret or certificate)
  with the same RG roles as today's user, `az login --service-principal` from a shell hook or a
  systemd timer that re-logs before expiry. Candidate: app registration `acb4198f…` (already has
  a GitHub federated credential; a secret can be added) if the landing zone permits, else a new
  one. Caveats: ABAC/role assignment writes need a human; the SP must never get prod write
  without a separate decision; secret lifetime ≤ 2 years and belongs in the key manager above.
- **Serve eagle-public's project reads.** Today the public site reads from two backends. Its
  `AZURE_DATASETS` set (`eagle-public/src/app/api/api.ts:44`, React rewrite; the Angular equivalent
  is `services/api.ts`) sends `Project`, `Document` and `DocumentChunk` searches to
  `SEARCH_API_PATH`, so the project list and map, the project-list table, site search, content
  search, featured documents and the Documents / Application / Certificate / Amendment tabs are all
  DEMI. Everything else is eagle-api: `GET /api/project/:id` (the detail record plus
  `commentPeriodForBanner`), `GET /api/project/:id/pin`, `GET /api/commentperiod?project=`,
  `GET /api/search?dataset=RecentActivity`, `GET /api/search?dataset=List`, and the document
  download URL `/api/public/document/:id/download/...` (hardcoded in the frontend in two places,
  not routed through its `apiPath()` helper). Target: DEMI serves the project page outright, so a
  project the list shows always opens.

  Three things block it.

  1. *Transport.* rproxy exposes exactly one DEMI URL — `location = /demi-search/search`, an exact
     match, `eao-nginx/conf.d/server.conf.tmpl:244`. That is a security control, not an oversight:
     a prefix match publishes this API's whole route table anonymously on a gov.bc.ca origin,
     `/api-docs` and `/documents/:id/download` included. Do not widen it. The block goes away when
     `demi.eao.gov.bc.ca` resolves (BC Gov DNS request outstanding) and `SEARCH_API_PATH` becomes an
     absolute URL the browser calls directly; until then the site's CSP `connect-src 'self'
     https://*.gov.bc.ca` also rejects `demi-api-*.azurewebsites.net`.
  2. *Missing data.* No comment periods, no pins, no recent activities, no organization records
     exist here. Pins arrive on the Eagle push but survive only inside `sources.eagle`, which the
     field catalog strips from every response at every level (`src/vis/catalog/projects.js:85`).
  3. *Missing key.* `GET /projects/:id` takes the DEMI id — the Track id, or `eagle-<objectid>` for
     an Eagle-only project — not the Eagle `_id` the site holds. The only Eagle-keyed path is
     `/search?dataset=Project&and[_id]=`, aliased onto `legacyEagleId`.

  Even inside the one allowed URL a search-only detail page does not work: `and[_id]=` takes the AI
  Search branch, which omits `location` (`src/controllers/search.js:410-412` — the Cosmos branch
  reads `row.address`, the index has no such column). It also carries none of `legislation`,
  `build` (the page derives "Nature" from it), `CEAAInvolvement`, `CEAALink`,
  `applicableRegulation`, `operational`, `projectCAC`, `cacEmail` or `commentPeriodForBanner`.

  Order of work: DNS and the absolute `SEARCH_API_PATH` first, since nothing else is reachable
  without it; then the DEMI side — an Eagle-`_id` project lookup, the missing project fields, and
  comment-period, pin and activity records with their read endpoints; then the frontend swap, one
  call at a time behind `SEARCH_API_PATH` so each can be reverted on its own. Document downloads
  are separable and cheap: `GET /documents/:id/download` already returns a presigned URL and needs
  only the transport, no new data. It presigns against eagle-api's MinIO while
  `STORAGE_BACKEND=minio` (the default), so it brokers the bytes rather than owning them.

  Two response-shape traps: `GET /projects` returns stored Cosmos names (`projectState`, `address`,
  `proponentName`) while `/search?dataset=Project` returns eagle-shaped ones (`status`, `location`,
  `proponent.name`), and the two search branches disagree with each other over `location`,
  `sources` and `highlighted`. Anything the frontend consumes needs one agreed shape first.

  Until this lands, the two corpora drift: test's DEMI corpus was seeded from prod, so its project
  list names projects the test eagle-api has never held and those pages 404. Remedy is
  `.claude/scripts/epic-backfill-projects.py --missing` in the workspace root, which copies the
  gap across; the frontend renders a "Project not found" page rather than an alert.
