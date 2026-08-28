# DEMI attribute-level access control

Status: Accepted direction, not started. Source: "DEMI Role-Based Access Control & Field-Level
Redaction" by Mark Lise (Digitalspace), 2026-08-11, revalidated by its author against `42f7436`
on 2026-08-26. Audited here against `aea2a0c` on 2026-08-26. Work items: `TODO-rbac.md`.

Section 1 is the model as accepted. Section 2 is what the audit changed and why. Section 3 lists
questions only the EAO can answer. Section 4 records claims in the source document that were wrong
at `aea2a0c`, so nobody re-verifies them. Section 5 records what the EAO sharing model changes in
sections 1-3.

Reference page: `eagle-demi.wiki/Attribute-Level-Access.md` (level table, catalog format, registered entities, `/api/me`).

## 1. Model

Status: the field plane (catalog, dials engine, redactor, `/api/me`) is live on test. The ladder,
the sealed compartment and Selected Credentials below are the design for Phases 3 and 5; the code
they describe does not exist yet, and `TODO-rbac.md` is the record of what has shipped.

The EAO sharing model (business text 2026-08-28) maps onto the two planes DEMI already has.

| Plane | Question | Mechanism | Carries |
|---|---|---|---|
| Row | which records | `read[]` + `readClause` / `canRead` / `filterFor`; a token's `project:<id>` roles are an OR arm for `team` rows, an API key's `projectScope` is a global AND filter | ladder 1-4 |
| Field | which attributes of a visible record | catalog + dial + one redactor | dials 1-4 |
| Write | may I mutate | `WRITE_ROLES`, unchanged | — |

**One audience scale.** 1 narrowest, 4 widest, on both planes: "this field is public" and "this
record is public" are the same integer. 0 is not a caller level. It is the sealed compartment
below, and the level `systemAccess()` carries for internal jobs. `visible(level, effVis)` in
`src/vis/redact.js` stays the only comparison.

**Ladder (row plane).** `read[]` holds ladder tokens — role types, never ids. It is not cumulative
downwards: a level-2 row carries no `team` token, so a caller whose only ladder membership is
`team` cannot read an All-EAO row of its own project.

| Level | Name | `read[]` | Matched by | Claim |
|---|---|---|---|---|
| 1 | Team only | `['team']` | `team` AND the row's project in the caller's teams | any `project:<id>` role |
| 2 | All EAO | `['staff']` | `staff` | realm role |
| 3 | All IDIR | `['staff','idir']` | `staff` or `idir` | `identity_provider` claim |
| 4 | Public | `['staff','idir','public']` | anyone | none |

Levels 2-4 all carry `staff`, so staff reads every row at level 2 or above with one token. Level 1
rows are reached only through the team arm.

`rolesFor` (`access-sql.js:76`) adds `idir` when `identity_provider === 'idir'`. It never adds
`team`: `team` is a row token only, matched by the team arm (`read[]` carries `team` AND the row's
project is in `access.teams`), never by the caller's role list — a caller token `team` would match
every level-1 row of every project. `project:*` stays stripped; which projects is `teamsFor`'s job.

**Teams grant, key scope restricts.** Two different project facts, and they must not be merged.

`access.teams` holds the project ids from the caller's `project:<id>` realm roles. It is a GRANT
and is used in exactly one place: the team OR arm. A row is visible when `read[]` carries one of
the caller's ladder tokens, OR `read[]` carries `team` and the row's project is in `access.teams`.
A user token carrying `project:` roles is therefore NOT scoped — its tier comes from its other
roles. ANDing team membership into every read instead would drop a staff caller who holds
`project:207` to that one project and hide every other level-2 row.

`access.scope` is the `projectScope` minted onto an API key (`api-key.js:73`). It is a deliberate
RESTRICTION by the key's issuer: a key with `roles: ['staff'], projectScope: ['207']` may read
project 207 and nothing else. It sets `TIER.SCOPED` and is ANDed into every read by `scopeClause`
(`access-sql.js:317`) and `canRead` (`:391`), exactly as today; none of that changes.

`projectScopeFor` (`:168`) splits along that line: `teamsFor(req)` reads the realm `project:` roles
into `access.teams`, and `projectScopeFor` keeps only the explicit key `projectScope`.

`isPublished` still mirrors `read.includes('public')`. A record's level is derived, not stored: `levelOfRead(read)` =
widest token present, 1 when none.

**Superuser.** `SECURE_ROLES` (the privileged short-circuit) is `sysadmin`, `demi-admin`,
`demi-service-read`, `demi-service-write`. `staff` is NOT in it — that is what makes level 1 real.
`sysadmin` is superuser on the ladder (levels 1-4) and has no access to level 0. `ADMIN_ROLES` and
`WRITE_ROLES` are unchanged: staff writes and administers exactly as before.

`SECURE_ROLES` and `isPrivileged` carry the ROW-plane short-circuit meaning and nothing else. They
must not also decide who may hold a session. `authMiddleware` (`src/middleware/auth.js:21`) 403s
any caller `isPrivileged` rejects and fronts every write and admin route, so dropping `staff` from
`SECURE_ROLES` on its own would lock staff out of the whole API. `authMiddleware` therefore gates
on a separate `AUTHENTICATED_ROLES = [...new Set([...SECURE_ROLES, ...WRITE_ROLES])]` — the
ladder's staff and service roles — and the two sets move independently. `SECURE_ROLES` is in that
union because `demi-service-read` is privileged for reads and holds no write role. `compliance` is
NOT in it: four routes sit behind `authMiddleware` with no second gate (`/db/stats`,
`/admin/index-progress`, `/search/summary`, `/links`), and a compartment credential has no business
there. The sealed routes (§1 Level 0) mount their own chain, `authenticate` then
`requireRole('compliance')`, and never pass through `authMiddleware`. `requireWrite`,
`requireAdmin` and `requireRole` stay the per-route gates behind it.

**Back-compat.** Legacy `read[]` values (`['sysadmin','staff','demi-admin']`, with `'public'` when
published) already contain `staff`, so they read as level 2 — today's meaning. Admin role names in
`read[]` are ignored by `levelOfRead`; they only ever matched callers who short-circuit anyway. No
stored ACL is rewritten. eagle-api's push keeps mirroring EPIC's own `read[]` verbatim
(`resolveProjectAcl`), so pushed records stay level 2 or 4.

**Default on admission is level 1.** Every DEMI-native write site that used to default to
`[...SECURE_ROLES]` writes `readForLevel(1)` instead. Nothing reaches level 2+ by being created.

**Widening is an act.** `PUT /api/{projects,documents}/:id/level` with `{ level, confirm, reason }`,
`requireWrite`, audited as `record.widen` / `record.narrow` through `auditEvent`. Level 4 requires
`confirm: true` and answers 400 without it. Level 4 and a level-0 release also require a `reason`
body field and answer 400 without it; on every other move `reason` is optional, because the audit
row already carries actor, time, from and to. Nothing widens automatically — no job, no push, no
merge raises a record's level. A document still cannot out-rank its project; a project's change
cascades to its documents as it does today.

Pulling a record BACK from level 4 is `sysadmin` only, always audited as `record.takedown`, and is
incident response — an error or a privacy breach, never a routine correction, which publishes a
replacement instead. A takedown is not finished when the row narrows: `docs/takedown-runbook.md`
covers purging the AI Search index, cleaning up chunks, invalidating caches, and the fact that
copies already outside EPIC are unrecoverable.

**Field dials are independent of the record level.** A dial is an integer 1-4 (0 = never),
clamped to `[0, maxVis]`, invalid → `defaultVis`. The row plane decides who may see a record, so a
caller who passes it is a permitted audience and the field plane only refines by the caller's own
level. Capping a field at the record's level would blank every field for a level-2 staff member
reading a level-1 team row, and for every credential holder.

**Level 0 — sealed compartment.** Outside the ladder, but on the same row plane as every other
level: a sealed record carries `read: ['compliance']` (`readForLevel(0)`) and stays in its ordinary
container. Only the `compliance` role matches that token. No new store, no separate ACL mechanism.

The privileged short-circuit must EXCLUDE these rows. `readClause`, `canRead` and `filterFor` add
`NOT ARRAY_CONTAINS(c.read, 'compliance')` — `not read/any(r: r eq 'compliance')` in OData — for
every caller that does not itself hold `compliance`, including the privileged ones (`isPrivileged`:
`sysadmin`, `demi-admin`, `demi-service-read`, `demi-service-write`), whose predicate otherwise
collapses to `true`. `systemAccess()` holds no `compliance` role and carries the same exclusion, so
exports, seed and reconcile never read a sealed row.

Sealing is an application-layer guarantee. Cosmos data-plane operators, backups and the
`ADMIN_API_KEY` break-glass sit outside it, so the seal is real only under two conditions:

1. The `ADMIN_API_KEY` break-glass must not resolve the `compliance` role.
2. Exports and backups stay locked down.

Encryption is a later hardening, not part of this design: per-record envelope encryption is
optional Phase 5b in `TODO-rbac.md`, taken only when the compartment holds real C&E material.

A record leaves level 0 only through `POST /api/sealed/:id/release`. One `compliance` holder is
enough; the body must carry `caseNumber` and `decision` (400 without either). The release rewrites
`read[]` to `readForLevel(1)`, writes `auditEvent('sealed.release')` with the case number and
decision, and notifies the C&E lead. Notification path: TBD — ACS Email is EPIC's send path, but
this repo has no mailer. Two-person release is a later policy toggle. Nothing enters level 0 through
the widening endpoint; `PUT /:id/level` 400s on level 0.

**Selected Credentials.** A credential grants a named party sight of specified records at levels
1-3 without changing any record's level and without changing anyone else's access. Stored in
container `credentials`, partition `/party.id`:
`{ id, party: { type: 'user'|'group'|'apikey', id }, scope: { type: 'document'|'project', ids[] },
levels: [1..3], start, end, grantedBy, grantedAt, revokedAt, batchId, note }`.
Loaded once per request by party (`sub`, a `groups` entry, or `req.user.keyId`), expired and
revoked rows filtered in JS. Evaluated as one extra OR arm in `readClause`, `canRead` and
`filterFor`: `id ∈ scope.ids AND read[] carries one of levels`. `levels` reuses the ladder tokens,
so no new SQL. Grant, revoke and bulk revoke (by `batchId`, party or project) go through
`auditEvent`. Credentials never touch the field plane — the holder's own level still governs which
attributes they see — and level 4 needs none.

The party is a person logging in through BCeID (Business, which ties the credential to the
organisation) or a registry API key; IDIR guest only for an external acting as staff. BCeID is not
`idir`, so a credential holder never reaches level 3 by logging in. `end` is required and enforced
on the GRANT, not on the login — 90 days by default. A grant is also revoked by state change: when
the project closes or the engagement's work completes, from the same Track feed that mints team
roles. EA windows routinely run past 90 days, so renewal is the norm and the grantor is notified
7 days before expiry.

**Fail closed.** Unknown role → level 4. No ladder token → the record reads as level 1. Missing
`access.level` → 4. Uncatalogued field removed. Unknown entity throws. Dial out of range →
`defaultVis`.

**Identity.** Keycloak now, Entra later; role names are the contract, the issuer only changes the
claim path in `rolesFor` and `src/helpers/auth.js`. DEMI creates no realm roles of its own.

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
   `defaultVis: 2`. Lead and EPD names and emails, and the records-management identifiers
   `orcsClassification` and `edrmsRecordNumber`, stay at 4: public by policy (Section 3,
   question 2, 2026-08-28).
4. **Level 0 runs the same loop.** No `if (level === 0) return record`. `catalogFor(entity)` is
   called first so an unknown entity throws for every caller. This only holds because predicates
   widen rather than gate (Section 1): with the source semantics (predicate ANDed with level) a
   false `cacPublished` would hide `cacEmail` from level 0, and the identity property would need
   a bypass branch. After P3-2 no caller is level 0 — only `systemAccess()` carries it (§5 item 3) —
   so `maxVis: 0` fields reach no response. Until P3-2 ships, `sysadmin` is level 0 and does see them.
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
   content writer publish `cacEmail` without `sysadmin`. Until Phase 3 gates that field, the
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
    the only place the scalar order is assumed. Question 1 is answered (§5); a later switch to a
    clearance set would change one file plus `levelFromRoles`.
12. **Roles.** `compliance` (grantable, ACL-bearing, `src/controllers/nosql/api-key.js:24`) is
    added to `ROLE_LEVELS`. The 3-role lists named `SECURE_ROLES` in `src/merge/project.js:22` and
    `src/seed/transform.js:16` equal `ADMIN_ROLES` in `access-sql.js:42`, not `SECURE_ROLES`;
    they build stored `read[]`, so they import `ADMIN_ROLES` and are never widened to the 5-role
    list (that would rewrite every ACL). DEMI creates no realm roles of its own: it reuses Eagle's
    (`sysadmin`, `staff`), classification is gated by `requireRole('sysadmin')`, level 3 is the
    `idir` claim and level 1 the team arm (§1). `demi-admin` and `demi-service-*` exist only on API keys.
13. **Dropped.** `visLevelCap` on API keys (keys already carry roles and scope), a separate
    `audits` container (`auditEvent` exists), `GET /api/vis-catalog` (no admin UI yet), golden
    fixture files (a regenerated golden proves nothing). `/api/me` is kept but is its own change.
14. **Every new endpoint updates `src/swagger/swagger.yaml` in the same PR.**

## 3. Questions for the EAO

1. Answered 2026-08-28: the EAO sharing model — ladder 1-4 on the row plane, level 0 a sealed
   compartment, Selected Credentials a time-bound lane. Model in §1, deltas in §5.
2. Answered 2026-08-28 (Daniel): project lead and EPD names and emails are public, because
   `eagle-public` already shows them. They stay `defaultVis: 4`; no exception list.
3. Dropped 2026-08-28: `forMAEE` is a column of the source spreadsheet that nothing in DEMI
   reads. No catalog entry derives from it.
4. Moot 2026-08-28: `project_tracking_number` (`trackProjectId`) and `epic_guid` (`eagleId`) are
   in today's anonymous response and catalogued `4/4`. They stay public.

### 2026-08-28b

9. Closed 2026-08-28 (Daniel): a project must exist before any record does, so every record
   has a team. `documents` already partitions on `/projectId`; no business-unit axis is needed.
10. Answered 2026-08-28: from Track. A project's team is the union of staff across its works
    (`staff_work_roles` joined to `works`); a feed mints the existing `project:<id>` realm roles.
    Lead-managed lists are a manual override, not the system of record. Unit P3-0.
11. Answered 2026-08-28: the compartment is exactly the existing `compliance` role
    (`src/controllers/nosql/api-key.js:31`), created as a realm role and granted to named humans
    behind the C&E lead.
12. Answered 2026-08-28: one `compliance` holder is enough, provided the release records a case
    number and a decision in the same action and the C&E lead is notified. Two-person release is a
    later policy toggle, not a schema change.
13. Answered 2026-08-28: yes, people through BCeID enabled as an IdP on `eao-epic` — BCeID
    Business for proponents and consultants, which ties the credential to the organisation. IDIR
    guest only for an external acting as staff. Systems use the existing registry API keys (roles +
    `projectScope` + level cap). BCeID is not `idir`, so a BCeID party never lands on level 3 by
    accident.
14. Answered 2026-08-28: `end` is required and defaults to 90 days, enforced on the grant and not
    on the login. The grant is also auto-revoked when the project closes or the engagement's work
    completes. EA windows routinely exceed 90 days, so renewal is the norm and the grantor is
    notified 7 days before expiry.
15. Answered 2026-08-28: required for any widening to level 4 and for every level-0 release
    (which also carries the case number). Optional on every other move; the audit row already
    carries actor, time, from and to.
16. Answered 2026-08-28: yes, but `sysadmin` only, always audited, and framed as incident response
    (error or privacy breach). A routine correction publishes a replacement instead. Pulling back
    from level 4 needs `docs/takedown-runbook.md` (unit P3-9): purge the AI Search index, clean up
    chunks, invalidate caches, and state that copies outside EPIC are unrecoverable.

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

## 5. Changes 2026-08-28 from the EAO sharing model

The business text (levels 1-4 ladder, level 0 compartment, Selected Credentials) supersedes parts
of §1-§3. Phases 0-2 are live on test; nothing shipped is withdrawn.

### Superseded

1. **Levels are not one nested ladder that `sysadmin` tops.** The first draft of §1 (2026-08-28,
   superseded the same day) put `sysadmin` at 0 and called 0 "Sensitive". Level 0 is a compartment outside the ladder; `sysadmin` is superuser on
   levels 1-4 only. `ROLE_LEVELS` (`src/vis/level.js:10`): `sysadmin: 0 → 1`, `demi-admin: 0 → 1`;
   `staff: 2`, `demi-service-read/write: 2`, `compliance: 2`, `public: 4` unchanged; add `idir: 3`.
   There is no `team` entry — team membership is a row-plane fact resolved per record by the team
   arm in `readClause`/`canRead`, not a role level. `systemAccess()` keeps `level: 0` on the FIELD
   plane and is the only caller that carries it; the ROW plane's level 0 is the `compliance`
   token, which `systemAccess()` does not hold (§1).
2. **"Group (compartment)" and dial values of shape `{ level, groups }` are deleted.** The EAO
   "Special: Selected Credentials" lane is not a tag on a field — it is a time-bound grant to a
   named party over named records, on the ROW plane. See §1 and Phase 3 unit P3-6. Dials stay
   integers; `src/vis/groups.js` is never created.
3. **§2 item 4, "level 0 sees every field", stops holding at P3-2.** `sysadmin` is level 0 today
   and does see `maxVis: 0` fields. After P3-2 moves it to level 1 no caller is level 0, so
   `maxVis: 0` means what it says: `read`, `ownRead`, `vis`, `s3Key`, `sources` and the Cosmos
   bookkeeping fields are visible to nobody through a response, `sysadmin` included. The redactor
   loop is unchanged — still no `if (level === 0) return record`, still one comparison. The U9 and
   P2-1 deviation notes ("level 0 sees `s3Key`/`read`/`sources.track`") describe today and become
   void at P3-2.
4. **§2 item 5 is narrowed, not dropped.** `read[]` still carries no FIELD levels (`demi-vis-*`
   stays dead). It does now carry the four ladder tokens `team|staff|idir|public`, which is the row
   plane it always encoded. The reason item 5 gave — `readClause` short-circuits for
   `SECURE_ROLES`, of which `staff` was a member — is fixed rather than worked around: `staff`
   leaves `SECURE_ROLES` (`src/helpers/access-sql.js:32`).
5. **§2 item 12's role note.** `SECURE_ROLES` drops `staff` and becomes
   `['sysadmin','demi-admin','demi-service-read','demi-service-write']`. `ADMIN_ROLES` (`:44`) and
   `WRITE_ROLES` (`:58`) are untouched: staff's write and admin rights do not move. Every write
   site that spelled an ACL as `[...SECURE_ROLES]` must convert to `readForLevel()` in the same
   commit — every `grep -rn SECURE_ROLES src/` hit that builds a `read[]`: `document.js:47,364,380,
   635,852`, `project.js:124,227`, `boundary.js:32`, `seed/transform.js:36,202`,
   `merge/project.js:195` (the last two are `ADMIN_ROLES` aliases, unaffected but re-checked) — each
   to the level it means today, unpublished `readForLevel(2)` and published `readForLevel(4)`, or
   newly private rows would lose their `staff` token and read as level 1. `api-key.js:31`
   `GRANTABLE_ROLES` derives from `SECURE_ROLES` and must move to `AUTHENTICATED_ROLES ∪ {compliance, public}`
   or `staff` keys become unmintable. Dropping `staff` from `SECURE_ROLES` is also not enough
   on its own: `authMiddleware` 403s on `isPrivileged`, so the same commit must move that gate to
   `AUTHENTICATED_ROLES = [...new Set([...SECURE_ROLES, ...WRITE_ROLES])]` (§1, Superuser) or staff
   loses every authenticated route and `demi-service-read` loses the API.
6. **§3 question 1's answer is replaced.** "Nested levels 0-4 with lateral groups inside a level" is
   wrong on both halves. Model in §1.
### Still valid

- §2 items 1, 2, 3, 6, 7, 8, 9, 10, 13, 14 stand as written.
- §2 item 11 stands: `visible()` is the only scalar comparison.
- Everything shipped in Phases 0-2 stands: catalogs, redactor, `selectFor`, PUT hidden-key guard,
  search drift ratchets, query-param gate, `/api/me`, frontend `visLevel`. Two consequences of
  item 1 above land with P3-2: `selectFor(entity, access)` then returns `'*'` only for
  `systemAccess()`, and the frontend must gate on `level <= 2` rather than on `privileged`, which
  goes false for staff (`frontend/src/app/services/registry-state.service.ts`, P2-5).
- §3 questions 2, 3, 4 stay closed. Questions 9-16 (§3, 2026-08-28b) are answered.
