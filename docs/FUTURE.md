# Future ideas

Not scheduled. Added 2026-08-26.

- **The Track mapper must keep `ea_certificate`.** `trackApiToExtract` (`src/seed/sources.js`) names every column DEMI takes off the live feed, so a column dropped there empties that field on every record. `ea_certificate` is the one to watch: 342 of the 382 rows in the 2026-08-31 export carried a value, and the column holds certificate state as well as numbers ("Withdrawn", "In progress"), which DEMI stores verbatim.
- **One place for API keys, roles and permissions.** Today: keys minted by `POST /admin/api-keys`
  (registry, `GRANTABLE_ROLES`, `projectScope`, 90-day expiry), roles from Keycloak realm roles,
  `project:<id>` roles for scope, `SECURE_ROLES`/`WRITE_ROLES` hardcoded in `helpers/access-sql.js`.
  Field-level roles and levels are designed in `docs/rbac-architecture.md` (work in `TODO-rbac.md`).
  No UI, no single view of who holds what; eagle-api has its own separate `INTERNAL_API_KEY`
  mechanism that skips scope checks. Target: one admin surface (likely in the demo frontend's
  auth-guarded area) listing keys, roles, scopes, expiry, last use; revoke; mint.
- **One engine for data sources with visible syncs.** Today each source is bespoke: Track nightly
  over its API (`sync-track-projects.js`) + `merge/project.js`, Eagle via seed (`seed-nosql.js`, on
  demand) and push (`/eagle/*` routes), wildfire via `sync-wildfires.js` (manual POST). No registry
  of sources, no last-run /
  row-count / error surface, no schedule. Target: a `sources` registry (name, kind, schedule, last
  run, counts, errors) + one runner that the existing scripts plug into, exposed on `/admin`.
  Supersedes the 2026-08-24 "no adapter layer" call once a second real source exists; until then
  the wiki `Sources-and-Status` contract stands.
- **Geo syncs as their own managed group.** Wildfire (DataBC WFS → `wildfires` + `sources.wildfire`),
  boundaries (checked-in GeoJSON → `boundaries`), the map's live DataBC layer. Same engine as
  above, geo-flavoured: bbox/centroid validation, `[lon, lat]` invariant, staleness shown on `/map`
  (`lastCalculatedAt` already rendered). Test-only until prod wants any enrichment.
- **Key Vault as credential truth.** Today OpenShift `demi-app-secrets` / `demi-keycloak-admin` feed
  Key Vault through `deploy-infra.sh` (ARM writes), because human logins hold no Key Vault data-plane
  role (`demi-kv-prod` answers Forbidden). Target: Secrets Officer for the operators, secrets born in
  Key Vault, scripts read Key Vault first. Folds into the key manager below.
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
- **Finish the project read shapes.** Both eagle-public lines now read every public record from
  DEMI (wiki ADR-011), and the project page is built from `GET /projects/:id`, which also takes an
  Eagle `_id`. What is still open:

  1. The AI Search branch of `/search?dataset=Project` (any keyword or `and[_id]=` query) has no
     `location`, `legislation`, `build`, `CEAAInvolvement`, `CEAALink`, `applicableRegulation`,
     `projectCAC` or `cacEmail`: none is a column of the `projects` index. A consumer
     that builds a detail view from search gets less than one built from `GET /projects/:id`.
  2. `GET /projects` returns stored Cosmos names (`projectState`, `address`, `proponentName`) while
     `/search?dataset=Project` returns Eagle-shaped ones (`status`, `location`, `proponent.name`),
     and the two search branches disagree over `location`, `sources` and `highlighted`.
  3. The Cosmos branch of `/search?dataset=Project` maps each row to a fixed field list, so the
     staff-only project fields (catalog level 2) reach staff through `GET /projects/:id` only.
