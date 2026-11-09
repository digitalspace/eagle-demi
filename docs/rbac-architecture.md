# DEMI attribute-level access control

Status: Accepted. Source: "DEMI Role-Based Access Control & Field-Level Redaction" by Mark Lise
(Digitalspace), checked by its author against `42f7436`. Audited here against `aea2a0c`.

Section 1 is the model as accepted. Section 2 is what the audit changed and why. Section 3 lists
questions only the EAO can answer. Section 4 records claims in the source document that were wrong
at `aea2a0c`, so nobody re-verifies them. Section 5 records what the EAO sharing model changes in
sections 1-3.

Reference page: `eagle-demi.wiki/Attribute-Level-Access.md` (level table, catalog format, registered entities, `/api/me`).

## 1. Model

Status: the field plane (catalog, dials engine, redactor, `/api/me`), the ladder, the sealed
compartment and Selected Credentials below are built. Entra as a second token issuer is open. It
needs an Entra app registration from the identity team, with the app roles in
`docs/entra-app-roles.json`, and then a dual-issuer `src/helpers/auth.js`.

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

`rolesFor` (`src/helpers/access-sql.js`) adds `idir` when `identity_provider === 'idir'`. It never
adds `team`, a row token matched only by the team arm: `read[]` carries `team` AND the row's
project is in `access.teams`. A caller token `team` would match every level-1 row of every
project, so `project:*` stays stripped and `teamsFor` resolves the projects.

**Teams grant, key scope restricts.** Two different project facts, and they must not be merged.

`access.teams` holds the project ids from the caller's `project:<id>` realm roles. It is a GRANT
and is used in exactly one place: the team OR arm. A row is visible when `read[]` carries one of
the caller's ladder tokens, OR `read[]` carries `team` and the row's project is in `access.teams`.
A user token carrying `project:` roles is therefore NOT scoped — its tier comes from its other
roles. ANDing team membership into every read instead would drop a staff caller who holds
`project:207` to that one project and hide every other level-2 row.

`access.scope` is the `projectScope` minted onto an API key (`src/controllers/nosql/api-key.js`).
It is a deliberate RESTRICTION by the key's issuer: a key with `roles: ['staff'], projectScope:
['207']` may read project 207 and nothing else. It sets `TIER.SCOPED`, and `scopeClause` and
`canRead` (`src/helpers/access-sql.js`) AND it into every read.

`projectScopeFor` splits along that line: `teamsFor(req)` reads the realm `project:` roles
into `access.teams`, and `projectScopeFor` keeps only the explicit key `projectScope`.

`isPublished` still mirrors `read.includes('public')`. A record's level is derived, not stored: `levelOfRead(read)` =
widest token present, 1 when none.

**Superuser.** `SECURE_ROLES` (the privileged short-circuit) is `sysadmin`, `demi-admin`,
`demi-service-read`, `demi-service-write`. `staff` is NOT in it — that is what makes level 1 real.
`sysadmin` is superuser on the ladder (levels 1-4) and has no access to level 0. `ADMIN_ROLES` and
`WRITE_ROLES` are unchanged: staff writes and administers exactly as before.

`SECURE_ROLES` and `isPrivileged` carry the ROW-plane short-circuit meaning and nothing else, so
they do not decide who may hold a session. The `authMiddleware` gate (`src/middleware/auth.js`)
fronts every write and admin route and checks `AUTHENTICATED_ROLES`, the union of `SECURE_ROLES`
and `WRITE_ROLES`. The union includes `SECURE_ROLES` because `demi-service-read` is privileged for
reads and holds no write role.

`compliance` is NOT in `AUTHENTICATED_ROLES`. Four routes sit behind `authMiddleware` with no
second gate (`/db/stats`, `/admin/index-progress`, `/search/summary`, `/links`), and a compartment
credential has no business there. The sealed routes (§1 Level 0) mount their own chain,
`authenticate` then `requireRole('compliance')`, and never pass through `authMiddleware`.

`requireWrite`, `requireAdmin` and `requireRole` are the per-route gates behind `authMiddleware`.

**Back-compat.** Legacy `read[]` values (`['sysadmin','staff','demi-admin']`, with `'public'` when
published) contain `staff`, so they read as level 2 and no stored ACL is rewritten. The
`levelOfRead` helper ignores admin role names in `read[]`, which only match callers who
short-circuit anyway.

The eagle-api push mirrors EPIC's own `read[]` minus the `compliance` token (`eagleBaseAcl`). A
record's own read lands at level 1, 2 or 4, and at level 2 when Eagle sent no `read[]`. A
compliance-only or empty record lands at `['sysadmin']`, never at the project team.

Updates differ (`ownRead` and `inheritsParentRead` in `src/helpers/update-parent.js`). An Update
takes its parent's ceiling when:

- it has a status other than `archived`, and its `read` is missing or `[]`
- it has no status, its `read` is missing, and it is `active: true`

Otherwise it is stored as `[]`.

A child is capped by its parent's ceiling (`capRead`; for Updates `capIfLower`), so it lands no
higher than that. A child under a DEMI-sealed parent is stored sealed by its push.

A parent sealed by an Eagle push (level 0, no `sealedAt`) is no ceiling for an Update. The
`ceilingRead` helper uses that parent's Eagle read minus compliance instead, so the Update can land
at level 2 or 4 under a stored level-0 parent.

A comment period or document under a `ProjectNotification` keeps its own `eagleBaseAcl` read
uncapped (`comment-period.js`, `document.js`). An Update under a notification is capped by it.

A row DEMI sealed (`POST /sealed` stamps `sealedAt`) stays sealed until released. A row sealed by a
push has no `sealedAt`, and its next push derives it again from Eagle's read and the parent.

**Eagle reads are stored as Eagle sent them.** The eagle-api `$redact` stage matches `read[]`
tokens to roles literally, so Eagle shows `['sysadmin']` or `['sysadmin','inspector']` rows to
those roles only, and DEMI does the same. A pushed record stores Eagle's own read (`eagleBaseAcl`
in `helpers/eagle-acl.js`).

An empty Eagle `read[]` is stored as `['sysadmin']`, since Eagle shows it to no one, and only a
missing one lands at level 2. Under a parent, the push stores that read capped by the parent
(`eagleReadUnder`, which is `capRead`). The cap never lets in a caller the parent keeps out.

A read with no ladder token, such as `['sysadmin','inspector']`, keeps its privileged names plus
the names the parent also carries, or all of them under a public parent. It never becomes
`['team']`. So an inspection under a public project stores `['sysadmin','inspector']`, and under a
staff or team project `['sysadmin']`.

A ladder read under a parent with no ladder token keeps only the parent's privileged names. A read
left with no names becomes `['sysadmin']`, never `[]`. Updates follow the same cap (`readUnder` in
`helpers/update-parent.js`), except that an empty Update read stays `[]`.

A document's `ownRead` is Eagle's base read, so `read` and `ownRead` differ only by the parent cap.
The `--reverse` mode of `src/scripts/backfill-eagle-ladder.js` strips a `staff` token Eagle never
sent; see the README section "Eagle read ladder backfill".

**Default on admission is level 1.** Every DEMI-native write site that used to default to
`[...SECURE_ROLES]` writes `readForLevel(1)` instead. Nothing reaches level 2+ by being created.

**Widening is an act.** The route `PUT /api/{projects,documents}/:id/level` takes
`{ level, confirm, reason }` behind `requireWrite` and is audited as `record.widen` /
`record.narrow` through `auditEvent`. Level 4 needs `confirm: true`, and level 4 and a level-0
release need a `reason`; each answers 400 without it.

On every other move `reason` is optional, because the audit row carries actor, time, from and to.
Nothing else widens automatically: no job or merge raises a record's level, and an Eagle push
stores the read Eagle sent (above).

A document cannot out-rank its project, nor a comment period, nor a comment its period, and a
project's change cascades to all three. A document or period parented by a `ProjectNotification`
has no such ceiling, since a notification carries no access list, so it keeps the read Eagle sent.

The parent is decided in one place, `helpers/parent-admit.js`, and a notification wins over a
project row carrying the same id. Some Track projects hold a `ProjectNotification` `_id` in
`epic_guid`, which the merge copies to `eagleId`. Letting the project win would narrow those
children to a Track-only project's level 2.

The audit buffer flushes on graceful instance shutdown; a forced kill can drop up to one second of
buffered rows.

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
container. Only the `compliance` role matches that token, and only on the `/api/sealed` routes —
those audit every read, which is the compartment's whole mechanism. No new store, no separate ACL
mechanism.

EVERY OTHER READ EXCLUDES THESE ROWS. `readClause`, `canRead` and `filterFor` add
`NOT ARRAY_CONTAINS(c.read, 'compliance')` — `not read/any(r: r eq 'compliance')` in OData — for
every caller on every ordinary path: the privileged ones (`isPrivileged`: `sysadmin`, `demi-admin`,
`demi-service-read`, `demi-service-write`), whose predicate otherwise collapses to `true`, and the
`compliance` holder itself, which is what keeps `GET /api/documents`, `/api/documents/{id}`,
`/api/documents/{id}/download` and `/api/search` from answering with a sealed row unaudited. The
exclusion is lifted only by an access context carrying `compartment: true`, which
`controllers/nosql/sealed.js` builds and nothing else does; `opensSealed` requires the flag AND the
role. `systemAccess()` sets neither, so exports, seed and reconcile never read a sealed row.

Sealing is an application-layer guarantee. Cosmos data-plane operators, backups and the
`ADMIN_API_KEY` break-glass sit outside it, so the seal is real only under three conditions:

1. The `ADMIN_API_KEY` break-glass must not resolve the `compliance` role.
2. Exports and backups stay locked down.
3. Only a caller that already holds `compliance` may mint a `compliance` API key, so the
   compartment issues its own keys. The route `POST /api/admin/api-keys` is gated on
   `requireAdmin`, which every `staff`, `sysadmin` and `demi-admin` caller passes, and
   `GRANTABLE_ROLES` (`src/controllers/nosql/api-key.js`) includes `compliance`. The gate is on the
   caller, not the list: a `requireAdmin` caller without `compliance` gets 400 `compliance is not
   grantable by this caller`.

Encryption is not part of this design. Per-record envelope encryption is an optional hardening,
taken only when the compartment holds real C&E material.

A record leaves level 0 only through `POST /api/sealed/:id/release`. One `compliance` holder is
enough; the body must carry `caseNumber` and `decision` (400 without either). The release rewrites
`read[]` to `readForLevel(1)` and writes `auditEvent('sealed.release')` with both.

That audit row is the record of the release, and nothing is emailed. Nothing enters level 0
through the widening endpoint: `PUT /:id/level` answers 400 on level 0.

**Selected Credentials.** A credential grants a named party sight of specified records at levels
1-3 without changing any record's level and without changing anyone else's access. Stored in
container `credentials`, partition `/party.id`:
`{ id, party: { type: 'user'|'group'|'apikey', id }, scope: { type: 'document'|'project', ids[] },
levels: [1..3], start, end, grantedBy, grantedAt, revokedAt, batchId, note }`.
Loaded once per request by party (`sub`, a `groups` entry, or `req.user.keyId`), expired and
revoked rows filtered in JS, cached 60 seconds per party. The cache is per Function instance; with
up to 20 ephemeral instances a revoke can take up to the TTL on each, never less than immediately
on the instance that served it. Evaluated as one extra OR arm in
`readClause`, `canRead` and `filterFor`: `id ∈ scope.ids AND levelOfRead(read) ∈ levels`. `levels`
reuses the ladder tokens, so no new SQL: one `EXISTS` over the granted tokens and one negated
`EXISTS` over the tokens above them. The second is what makes the arm mean the row's own level —
levels 2-4 nest in `read[]`, so a level-3 row carries `staff` and containment alone would hand it
to a `levels: [2]` grant. A row with no ladder token matches neither and stays privileged-only.
A project-scoped grant compares the partition field (`id` on projects, `projectId` elsewhere); a
document-scoped one compares the record itself — `id` in Cosmos and on the documents index,
`documentId` on chunks, nothing on projects. Grant, revoke and bulk revoke (by `batchId`, party or
project) go through
`auditEvent`. Credentials never touch the field plane — the holder's own level still governs which
attributes they see — and level 4 needs none.

The party is a person logging in through BCeID (Business, which ties the credential to the
organisation) or a registry API key; IDIR guest only for an external acting as staff. BCeID is not
`idir`, so a credential holder never reaches level 3 by logging in. `end` is required and enforced
on the GRANT, not on the login — 90 days by default. A grant is also closed out by state change: the nightly Track sync
that mints team roles drops a project Track reports closed from every live credential over it, and revokes the credential
once no project is left. EA windows routinely run past 90 days, so renewal is the norm, and the
expiry is visible rather than announced: the holder reads their own live grants and each `end` on
`GET /api/me`, the grantor lists the same rows on `GET /api/credentials`.

**Fail closed.** Each unknown input fails closed or falls back to its default:

- unknown role → level 4
- no ladder token → outside the sealed compartment, the row matches only privileged callers until
  it is written with one
- missing `access.level` → 4
- uncatalogued field → removed
- unknown entity → throws
- dial out of range → `defaultVis`

**Identity.** Keycloak issues the tokens, and role names are the contract, so a second issuer
changes only the claim path in `rolesFor` and `src/helpers/auth.js`. DEMI creates no realm roles.

### User, group and inspection mirrors (2026-10-06)

eagle-api pushes five more kinds (`DEMI_PUSH_OPT_IN_KINDS` in eagle-api). Routes are in
`src/http/routes.js`, paths in `src/swagger/swagger.yaml`, containers in
`azure/modules/cosmos-nosql.bicep`:

| Route | Handler | Container | Partition key |
|---|---|---|---|
| `PUT /eagle/users/:eagleId` | `nosql/user.upsertFromEagle` | `users` | `/id` |
| `GET /users`, `GET /users/:id` | `nosql/user.getUsers`, `getUser` | `users` | `/id` |
| `PUT /eagle/groups/:eagleId` | `nosql/group.upsertFromEagle` | `groups` | `/projectId` |
| `GET /groups?project=`, `GET /groups/:id` | `nosql/group.getGroups`, `getGroup` | `groups` | `/projectId` |
| `PUT /eagle/inspections/:eagleId` | `nosql/inspection.upsertInspectionFromEagle` | `inspections` | `/inspection` |
| `PUT /eagle/inspection-elements/:eagleId` | `nosql/inspection.upsertElementFromEagle` | `inspections` | `/inspection` |
| `PUT /eagle/inspection-items/:eagleId` | `nosql/inspection.upsertItemFromEagle` | `inspections` | `/inspection` |
| `GET /inspections?project=`, `GET /inspections/:id?inspection=` | `getInspections`, `getInspection` | `inspections` | `/inspection` |
| `GET /inspection-elements?inspection=`, `GET /inspection-elements/:id?inspection=` | `getInspectionElements`, `getInspectionElement` | `inspections` | `/inspection` |
| `GET /inspection-items?inspection=&element=`, `GET /inspection-items/:id?inspection=` | `getInspectionItems`, `getInspectionItem` | `inspections` | `/inspection` |

PUT routes take the same guards as the other `/eagle/*` mirrors. GET routes take
`passiveAuthMiddleware.strict, credentialsMiddleware`, as `GET /documents`, so a rejected Bearer
is a 401. Lists order on `c.id`; the
`inspections` container filters on `kind`, `projectId` and `element`, so those paths must be indexed.
The user and group GETs follow the native list contract (`helpers/native-query.js`: `page`, `sort`,
`q`, `ids`, `count`) behind `passiveAuthMiddleware.strict`, so a rejected Bearer is a 401. Staff
user reads are audited, and a user `q` is never written to analytics.

- `users` is partitioned by `/id` and that is also the scope field, so a project-scoped key reads
  no user. Eagle's `password` and `salt` are dropped before the row and its raw copy are built.
- `groups` sits under the DEMI project id and is capped by the project.
- Elements and items share `inspections` with their inspection. The partition key is the
  inspection's DEMI id (its own id on an `Inspection` row), so one inspection and everything under
  it is one logical partition. The parent cap is read in that partition, and the ACL cascade is one
  single-partition batch. Eagle links only downward (`elements[]`, `items[]`), so a child finds its
  parent by the stored row that lists it. A child pushed before its parent lists it gets a 503,
  which eagle-api retries once. `projectId` rides on every row as the scope field. It is null on an
  inspection Eagle filed without a project, and no scoped caller reads that row.
- Rows are capped by their parent through `eagleReadUnder`: a group and an inspection by the
  project, an element by its inspection, an item by its element. A parent whose level moves
  re-derives the rows under it, and a project level change re-derives its groups and its
  inspection chain. `isDeleted: true` flags the row and narrows it to level 2.
- eagle-api publishes none of these kinds, so `reconcile-eagle.js` has no Eagle id set to diff.
  It checks each row against the rule applied to its own stored Eagle read and its stored parent,
  and reports `aclMismatch` and `missingParent` per kind.
- Until the containers exist, the project cascade and the reconcile skip a kind whose container
  answers 404 (`helpers/unprovisioned.js`, one warning per process); the reconcile line reads
  `skipped` for it. `cosmos-nosql.bicep` creates all three, so once that deploys the skip
  should not fire.
- Field levels are in `src/vis/catalog/users.js`, `groups.js` and `inspections.js`. Every user
  contact field (email, phone, cell, fax, postal address) and the user notes are 2/2. So are the
  inspector `email` on an inspection, the stored-file internals on an item, and group `members`.

## 2. Corrections to the source design

Each item below overrides the corresponding section of the source document.

1. **Redactor sits at the response boundary, not inside `getById`.** Eight controller paths read
   with the caller's access and spread the result back into an upsert
   (`src/controllers/nosql/project.js`, `document.js`, `boundary.js`). Cosmos upsert replaces the
   item, so a redacting `getById` would erase every hidden field on the first edit.

   Repositories return raw documents. The redactor `redactForAccess(entity, doc, access)` runs at
   every `res.json` of an entity and on the repository row before each search mapper. That is where
   `publicView` sits, for the same reason (`src/repositories/projects.js`).

   The coverage ratchet scans `src/controllers/**` per call site, not per file. Redaction-safe
   update needs one rule: PUT returns 400 on any body key the caller cannot see.

   Two things survive from the source design's repository placement. List reads use a
   catalog-derived `select` (`selectFor(entity, access, partitionField)`), so never-visible values
   do not leave Cosmos. The tripwire test also covers controller error and log paths, since raw
   documents pass through them.
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
3. **Defaults keep the public output of `eagle-public`.** Every field `eagle-public` renders
   anonymously has `defaultVis: 4`, including `projectLead`, `projectLeadEmail`, `responsibleEPD`,
   `responsibleEPDEmail`, `eaoMember`, `projectCAC` and `projectCACPublished`
   (`eagle-public/src/app/services/api.ts`). The field `cacEmail` is `defaultVis: 2, maxVis: 4,
   when: 'cacPublished'` (item 7), not a flat 4.

   The source catalog gave `name`, `description`, `centroid`, `proponentName`, `region` and
   `projectState` `defaultVis: 2`, which would leave an anonymous project response with five
   identifier fields. Fields `eagle-public` does not request, `complianceLead` and
   `execProjectDirector`, start at `defaultVis: 2`.

   Lead and EPD names and emails, and the records-management identifiers `orcsClassification` and
   `edrmsRecordNumber`, stay at 4: public by policy (§3 question 2).
4. **Level 0 runs the same loop.** There is no `if (level === 0) return record`, and
   `catalogFor(entity)` runs first so an unknown entity throws for every caller. Predicates widen
   rather than gate (Section 1), and only `systemAccess()` carries level 0 (§5 item 1), so
   `maxVis: 0` fields reach no response, `sysadmin` included.
5. **`read[]` does not carry field levels.** The source design put `demi-vis-*` into `read[]` for
   whole-record restriction, but `read[]` carries the row-plane ladder tokens (§1) and membership
   has no ordering. Whole-record level rules, if ever needed, become a catalog rule, not ACL
   vocabulary.
6. **Dials survive upserts.** The Eagle upsert (`upsertFromEagle` in
   `src/controllers/nosql/project.js`) and `seed-nosql.js` replace the whole item. Both carry `vis`
   forward beside `sources`, and a test covers it.
7. **`cacPublished` reads a flag DEMI owns.** `projectCACPublished` is DEMI-owned
   (`CAC_FIELDS` in `src/ownership/project.js`). Once a row holds it, only the CAC routes in
   `src/domain/cac.js` change it: create, publish, unpublish and delete. An Eagle push or a seed
   sets it on a row that lacks it, and a re-seed drops it from a row that lost its Eagle id.

   `PUT /api/projects/:id` ignores it (`PUT_IGNORED_FIELDS`), so a hand-edited project body
   cannot flip it. The CAC routes take [staff, sysadmin] only, while PUT also takes `demi-admin`
   and `demi-service-write`. So the strip keeps those two roles from flipping it through PUT.

   `cacEmail` is `defaultVis: 2, maxVis: 4, when: 'cacPublished'`: a true predicate widens the
   field to `maxVis`, and a dial beats it. `sysadmin` can pin `cacEmail` shut with the dial even
   while `cacPublished` is true. A `when` naming no export of `src/vis/predicates.js` throws at
   load, and predicates take `(record)` only.
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
10. **Token hardening includes deployment.** `isAllowedClient` (`src/helpers/auth.js`) answers
    401 to a verified token whose `azp` is not in `DEMI_ALLOWED_CLIENTS`, with no demoted identity.
    An empty list is permissive, so `src/config.js` refuses to run outside dev and local without
    one.
11. **The level comparison lives in one function.** The function `visible(level, effVis)` in
    `redact.js` is the only place the scalar order is assumed. A switch to a clearance set would
    change that file plus `levelFromRoles`.
12. **Roles.** The ACL-bearing `compliance` role is in `ROLE_LEVELS` and in `GRANTABLE_ROLES`
    (`src/controllers/nosql/api-key.js`), which is `AUTHENTICATED_ROLES` plus `compliance` and
    `public`. DEMI creates no realm roles: it reuses Eagle's (`sysadmin`, `staff`), and `demi-admin`
    and `demi-service-*` exist only on API keys.
13. **Dropped.** `visLevelCap` on API keys (keys already carry roles and scope), a separate
    `audits` container (`auditEvent` exists), `GET /api/vis-catalog` (no admin UI reads it), golden
    fixture files (a regenerated golden proves nothing).
14. **Every new endpoint updates `src/swagger/swagger.yaml` in the same PR.**

## 3. Questions for the EAO

1. Answered: the EAO sharing model, with ladder 1-4 on the row plane, level 0 a sealed
   compartment and Selected Credentials a time-bound lane. Model in §1, deltas in §5.
2. Answered (Daniel): project lead and EPD names and emails are public, because `eagle-public`
   shows them. They stay `defaultVis: 4`; no exception list.
3. Dropped: `forMAEE` is a column of the source spreadsheet that nothing in DEMI reads. No catalog
   entry derives from it.
4. Moot: `project_tracking_number` (`trackProjectId`) and `epic_guid` (`eagleId`) are in the
   anonymous response and catalogued `4/4`. They stay public.

### Follow-up questions

9. Closed (Daniel): a project must exist before any record does, so every record has a team.
   The `documents` container partitions on `/projectId`; no business-unit axis is needed.
10. Answered: from Track. A project's team is the union of staff across its works
    (`staff_work_roles` joined to `works`), and `src/scripts/sync-track-teams.js` mints the
    matching `project:<id>` realm roles. Lead-managed lists are a manual override, not the
    system of record.
11. Answered: the compartment is exactly the `compliance` role (`src/controllers/nosql/api-key.js`),
    created as a realm role and granted to named humans behind the C&E lead.
12. Answered: one `compliance` holder is enough, provided the release records a case number and a
    decision in the same action. The `sealed.release` audit row is the record and nothing is
    emailed. Two-person release would be a policy toggle, not a schema change.
13. Answered: yes, people through BCeID enabled as an IdP on `eao-epic`, with BCeID Business for
    proponents and consultants and IDIR guest only for an external acting as staff. Systems use
    the registry API keys (roles, `projectScope`, level cap). BCeID is not `idir`, so a BCeID party
    never lands on level 3.
14. Answered: `end` is required, defaults to 90 days, and is enforced on the grant, not the login.
    The grant is also revoked when Track reports the project closed. Renewal is the norm, and the
    holder sees each `end` on `GET /api/me`, the grantor on `GET /api/credentials`.
15. Answered: required for any widening to level 4 and for every level-0 release, which also
    carries the case number. Optional on every other move, because the audit row carries actor,
    time, from and to.
16. Answered: yes, but `sysadmin` only, always audited, and framed as incident response
    (error or privacy breach). A routine correction publishes a replacement instead. Pulling back
    from level 4 follows `docs/takedown-runbook.md`: purge the AI Search index, clean up
    chunks, invalidate caches, and state that copies outside EPIC are unrecoverable.

## 4. Source-document claims that were wrong at `aea2a0c`

- The source document's count of `EAGLE_ONLY_FIELDS` was wrong. The list is in `src/ownership/project.js`; read the entries there, since a count goes stale.
- `src/helpers/response.js` is not dead: `serverError` is imported by six controllers.
- `res.json` sites: 108 total, 62 non-error, not about 45.
- No email-intake upload route exists; the only upload route is `POST /documents/extract`.
- `publicView` has a fifth call site (`src/controllers/nosql/project.js`); in
  `src/controllers/search.js` it filters only the `sources` sub-object of a hand-built row.
- `ENRICHMENT_SOURCES` is empty in prod, so `sources.wildfire` is a test-only value.
- `rolesFor` has no `|| user.roles` fallback.
- PUT accepts arbitrary body keys; POST drops them (`src/controllers/nosql/project.js`).
- `src/ai/summarize.js` consumes chunk `content` only, never a project or document row.
- No AI Search index has any staff, email, or `sources` field retrievable or searchable.
- ADR-004 is `eagle-demi.wiki/ADR-004-Read-ACL-Authorization-Model.md`.
- `boundaries.js` was deliberately removed from the coverage test's `UNGATED` list; `config.js` is
  in it.

## 5. Changes from the EAO sharing model

The business text (levels 1-4 ladder, level 0 compartment, Selected Credentials) supersedes parts
of §1-§3. Nothing built before it is withdrawn.

### Superseded

1. **Levels are not one nested ladder that `sysadmin` tops.** Level 0 is a compartment outside the
   ladder, and `sysadmin` is superuser on levels 1-4 only. In `ROLE_LEVELS` (`src/vis/level.js`),
   `sysadmin` and `demi-admin` are 1; `staff`, `demi-service-read/write` and `compliance` are 2;
   `idir` is 3; `public` is 4.

   There is no `team` entry, because team membership is a row-plane fact resolved per record by
   the team arm in `readClause`/`canRead`. The FIELD-plane level 0 belongs to `systemAccess()`
   alone. The ROW-plane level 0 is the `compliance` token, which `systemAccess()` lacks (§1).
2. **"Group (compartment)" and dial values of shape `{ level, groups }` are deleted.** The EAO
   "Special: Selected Credentials" lane is not a tag on a field — it is a time-bound grant to a
   named party over named records, on the ROW plane (§1, `src/middleware/credentials.js`). Dials
   stay integers; `src/vis/groups.js` does not exist.
3. **§3 question 1's answer is replaced.** "Nested levels 0-4 with lateral groups inside a level" is
   wrong on both halves. Model in §1.

### Still valid

- §2 stands as written; item 11 holds: `visible()` is the only scalar comparison.
- Catalogs, redactor, `selectFor`, PUT hidden-key guard, search drift ratchets, query-param gate
  and `/api/me` stand. The projection `selectFor(entity, access, partitionField)` returns `'*'`
  only at level 0, which only `systemAccess()` carries.
- The frontend gates staff UI on `staffUi` from `/api/me`, falling back to `hasStaffRole()` when
  `/api/me` gives none (`frontend/src/session/SessionProvider.tsx`). It never gates on
  `privileged` or `level`, because `staff` and `compliance` are both level 2.
- §3 questions 2, 3, 4 stay closed, and the follow-up questions 9-16 are answered.
