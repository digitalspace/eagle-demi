# TODO — attribute-level access control

**Goal: every field of every entity classified and redacted per caller level, per
`docs/rbac-architecture.md`.** `TODO.md` (prod cutover) retired 2026-08-27 (#198); this is the only open tracker.
Same rules: append work here before doing it, strike wrong lines with a reason, date every
measurement. **Merging is deploying** on test, so each phase must leave anonymous responses
byte-identical unless a line below says otherwise.

## Facts — verified 2026-08-26 at `aea2a0c`

1. Anonymous `GET /api/projects` on test returns `projectLead`, `projectLeadEmail`,
   `responsibleEPDEmail`, `eaoMember`, `cacEmail`. `eagle-public` renders the same fields
   anonymously from eagle-api, so this is current product behaviour, not a DEMI regression.
   Whether it is policy is EAO question 2.
2. `DEMI_ALLOWED_CLIENTS` is set in no bicep or bicepparam; `applyClientAllowlist` is a no-op
   when empty. JWT `aud` is not validated (`src/helpers/auth.js:210`).
3. `demi-admin`, `demi-service-read` exist only in DEMI constants, not in realm `eao-epic`.
4. `upsertFromEagle` and `seed-nosql.js:403` replace whole items; only `sources` is carried.

## Phase 0 — decisions and token hardening (no behaviour change for valid callers)

- [ ] Ask EAO the four questions in `docs/rbac-architecture.md` section 3. Owner: Daniel. Record
      answers in that doc, not here.
- [ ] `aud` validation in `src/helpers/auth.js` `jwt.verify` options; expected audience per
      issuer in config.
- [ ] `DEMI_ALLOWED_CLIENTS` app setting in `azure/modules/api-web-app.bicep` and both
      bicepparams; unlisted `azp` rejected with 401; allowlist required in test and prod (startup
      fails when unset). Same PR as the code.
- [ ] Demote arm, if kept for dev: strip every role except `public`.
- [ ] `ADMIN_API_KEY`: Key Vault reference in bicep instead of plain app setting; rotation owner
      named in `docs/prod-flip-runbook.md` or wiki.
- [ ] Remove duplicate `SECURE_ROLES` in `src/merge/project.js:22`; import from `access-sql.js`.
- [ ] Wiki: ADR for the field plane (Status: Accepted; Context, Decision, Consequences), linking
      the doc. ADR-010 (ADR-009 is Track Feed).

## Phase 1 — level plumbing and projects redaction (anonymous output unchanged)

- [ ] `src/vis/level.js`: `ROLE_LEVELS` incl. `compliance`; `levelFromRoles`.
- [ ] `resolveAccess` and `systemAccess` return `level`.
- [ ] `src/vis/catalog/projects.js` authored from `mergeTrackProject`, `mergeEagleOnlyProject`
      output. Every field `eagle-public` renders today at `defaultVis: 4`; `complianceLead`,
      `execProjectDirector` at 2; `read`, `vis`, `sources` at `maxVis: 0`; `_etag` at 2;
      `sources.wildfire` dotted key at 4 (still gated by `ENRICHMENT_SOURCES`).
- [ ] `src/vis/redact.js`: `redactForAccess`, `redactAllForAccess`, `visible(level, effVis)`
      as the single comparison; level 0 runs the loop; `catalogFor` first; dial engine reads
      `record.vis`; `effVis = clamp(dial) ?? (predicate ? maxVis : defaultVis)` (doc section 1);
      `isPublished` derived from `read`.
- [ ] `selectFor(entity, access)` in `_sql.js`: list reads project only catalog fields with
      `maxVis >= level` plus row-plane fields; level 0 projects `*`.
- [ ] Tripwire also covers error and log paths in controllers (raw docs flow through them now).
- [ ] EAO sign-off on the Phase 1 exception list (`projectLeadEmail`, `responsibleEPDEmail`,
      `cacEmail` to `defaultVis: 2`). Without sign-off they stay at 4.
- [ ] Replace `publicView` at its five sites (`src/controllers/nosql/project.js:91,107,171,251,336`)
      and `src/controllers/search.js:431` with the redactor on the repository row. Delete
      `publicView`.
- [ ] PUT `/projects/:id` returns 400 on any body key the caller cannot see, and on `vis`.
- [ ] Tests: `test/vis/catalog-completeness.test.js` (catalog == emitter keys, every `when`
      resolves, no upstream field named `vis`); `test/vis/redact-matrix.test.js`; extend
      `test/helpers/access-coverage.test.js` to scan `src/controllers/**` per `res.json` call
      site; tripwire integration test on anonymous `GET /api/projects/:id` and `/api/search`.
- [ ] `search-diff.js` run before and after on test: 0 new DIFF. Date it here.
- [ ] `src/swagger/swagger.yaml`: no new endpoints this phase; note 400 on PUT.

## Phase 2 — documents, search parity, frontend

- [ ] `src/vis/catalog/documents.js` from `transformDocument`; `s3Key` at `maxVis: 0`.
- [ ] Redactor at every document and chunk-metadata `res.json`.
- [ ] Index-name catalog for AI Search hits; `test/vis/search-drift.test.js` over
      `src/search/ai-search.js` select strings and `azure/search/indexes/*.json` `retrievable`;
      chunks enforced by the `select` string.
- [ ] Query params: filter and sort only on catalog fields visible at the caller's level; test
      that `buildCriteria` and `eagle-query.js` alias map are subsets of `maxVis` 4 fields.
- [ ] `GET /api/me` returning `{ roles, level, tier }`; swagger.
- [ ] Frontend: `visLevel` signal from `/api/me` replaces the role check in
      `registry-state.service.ts:757`; optional model fields; presence-based templates.
- [ ] Wiki: reference page for the catalog format and the level table.

## Phase 3 — per-record dials (blocked on EAO question 1)

- [ ] Realm roles `demi-vis-0..3`, `demi-classify` in `eao-epic`: external dependency, owner and
      date here before any code references them. `demi-service-write` (ADR-007) first.
- [ ] Carry `vis` forward in `upsertFromEagle` and `seed-nosql.js` beside `sources`; test.
- [ ] `PATCH /api/projects/:id/visibility`: `authMiddleware` + `requireWrite` +
      `requireRole('demi-classify')`; Cosmos patch; 400 on uncatalogued field or out-of-range
      level; `auditEvent` before acknowledging; swagger.
- [ ] Gate `projectCACPublished` behind `demi-classify`, then ship the `cacPublished` predicate.
- [ ] Index `vis` as a non-searchable retrievable JSON string; mappers parse it; reindex.
- [ ] If EAO answers lateral: replace `visible()` and `levelFromRoles` with set membership
      before any dial is written.

## Phase 4 — content plane and Entra

- [ ] `src/vis/catalog/chunks.js`; decide document-level classification for chunk content.
- [ ] `src/ai/summarize.js` documented as chunk-content only; no change unless it grows.
- [ ] Exports and dumps under `systemAccess()` named as level-0 material in the runbook, with
      deletion step for `/home` on `demi-api-*`.
- [ ] Entra: app roles with the same names; `auth.js` selects `{ issuer, jwks, audience }` from
      `iss` before verification; `rolesFor` reads `roles` claim; MSAL replaces CDN `keycloak-js`
      and the `fetch` monkey-patch (`registry-state.service.ts:602-628`); remove Keycloak issuer
      last.

## Parked

- `visLevelCap` on API keys, `GET /api/vis-catalog`, golden fixtures: dropped, see doc section 2
  item 13. Revisit only with a named consumer.
