# DEMI attribute-level access control

Status: Accepted direction, not started. Source: "DEMI Role-Based Access Control & Field-Level
Redaction" by Mark Lise (Digitalspace), 2026-08-11, revalidated by its author against `42f7436`
on 2026-08-26. Audited here against `aea2a0c` on 2026-08-26. Work items: `TODO-rbac.md`.

Section 1 is the model as accepted. Section 2 is what the audit changed and why. Section 3 lists
questions only the EAO can answer. Section 4 records claims in the source document that were wrong
at `aea2a0c`, so nobody re-verifies them.

## 1. Model

Three planes. Two exist and stay as they are; one is new.

| Plane | Question | Mechanism | Status |
|---|---|---|---|
| Row visibility | which records | `read[]` + `readClause` / `canRead` / OData `filterFor` | unchanged |
| Project scope | which partitions | `project:<id>` roles, `scopeClause` | unchanged |
| Field visibility | which attributes of a visible record | level 0-4, field catalog, one redactor | new |
| Write rights | can I mutate | `WRITE_ROLES` | unchanged |

**Level.** Every caller gets one integer from their roles: 0 most privileged, 3 least privileged
EAO group, 4 anonymous public. Derived in `src/vis/level.js` from a `ROLE_LEVELS` map. Unknown
role gives 4. Roles are the portable contract; the IdP (Keycloak today, Entra later) only changes
the claim path in `rolesFor()`.

**Catalog.** Every field of every entity is classified in code under `src/vis/catalog/<entity>.js`
with `defaultVis` and `maxVis`. `maxVis` is the ceiling a field may ever reach. The catalog is
security policy: reviewed in diffs, tested as data, never read from Cosmos.

**Dial.** A record may carry a sparse `vis` map (`{ eacExpires: 3 }`). Effective visibility is the
dial clamped to `[0, maxVis]`, else `defaultVis`. Dials may restrict below `defaultVis`. Invalid
dial falls back to `defaultVis`. Dials ship in Phase 3; the engine that reads them ships in Phase 1.

**Predicate.** Named pure functions `(record) => boolean` in `src/vis/predicates.js`,
referenced by name from the catalog (`when: 'cacPublished'`). When no dial is set, a true predicate lifts the
field's baseline from `defaultVis` to `maxVis`; false or missing leaves it at `defaultVis`. A set dial
overrides the predicate either way, so a project dialled to 0 stays hidden while its CAC is published.
So `cacEmail: { defaultVis: 2, maxVis: 4, when: 'cacPublished' }` is always visible at level 2
and below, and public only while the CAC is published. Predicates never narrow; conditional restriction is the dial's job.

**Core rule.** Per field, per record: `effVis = clamp(dial) ?? (predicate true ? maxVis : defaultVis)`;
`visible = level <= effVis`. A set dial always wins; a predicate only moves the absent-dial baseline. Only passing fields appear in the response.

**Fail closed.** Unknown role gives level 4. Missing `access.level` is treated as 4. Field not in
catalog is removed. Unknown entity throws. Unknown or throwing predicate hides the field. Dial out
of range clamps toward restriction. A merged field without a catalog entry fails CI.

**Write side.** Content writes stay `WRITE_ROLES`. Changing a dial needs a separate role
`demi-classify`, goes through one endpoint `PATCH /api/projects/:id/visibility`, is validated
(400 on uncatalogued field or out-of-range level) and audited through the existing
`src/utils/audit.js` `auditEvent`. Ordinary POST and PUT strip `vis` from bodies.

**Tests.** Four ratchets: coverage (every entity response site redacts), completeness (every field
the merge and seed emit is in the catalog), search drift (index `select` lists and `retrievable`
flags are a subset of catalog fields with `maxVis` 4), and a tripwire integration test asserting
anonymous responses never contain named restricted fields.

**Frontend.** `GET /api/me` returns `{ roles, level, tier }` from `resolveAccess`. One template per
screen; sections render on field presence, never on role.

**Identity.** Keycloak roles first. Entra later: app roles with the same names, second issuer in
`src/helpers/auth.js` selected atomically as `{ issuer, jwks, audience }` from the token's `iss`
before signature verification. The access model does not change.

## 2. Corrections to the source design

Each item below overrides the corresponding section of the source document.

1. **Redactor sits at the response boundary, not inside `getById`.** Eight controller paths read
   with the caller's access and spread the result back into an upsert
   (`src/controllers/nosql/project.js:180,213`; `document.js:320,337,373`;
   `boundary.js:129,150,178,194`). A redacting `getById` would erase every hidden field on the
   first edit by a level 1-4 caller. Cosmos upsert replaces the item. Repositories return raw
   documents. `redactForAccess(entity, doc, access)` is called at every `res.json` of an entity
   and on the repository row before each search mapper. This is the placement `publicView` already
   uses and for the same reason (`src/repositories/projects.js:142`). The coverage ratchet scans
   `src/controllers/**` per call site, not per file. Redaction-safe update then needs only one
   rule: PUT returns 400 on any body key the caller cannot see. Two things survive from the
   source design's repository placement: list reads still use a catalog-derived `select`
   (`selectFor(entity, access)`, fields with `maxVis >= level` plus row-plane fields) so
   never-visible values do not leave Cosmos, and the tripwire test also covers controller error
   and log paths, since raw documents now pass through them.
2. **Catalog is authored from the merged document, not from the Track CSV.** Source of truth for
   field names is what `mergeTrackProject`, `mergeEagleOnlyProject` (`src/merge/project.js`) and
   `transformDocument` (`src/seed/transform.js`) emit. 15 fields in the source catalog do not exist
   on a stored project (`type`, `subType`, `latitude`, `longitude`, `eaCertificate`, `eacSigned`,
   `isProjectClosed`, `epicGuid`, `eacExpires`, `capitalInvestment`, `ftePositionsConstruction`,
   `ftePositionsOperation`, `createdBy`, `updatedBy`, `sourcesWildfire`). Real names are
   `projectType`, `projectSubType`, `centroid`, `sources.wildfire`. About 25 real merged fields are
   missing (`eaStatus`, `eacDecision`, `decisionDate`, `currentPhaseName`, `phaseHistory`,
   `legislation`, `legislationYear`, `review180Start`, `review45Start`, `reviewExtensions`,
   `reviewSuspensions`, `substitution`, `CEAAInvolvement`, `eaoMember`, `sector`, `commodity`,
   `fedElecDist`, `provElecDist`, `projectCAC`, `projectCACPublished`, `overallProgress`, `code`,
   `nameSearchTerms`, `regionalDistrict`, `municipality`, `electoralDistrict`).
   The completeness test diffs the catalog against the emitters, so the list above is enforced,
   not maintained by hand. Catalog keys may be dotted one level (`sources.wildfire`) and the
   redactor descends only for listed dotted keys.
3. **Day-one defaults reproduce today's public output.** Every field `eagle-public` renders
   anonymously today gets `defaultVis: 4`. That includes `projectLead`, `projectLeadEmail`,
   `responsibleEPD`, `responsibleEPDEmail`, `eaoMember`, `cacEmail`, `projectCAC`,
   `projectCACPublished` (`eagle-public/src/app/services/api.ts:274-318`). The source catalog gave
   `name`, `description`, `centroid`, `proponentName`, `region`, `projectState` `defaultVis: 2`,
   which would have left an anonymous project response with five identifier fields. Fields
   `eagle-public` does not request today: `complianceLead`, `execProjectDirector`. Those start at
   `defaultVis: 2`. One exception list may ship in Phase 1 as a deliberate tightening:
   `projectLeadEmail`, `responsibleEPDEmail`, `cacEmail` to `defaultVis: 2`, only after the EAO
   signs it off (Section 3, question 2). Without sign-off they stay at 4. On documents the same
   mechanism holds `orcsClassification` and `edrmsRecordNumber` at 4: they are records-management
   identifiers rather than content, and are the document-side candidates for `defaultVis: 2` under
   that same sign-off.
4. **Level 0 runs the same loop.** No `if (level === 0) return record`. `catalogFor(entity)` is
   called first so an unknown entity throws for every caller. This only holds because predicates
   widen rather than gate (Section 1): with the source semantics (predicate ANDed with level) a
   false `cacPublished` would hide `cacEmail` from level 0, and the identity property would need
   a bypass branch. Level 0 sees every field because `0 <= effVis` for every field.
5. **`read[]` does not carry levels.** The source design put `demi-vis-*` into `read[]` for
   whole-record restriction. `readClause` and `canRead` return `true` for any `SECURE_ROLES`
   holder before reading `read[]` (`src/helpers/access-sql.js:235,373`), `staff` is in
   `SECURE_ROLES`, membership has no ordering, and `read[]` is rebuilt from `isPublished` at eight
   write sites. Rows stay `read[]` plus scope. Whole-record level rules, if ever needed, become a
   catalog rule, not ACL vocabulary.
6. **Dials survive upserts.** `upsertFromEagle` (`src/controllers/nosql/project.js:277-286`)
   and `seed-nosql.js:403` replace the whole item and carry only `sources` forward. `vis` is
   carried forward beside `sources` in both, with a test, in the same change that adds the dial
   engine.
7. **Predicates read only fields ordinary writes cannot set.** `projectCACPublished` is a plain
   content field any `WRITE_ROLES` caller sets through PUT, so `when: 'cacPublished'` would let a
   content writer publish `cacEmail` without `demi-classify`. Until Phase 3 gates that field, the
   predicate is not shipped. Predicates take `(record)` only.
8. **`read`, `s3Key`, `vis` are `maxVis: 0`; `_etag` is `maxVis: 2`.** `publicView` strips
   `read` on purpose and the document controller strips `s3Key`. `isPublished` is derived in the
   redactor from `read.includes('public')`. Exposing the `vis` map at level 2 would reveal which
   fields were restricted below 2. `_etag` stays visible to every writer (all `WRITE_ROLES` map to
   level 2 or lower) because optimistic concurrency needs the client to send it back.
9. **Search redacts the repository row, then maps.** Search mappers emit eagle-search wire names
   (`_id`, `proponent.name`, `location`, `status`), so running the catalog redactor over mapped
   output would delete the row. AI Search hits get a second catalog keyed on index field names.
   For chunks the enforcement point is the `select` string in `src/search/ai-search.js`, not
   `retrievable` (semantic ranking needs `content` retrievable).
10. **Token hardening is Phase 0 and includes deployment.** `isAllowedClient`
    (`src/helpers/auth.js`) refuses a verified token whose `azp` is not in `DEMI_ALLOWED_CLIENTS`
    with 401 — one behaviour, no demoted identity — and an empty list is permissive, which is why
    `src/config.js` refuses to run outside dev and local without one.
11. **The level comparison lives in one function.** `visible(level, effVis)` in `redact.js` is
    the only place the scalar order is assumed, so switching to a clearance set (Section 3,
    question 1) changes one file plus `levelFromRoles`.
12. **Roles.** `compliance` (grantable, ACL-bearing, `src/controllers/nosql/api-key.js:24`) is
    added to `ROLE_LEVELS`. The 3-role lists named `SECURE_ROLES` in `src/merge/project.js:22` and
    `src/seed/transform.js:16` equal `ADMIN_ROLES` in `access-sql.js:42`, not `SECURE_ROLES`;
    they build stored `read[]`, so they import `ADMIN_ROLES` and are never widened to the 5-role
    list (that would rewrite every ACL). `demi-vis-0..3` and
    `demi-classify` are realm roles DEMI does not own; creating them in `eao-epic` is an external
    dependency with a named owner. `demi-service-write` (wiki `ADR-007-Service-to-Service-Credentials`) lands before `demi-classify`.
13. **Dropped.** `visLevelCap` on API keys (keys already carry roles and scope), a separate
    `audits` container (`auditEvent` exists), `GET /api/vis-catalog` (no admin UI yet), golden
    fixture files (a regenerated golden proves nothing). `/api/me` is kept but is its own change.
14. **Every new endpoint updates `src/swagger/swagger.yaml` in the same PR.**

## 3. Questions for the EAO

1. Are the four internal groups nested (each a superset of the next) or lateral? The only
   existing model in the workspace is Track's `Membership` enum (`EPD`, `LEAD`, `ANALYST`,
   `FNCAIRT`, `OTHER`; `epictrack-api/src/api/utils/roles.py:29-38`), which is lateral with
   orthogonal capability roles. If lateral, the scalar level becomes a clearance set (correction
   11). Decide before dials or `demi-vis-*` role names exist anywhere.
2. Are project lead and EPD names and emails public by policy? `eagle-public` shows them to
   anonymous visitors today; the EAO field inventory marks them internal. One of the two is wrong.
3. Should `forMAEE = Y` in the field inventory imply `maxVis >= 3`?
4. Which of the inventory's `???` cells (`project_tracking_number`, `epic_guid` ceiling) get a
   value? Until answered they sit at the most restrictive plausible value.

## 4. Source-document claims that were wrong at `aea2a0c`

- `EAGLE_ONLY_FIELDS` has 31 entries, not 29 (`src/merge/project.js:48-57`).
- `src/helpers/response.js` is not dead: `serverError` is imported by six controllers.
- `res.json` sites: 108 total, 62 non-error, not about 45.
- No email-intake upload route exists; the only upload route is `POST /documents/extract`.
- `publicView` has a fifth call site (`src/controllers/nosql/project.js:336`); at
  `src/controllers/search.js:431` it filters only the `sources` sub-object of a hand-built row.
- `ENRICHMENT_SOURCES` is empty in prod, so `sources.wildfire` is a test-only value.
- `rolesFor` has no `|| user.roles` fallback today.
- PUT already accepts arbitrary body keys; POST already drops them (`project.js:115-118,191-196`).
- `export-chunks-to-eagle.js` pushes a four-field projection by default; `SELECT *` only under
  `--dump`, which writes to the App Service `/home` filesystem, not to a storage account.
- `src/ai/summarize.js` consumes chunk `content` only, never a project or document row.
- No AI Search index has any staff, email, or `sources` field retrievable or searchable.
- ADR-004 is `eagle-demi.wiki/ADR-004-Read-ACL-Authorization-Model.md`.
- `boundaries.js` was deliberately removed from the coverage test's `UNGATED` list; `config.js` is
  in it.
