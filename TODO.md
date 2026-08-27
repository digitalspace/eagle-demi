# TODO

DEMI serves prod search since 2026-08-26 (`SEARCH_API_PATH=/demi-search`); eagle-search retired
2026-08-27. Unscheduled ideas: `docs/FUTURE.md`. History: `git log`, wiki.

Rules: append newly found work here before doing it; strike a wrong line with why; pin every
claim to a measurement with a date; reviewer takes a positional sha (`review.sh --repo eagle-demi
<sha>`); prod deploys only from a tag verified on test.

## Facts — verified 2026-08-26/27 unless dated otherwise

1. **Prod estate** (`rg-demi-prod`): `demi-cosmos-prod`, `demi-api-prod` (B3 on
   `plan-eagle-search-prod`), `demi-search-prod` (`chunks`/`projects`/`documents` only, semantic
   `free`). Corpus 393 projects / 61,587 documents / 1,128,576 chunks (measured 2026-08-26), same
   on test and prod.
2. **Prod search**: `SEARCH_API_PATH=/demi-search` since 2026-08-26; `eagle-search` retired
   2026-08-27 (`/eagle-search` now a 502 sentinel). Kill switch: set the field to `''`. Recipe:
   `docs/prod-flip-runbook.md`.
3. **Direction**: DEMI is EPIC's central store, Track id is master; eagle-api pushes writes to DEMI
   with a `demi-service-write` key (`demi-push-secret`, `6cdc9e-prod`).
4. **Budgets**: absolute ceiling `epic-ceiling` 50,000 CAD/year at management group `c4b0a8`
   (dev/test/tools/prod); per-RG monthly guards 400 CAD (`demi-budget-test`, `demi-budget-prod`).
   Notify only.
5. **ABAC** (`c4b0a8`): `roleAssignments/write`/`/delete` denied only for six role GUIDs; other
   grants are open to any principal holding it.
6. **Access**: `az` needs interactive login (tokens revoke without warning). `oc` prod reads via
   `github-cicd` SA, never write through it. Search/Cosmos are private-endpoint only — index PUTs
   run in-container over an SSH tunnel.

## 1. Credentials

- [ ] **1.1 Rotate the object-store keys and the OpenShift token at source — other owners.**
      Handoff: (a) `nrs.objectstore.gov.bc.ca` access/secret keys: dev + test share secret
      `eagle-api-minio-keys` (`6cdc9e-dev` 2020-11-24, `6cdc9e-test` 2021-02-25, never rotated; bucket
      `asnpnn`), prod uses `nr-object-store-credential` (bucket `ozwdez`). Rotation = NRS object-store
      owners issue new keys → update those secrets → `oc rollout restart deploy/eagle-api` per ns →
      rerun `scripts/deploy-infra.sh <env> --live` for DEMI (its `MINIO_*` app settings come from the
      same secrets). (b) `OPENSHIFT_TOKEN` repo secrets (eagle-api, eagle-public, eao-nginx) are the
      `github-cicd` SA token from `6cdc9e-tools` — reissue via `oc create token`/secret, paste into
      the three repos. Nothing in DEMI blocks on this.
- [x] ~~Rotate `RPROXY_EGUIDE_PASSWORD`; Eagle push key~~ done: not rotated 2026-08-26 (business-issued password; `TYPESENSE_SEARCH_KEY` deleted); push key issued 2026-08-27 in `demi-push-secret`.
- [ ] **Reissue the TEST push key `b319b93a1bf35206`** on the `demi-service-write` role — it still
      holds `demi-admin`.

## 2. Decisions — Daniel

- [x] ~~Anonymous surface, `proponentId`, Keycloak client~~ done 2026-08-26: PR #162 (`d676664`); `proponentId` moot (eagle-public search UI never reads it); prod demi-api reuses `eagle-admin-console`.
- [x] ~~eagle-edge prod home, CORS~~ done 2026-08-26: `og-eagle-backend` + `api-passthrough` codified in eagle-edge; `main.prod.bicepparam` same-origin via rproxy, fail closed.

## 3. Small, do opportunistically

- [x] ~~#162 minors, review minors, `_sql.fetchAll` `maxItemCount`~~ done in PR #169 (`2136e39`).
- [x] ~~`projects.js:128` filters on `centroid` without an index path~~ done 2026-08-27 (test + prod infra applied).
- [ ] **Watch the first scheduled prod reconcile run (2026-08-27 10:00 UTC).** `reconcileEagle`
      (Functions timer, `RECONCILE_SCHEDULE` `0 0 10 * * *`, prod only) is deployed and registered;
      one prior manual run read `drift=0` on `demi-api-prod`. Check `demi-logs-prod`:
      `AppTraces | where Message contains "[reconcile] projects"`. One line a night with `drift=0`
      is clean; no line means the timer never fired, and nothing else alerts on that. Alert on
      `drift>0`: `demi-reconcile-drift-prod`.
- [x] ~~Unused Cosmos index paths; eao-nginx `values-prod.yaml` stale prose~~ done 2026-08-27: `infra-38f2905-*` dropped unused paths on `projects`/`documents`/`boundaries`/`wildfires`; PR #45/#47 (comments only).
- [ ] **eagle-api doesn't serve `CONTENT_SEARCH` in `/api/config` yet** (whitelist in
      `api/helpers/models/config.js` + `api/controllers/config.js`) — needed before the Document
      Content tab can ever be turned on.

## 4. Prod promotion — done 2026-08-26/27

- [x] ~~Stand up prod estate, copy the corpus, ship app code~~ done 2026-08-26: `deploy-infra.sh prod --live`; corpus 393 / 61,587 / 1,128,576 both sides; zipdeploy `main` `ef4379f`.
- [x] ~~eao-nginx + eagle-public prod tags~~ done: eao-nginx `v2.7.17` (demi block) then `v2.7.18` (post-soak cleanup); eagle-public `v2.7.31`.
- [x] ~~Observability, cost sign-off~~ done: webtest `demi-search-availability-prod`; budgets signed off 2026-08-26, see Facts §4.
- [x] ~~Flip and soak~~ done: flipped 2026-08-26 21:30 UTC, soak closed same day.
- [x] ~~Retire eagle-search~~ done 2026-08-27: eagle-search estate deleted (API, search service, PE, monitoring, `eagle-*` indexes, sync/reindex jobs); kept `plan-eagle-search-prod` + `eagle-search-identity-prod`.

## 5. OpenShift retirement — Daniel says when (costs nothing)

- [x] ~~eagle-public dev/test pods, DEMI OpenShift stack~~ spun down 2026-08-26 (scale, not delete; worker cronjob suspended).

## 6. Standing rules — do not re-derive

- **Probe that can't fail proves nothing**: take a BEFORE reading, use nonsense-term fallback
  checks, synthetic ACL rows (`src/scripts/probe-acl.js`).
- **Index-change order is fixed** (`azure/search/README.md`): index PUT → datasource PUT →
  backfill → indexer reset/run → app last.
- **`appSettings` is a whole-collection PUT**; `demi-app-secrets` (OpenShift) is the credential
  source of truth.
- **Demi is deliberately stricter than eagle-search was** (unknown params 400, `pageSize>500`
  refused, `read[]` withheld, keywordless chunk search = 0) — do not loosen.
- **Decided, do not redo**: helmet CSP off; rate limiter proven; facets over the filtered set;
  filter values stay List ObjectIds; no `projectIsPublished` denorm; no adapter layer.

## Out of scope

`rg-epic-search` shares the billing group, not the ownership. `rg-condition-extractor-prod` is
not ours.
