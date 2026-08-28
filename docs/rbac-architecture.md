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

The EAO sharing model (business text 2026-08-28) maps onto the two planes DEMI already has.

| Plane | Question | Mechanism | Carries |
|---|---|---|---|
| Row | which records | `read[]` + `readClause` / `canRead` / `filterFor`; `project:<id>` scope is an OR arm for `team` rows, and a global AND filter only for team-only callers | ladder 1-4 |
| Field | which attributes of a visible record | catalog + dial + one redactor | dials 1-4 |
| Write | may I mutate | `WRITE_ROLES`, unchanged | — |

**One audience scale.** 1 narrowest, 4 widest, on both planes: "this field is public" and "this
record is public" are the same integer. 0 is not a caller level. It is the sealed compartment
below, and the level `systemAccess()` carries for internal jobs. `visible(level, effVis)` in
`src/vis/redact.js` stays the only comparison.

**Ladder (row plane).** `read[]` holds ladder tokens — role types, never ids — cumulative, so a
record at level N carries the tokens of every level ≤ N.

| Level | Name | `read[]` | Matched by | Claim |
|---|---|---|---|---|
| 1 | Team only | `['team']` | `team` AND the row's project in the caller's scope | any `project:<id>` role |
| 2 | All EAO | `+ 'staff'` | `staff` | realm role |
| 3 | All IDIR | `+ 'idir'` | `idir` | `identity_provider` claim |
| 4 | Public | `+ 'public'` | anyone | none |

`rolesFor` (`access-sql.js:76`) injects `team` when the token carries any `project:` role and
`idir` when `identity_provider === 'idir'`. It still strips `project:*` itself: which projects is
the scope plane's job, never `ROLE_LEVELS`.

Project scope is a per-row GRANT, not a global filter. For a caller holding a ladder role above
team (`staff`, `idir`, or a privileged role), a row is visible when `read[]` carries one of the
caller's ladder tokens OR (`read[]` carries `team` AND the row's project is in the caller's scope).
ANDing the scope into every read instead — what `visibilityFor` (`access-sql.js:371`) and `canRead`
(`:391`) do today — drops a staff caller who holds `project:207` to that one project and hides
every other level-2 row. The global scope AND stays only for a caller whose sole ladder membership
is `team`: a proponent-style scoped user with no `staff` and no `idir`.

`isPublished` still mirrors `read.includes('public')`. A record's level is derived, not stored: `levelOfRead(read)` =
widest token present, 1 when none.

**Superuser.** `SECURE_ROLES` (the privileged short-circuit) is `sysadmin`, `demi-admin`,
`demi-service-read`, `demi-service-write`. `staff` is NOT in it — that is what makes level 1 real.
`sysadmin` is superuser on the ladder (levels 1-4) and has no access to level 0. `ADMIN_ROLES` and
`WRITE_ROLES` are unchanged: staff writes and administers exactly as before.

`SECURE_ROLES` and `isPrivileged` carry the ROW-plane short-circuit meaning and nothing else. They
must not also decide who may hold a session. `authMiddleware` (`src/middleware/auth.js:21`) 403s
any caller `isPrivileged` rejects and fronts every write and admin route, so dropping `staff` from
`SECURE_ROLES` on its own would lock staff out of the whole API and keep 403ing a `compliance`-only
credential. `authMiddleware` therefore gates on a separate
`AUTHENTICATED_ROLES = [...new Set([...SECURE_ROLES, ...WRITE_ROLES, 'compliance'])]` — every role
that may hold a session — and the two sets move independently. `SECURE_ROLES` is in that union
because `demi-service-read` is privileged for reads and holds no write role; `WRITE_ROLES` alone
would 403 it. `requireWrite`, `requireAdmin` and `requireRole` stay the
per-route gates behind it.

**Back-compat.** Legacy `read[]` values (`['sysadmin','staff','demi-admin']`, with `'public'` when
published) already contain `staff`, so they read as level 2 — today's meaning. Admin role names in
`read[]` are ignored by `levelOfRead`; they only ever matched callers who short-circuit anyway. No
stored ACL is rewritten. eagle-api's push keeps mirroring EPIC's own `read[]` verbatim
(`resolveProjectAcl`), so pushed records stay level 2 or 4.

**Default on admission is level 1.** Every DEMI-native write site that used to default to
`[...SECURE_ROLES]` writes `readForLevel(1)` instead. Nothing reaches level 2+ by being created.

**Widening is an act.** `PUT /api/{projects,documents}/:id/level` with `{ level, confirm }`,
`requireWrite`, audited as `record.widen` / `record.narrow` through `auditEvent`. Level 4 requires
`confirm: true` and answers 400 without it. Nothing widens automatically — no job, no push, no
merge raises a record's level. A document still cannot out-rank its project; a project's change
cascades to its documents as it does today.

**Field dials refine WITHIN a level.** A dial is an integer 1-4 (0 = never), clamped to
`[0, maxVis]`, else `defaultVis`. **Invariant: a field is never wider than its record** —
`effVis = min(effVis, levelOfRead(doc.read))`, applied in `redactForAccess` where the dial is read,
and validated again by `PATCH /api/projects/:id/visibility` (400 on a dial above the record's
level). Narrowing a record therefore narrows its fields for free; widening a record never widens a
field.

**Level 0 — sealed compartment.** Outside the ladder. Sealed records live in their own container
`sealed`, client-side encrypted with a DEK wrapped by a Key Vault key in `demi-kv-<env>`; the
plaintext never reaches Cosmos, so the data layer holds ciphertext only. `sysadmin` is excluded by
role and by key: the compartment is readable only by `compliance`, and no dial, credential or
widening endpoint reaches it. A record leaves level 0 only through `POST /api/sealed/:id/release`
by `compliance` with `confirm: true`: it is decrypted, written to the ordinary container at level 1
(`read: ['team']`), the sealed row is deleted, and `sealed.release` is audited. There is no path
back in through the sharing interface.

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
    the only place the scalar order is assumed, so switching to a clearance set (Section 3,
    question 1) changes one file plus `levelFromRoles`.
12. **Roles.** `compliance` (grantable, ACL-bearing, `src/controllers/nosql/api-key.js:24`) is
    added to `ROLE_LEVELS`. The 3-role lists named `SECURE_ROLES` in `src/merge/project.js:22` and
    `src/seed/transform.js:16` equal `ADMIN_ROLES` in `access-sql.js:42`, not `SECURE_ROLES`;
    they build stored `read[]`, so they import `ADMIN_ROLES` and are never widened to the 5-role
    list (that would rewrite every ACL). DEMI creates no realm roles of its own: it reuses Eagle's
    (`sysadmin`, `staff`), classification is gated by `requireRole('sysadmin')`, and any level-1/3 role waits on
    EAO question 1. `demi-admin` and `demi-service-*` exist only on API keys.
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

### 2026-08-28b — open questions

1. **Level 1 for non-project records.** The text says "the project team… or the business unit that created the record". DEMI's only team axis is `project:<id>` (the partition key). What is a business unit's identifier, and does a record belong to exactly one? Without an answer, business-unit records can only be admitted at level 2.
2. **Who issues `project:<id>` roles, and for which projects?** Level 1 is unenforceable until every EAO user carries them. Keycloak group mapper, Track project membership, or hand-granted? This blocks P3-3 merging.
3. **Level 0 role holders.** DEMI creates no realm roles. Is the C&E compartment exactly the existing `compliance` role (today only grantable on an API key, `src/controllers/nosql/api-key.js:31`)? If so it must be created as a realm role and granted to named humans — by whom?
4. **Who is "the accountable authority" for a level-0 release**, and does the release need two people, or is one `compliance` credential plus a recorded authority reference enough?
5. **Do external credential parties get Keycloak identities?** First Nations, proponents and local governments must be `user`, `group` or `apikey` parties. If they log in, through which IdP (BCeID? IDIR guest?) — that also decides whether they land on level 3 by accident, since `identity_provider` is the level-3 test.
6. **Credential defaults**: maximum `end` (90 days? one assessment?) and whether an expiring credential needs a notification or simply lapses.
7. **Does a widening need a recorded reason?** The audit row carries actor, time, from and to. If policy needs the authority under which a record was published (an EA process gate, a records decision), it must be a required body field — say so before P3-4 ships, since backfilling it is a schema change.
8. **May a record move DOWN the ladder after level 4?** The code can narrow, and the endpoint allows it today. Business must say whether unpublishing a published record is permitted and by whom.

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

1. **Levels are not one nested ladder that `sysadmin` tops.** §1's table put `sysadmin` at 0 and
   called 0 "Sensitive". Level 0 is a compartment outside the ladder; `sysadmin` is superuser on
   levels 1-4 only. `ROLE_LEVELS` (`src/vis/level.js:10`): `sysadmin: 0 → 1`, `demi-admin: 0 → 1`;
   `staff: 2`, `demi-service-read/write: 2`, `compliance: 2`, `public: 4` unchanged; add `idir: 3`.
   There is no `team` entry — team membership is a row-plane fact resolved per record by
   `scopeClause`/`canRead`, not a role level. `systemAccess()` keeps `level: 0`; it is now the only
   level-0 identity.
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
   `merge/project.js:195` (the last two are `ADMIN_ROLES` aliases, unaffected but re-checked) — or
   newly private rows would lose their `staff` token and read as level 1. `api-key.js:31`
   `GRANTABLE_ROLES` derives from `SECURE_ROLES` and must move to `AUTHENTICATED_ROLES ∪ public`
   or `staff` keys become unmintable. Dropping `staff` from `SECURE_ROLES` is also not enough
   on its own: `authMiddleware` 403s on `isPrivileged`, so the same commit must move that gate to
   `AUTHENTICATED_ROLES = [...new Set([...SECURE_ROLES, ...WRITE_ROLES, 'compliance'])]` (§1,
   Superuser) or staff loses every authenticated route and `demi-service-read` loses the API.
6. **§3 question 1's answer is replaced.** "Nested levels 0-4 with lateral groups inside a level" is
   wrong on both halves. Model in §1.
### Still valid

- §2 items 1, 2, 3, 6, 7, 8, 9, 10, 13, 14 stand as written.
- §2 item 11 stands: `visible()` is the only scalar comparison. The record-level clamp is a
  `Math.min`, not a second comparison.
- Everything shipped in Phases 0-2 stands: catalogs, redactor, `selectFor`, PUT hidden-key guard,
  search drift ratchets, query-param gate, `/api/me`, frontend `visLevel`. Two consequences of
  item 1 above land with P3-2: `selectFor(entity, access)` then returns `'*'` only for
  `systemAccess()`, and the frontend must gate on `level <= 2` rather than on `privileged`, which
  goes false for staff (`frontend/src/app/services/registry-state.service.ts`, P2-5).
- §3 questions 2, 3, 4 stay closed. New questions are in §3 under 2026-08-28b.
