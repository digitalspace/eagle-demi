# eagle-api port tracker

Goal: DEMI owns every EPIC object with its own create, read, update and delete routes, so eagle-api can be retired. This is a rewrite, not a copy. Route shapes, validation, storage and auth follow DEMI conventions. Business rules do not change.

Scope: DEMI is the EAO platform API. It will serve every EAO application and future projects, not only eagle-public and eagle-admin. Design each object and route for any consumer: no field names, filters or response shapes that exist only because one screen wants them, no consumer-specific endpoints, public and staff behaviour decided by role and visibility rather than by which app is calling.

Audited 2026-10-14 against eagle-api `origin/develop` (24 commits ahead of the local checkout on that date) and eagle-admin `origin/develop` 593e910ec. Local checkouts were stale; recheck upstream before trusting a `file:line` here.

## How to work this file

1. Take the next object whose status is `todo`. One object per branch and pull request.
2. Before writing any route, read the eagle-api handler and model for that object and fill in or confirm its "Business rules" list below. Rules come from the handler bodies, the Mongoose model, the swagger definition and the eagle-admin caller. Record each rule as one line with its `file:line`. If a rule looks wrong or accidental, record it under "Questioned" and ask before dropping it.
3. Design the DEMI shape from the rules, not from the eagle-api route. Plural REST under the existing router (`src/http/routes.js`), guards from the route table, visibility from `src/vis/catalog`, reads through `src/helpers/access-sql.js`, writes through `src/repositories/`, same error envelope as the other DEMI routes. Reuse existing DEMI routes and fields where they already serve the need. Layering rules: see "Layering" below.
4. Every new route needs `node --test` tests, a catalog entry for any new field, a `src/swagger/swagger.yaml` entry, and a README line under "Parity with eagle-api".
5. Field ownership runs in three phases for every object.
   - Dark: the DEMI routes are merged and have no caller. Eagle owns every field and mirror ingress keeps writing them. A DEMI write in this phase is overwritten by the next push, so the routes are staff-only and the row says so.
   - Flip, one release window covering both repos: the eagle-admin caller moves to DEMI, and DEMI ingress stops taking that object's fields. Project-embedded fields such as pins and CAC move to `DEMI_ONLY_FIELDS` (`src/merge/project.js:182`) and out of `EAGLE_ONLY_FIELDS`. For a whole kind, `/eagle/<kind>/:eagleId` accepts the push and ignores the fields DEMI now owns, answering 2xx, so eagle-api's echo of a DEMI write does not fail. The sync-out consumer is turned on only if an Eagle reader still needs the data; decide and record that per object. Deploy the DEMI tag first, eagle-admin right after, then compare the nightly reconcile drift report for that object. Each flip ships a test that an Eagle push leaves DEMI-owned fields unchanged.
   - Retire: delete the eagle-api handler, `controllers/nosql/<kind>.js` and the mirror route.
6. Set the row status in the same diff as the code: `todo`, `in progress (branch)`, `done (demi sha, admin sha)`. Record all shas on the row.
7. Retire the eagle-api handler only after the eagle-admin cutover is live on test. Retirement rows are at the end.

## Work plan

- Claim rule: a developer sets their row to `in progress (feat-port-<slice>)` in its first push. A branch that already exists locally or on origin means the slice is taken, where the branch named in the slice's row in the table counts as the claim (default name `feat-port-<slice>`).
- Each slice's brief, rules and file lists are in `docs/eagle-api-port-plan.md`.
- Swagger rule: add methods inside the object's existing path block. Use anchors only for new paths.

| id | objects | owns (main files) | after | size | status |
|---|---|---|---|---|---|
| 0 | Scaffold and work plan | `domain/_schema.js`, `domain/_write.js`, `controllers/native/write.js`, `middleware/require-roles.js`, route-inventory test | none | M | done (b9e4685f) |
| 1 | Organizations + pins (Dark) | `domain/organizations.js`, `controllers/native/organizations.js`, `repositories/lists.js`, `repositories/users.js` (orgName cascade) | 0 | M | done (b9e4685f); Dark: staff-only, no caller |
| 2 | Comment periods | `domain/comment-periods.js`, `controllers/native/comment-periods-write.js`, `repositories/comment-periods.js` | 0 | M | in progress (feat-port-comment-periods) |
| 3 | Comments | `domain/comments.js`, `controllers/native/comments.js`, `repositories/comments.js` | 2 | M | todo |
| 4 | Project groups + members | `domain/groups.js`, `controllers/native/groups.js`, `repositories/groups.js` | 0 | M | todo |
| 5 | Updates (recent activity) | `domain/updates.js`, `controllers/native/updates.js`, `repositories/updates.js`, `test/helpers/access-coverage.test.js` | 0 | L | todo |
| 6 | Project notifications | `domain/notifications.js`, `controllers/native/notifications.js`, `repositories/notifications.js` | 0 | S-M | todo |
| 7 | Users | `domain/users.js`, `controllers/native/users.js`, `repositories/users.js` | 1 | S-M | todo |
| 8 | Extensions | `domain/extensions.js`, `controllers/native/extensions.js`, `vis/catalog/projects.js` | 0 | M | todo |
| 9 | Project publish legislation-year switch | `domain/project-legislation.js`, `controllers/nosql/project.js` | 0 | M | todo |
| 10 | Sitemap | `controllers/sitemap.js` | 0 | S | todo |
| 10b | `robots.txt` repoint (eagle-public `develop`, `react`) | eagle-public `robots.txt`, one slice per line | 10 | - | todo |
| 11 | CAC | `domain/cac.js`, `controllers/native/cac.js`, `src/services/notify.js`; eagle-notify route PR first | 0 (8 if a catalog edit is needed) | M | todo |
| T | Parity-map tidy | `src/scripts/parity-map.js` | 4, 5 | S | todo |
| A0 | eagle-admin DEMI write client | `demi-api.service.ts` and spec | none | S | todo |
| A2 | eagle-admin project legislation read | `full-project.resolver.ts` and spec | none | S | todo |
| FS | Sync-out generalization | `sync-out/index.js`, `sync-out/kinds.js`, `domain/_write.js`, `src/controllers/nosql/engage-comment-period.js` | 0 | M | todo |
| F1 | Flip: pins + organizations | `domain/project-pins.js`, `controllers/nosql/project.js`, `merge/project.js`, eagle-admin pins and org services | 1, 9, FS, A0 | - | todo |
| F2 | Flip: comment periods | `controllers/nosql/comment-period.js`, `sync-out/eagle.js`, eagle-admin `commentperiod.service.ts` | 2, FS | - | todo |
| F3 | Flip: comments | `controllers/nosql/comment.js`, eagle-admin `comment.service.ts` | 3, F2 | - | todo |
| F4 | Flip: groups | `controllers/nosql/group.js`, eagle-admin `project.service.ts` | 4, F8 | - | todo |
| F5 | Flip: updates | `controllers/nosql/update.js`, eagle-admin `recent-activity.ts` | 5 | - | todo |
| F6 | Flip: notifications | `controllers/nosql/notification.js`, eagle-admin `notification-project.service.ts` | 6 | - | todo |
| F7 | Flip: users | `controllers/nosql/user.js`, eagle-admin `user.service.ts` | 7 | - | todo |
| F8 | Flip: extensions | `merge/project.js`, eagle-admin `project.service.ts` | 8, F1 | - | todo |
| F9 | Flip: project writes | `controllers/nosql/project.js`, eagle-admin `project.service.ts` | 9, F4 | - | todo |
| F10 | Flip: documents | document mirror, eagle-admin `document.service.ts` and components | FS, A0 | - | todo |
| F11 | Flip: CAC | `merge/project.js` (DEMI_ONLY) | 11, F8 | - | todo |
| R1 | Retire in eagle-api: dead handlers | topic, vc, materialized-view refresh, `/public/comment`, `/public/document`, `/task`, `listJobs`, `login` | none | - | todo |
| R2 | Retire in eagle-api: per object | handlers under "Callers to move", pin routes, extension routes | the object's Flip live on test (retire tag: live on prod) | - | todo |
| R3 | Retire in DEMI: mirror lines | mirror lines and each kind's `upsertFromEagle` | the kind's Flip live on prod | - | todo |

### Decisions

Decided 2026-10-14.

1. CACUser search dataset: dropped. No caller, and members live in eagle-notify. Slice T marks it dropped in `parity-map.js`.
2. Materialized-view status: kept until DataBC moves to DEMI `/reports`, then a small eagle-demi-admin slice removes the call.
3. Jobs: no port until a caller appears.
4. Inspections: the mirror lines `routes.js:252-254` stay as a frozen import path, with no Dark slice.
5. CAC member store: eagle-notify stays the member store and never hard-deletes. Members sign up in eagle-notify and DEMI holds no member store. Slice 11 has two halves. Half A (eagle-notify, own PR, merges first): a staff or service-key route that unsubscribes one CAC member, and one that unsubscribes every member of a project's CAC. Both soft delete with the existing TTL and log through the existing logger. Half B (eagle-demi, after half A is live on test): `src/services/notify.js` gains those two calls; `domain/cac.js` remove-member calls the first and CAC delete calls the second. A failed eagle-notify call fails the DEMI write.

## Layering

Import direction: `routes.js` -> `controllers/native/<kind>.js` -> `domain/<kind>.js` -> `repositories/<kind>.js` -> `db/cosmos-nosql` and `_sql`.

### The four layers

1. Route entry. Decides who may call, by role only. Guards per route come from the eagle-api `x-security-scopes`, using `requireRole(...names)`, which admits any one listed role and keeps the list on the guard as `roles` (`src/middleware/require-roles.js:53-70`). Each ported route sits under its slice's `// port: <kind>` anchor in the "Ported objects" section at the end of the route table. No new staff guard. `requireAdmin` is not reused, because it admits `demi-admin` (`access-sql.js:193`).
2. Controller, `src/controllers/native/<kind>.js`. An HTTP adapter. It builds the read `SPEC` and uses `listHandler` and `getHandler` (`controllers/native/organizations.js:12-26`). Each write is one line, `writeHandler(domainFn, { entity })`, from `src/controllers/native/write.js`; `entity` is the catalog entity that redacts the saved row. That helper calls `resolveAccess`, calls the domain function, maps `ok`, `invalid`, `forbidden`, `not-found` and `conflict` to 200 or 201, 400, 403, 404 and 409, then runs `redactForAccess` and `serverError`. It also maps `busy` (the etag retries of `writeGuarded` ran out) to 503 with body `{ error: 'The record is being written by another request. Try again.' }`, the body the project writes already answer. Every refusal logs a warning through `src/utils/logger.js`; an invalid body logs field names, never values. A controller that imports `domain/` never writes `res.status` or `res.json`. It never imports `db/*`. It imports a repository only for the read `SPEC`.
3. Domain, `src/domain/<kind>.js`. New directory. It is not `src/services/`, which holds outbound clients. It exports plain functions: `create(ctx, input)`, `update(ctx, id, changes)`, `remove(ctx, id)` and named actions such as `publish` and `setStatus`. `ctx` is `{ access, req }`; `req` is used only for the audit identity. Each function runs these steps in order: check the `SCHEMA` allowlist (unknown key gives 400); load the row through the repository with `access` (an unreadable row is not-found); call `refusedWriteKeys`; apply the named rules; write through `_write.js`. It may import repositories, `helpers/access-sql`, `helpers/etag-write`, `helpers/eagle-acl`, `vis/redact.refusedWriteKeys`, `domain/_schema` and `domain/_write`. It never imports `http/*` or `db/*`, and never touches `res`.
4. Repository. Storage only. Reads go through `cosmosKind` (`helpers/native-query.js:255`) or `nativeKind` (`lists.js:136`). Writes go through `_sql`. It never imports the domain, controllers, `utils/audit` or `vis/redact`. Specs are `{query, parameters}` only.

### Where authorization lives

- Who may call: the route table.
- Which rows exist for this caller: `access-sql` in the repository.
- What may change on this row: the domain module (readable-row load, `refusedWriteKeys`, schema allowlist, named rules).
- Visibility changes only through an explicit publish or level action, never through a PUT body (the `document.js:1260` pattern).

A separate auth layer would have to load the row twice or copy the rules, so there is none.

### Validation

`src/domain/_schema.js` is a hand-rolled module of about 60 lines with no dependency. It covers string (max length), boolean, enum, ISO date, id, array of ids, and required. Field errors return in one envelope. An allowlist replaces the denylists (`project.js:451-472`). Unknown keys return 400. Move to ajv against the swagger components only if nested schemas spread.

### Audit

`src/domain/_write.js` exports `writeRow({ ctx, repo, existing, reread, build, audit })`. It wraps `writeGuarded` and calls `auditEvent(ctx.req, audit(saved, from))` once on success, then logs the action and row id at info. A call without `audit` throws. When every etag retry loses, it returns `busy` and writes no audit row. The backstop is a route inventory, one file per object under `test/controllers/route-inventory/` (`existing.js` holds the routes from before the port), checked by `test/controllers/route-inventory.test.js`, which loads every file in that directory: every non-GET route in `routes.js` has an audit action or an exempt entry with a reason. Each ported route's entry also carries a role column: the roles from eagle-api's `x-security-scopes` for that route, plus `sysadmin` and `staff` where DEMI's guard grants them (see the Organizations section), and the test checks they match the route's `requireRole` guard.

### Sync-out

Sync-out is added to `_write.js` at the first object flip that needs it. That flip slice must:

- raise `syncVersion` on every write (`src/sync-out/index.js:216`);
- move `enqueueQuietly` from `src/controllers/nosql/engage-comment-period.js:141-149` into one exported function in `src/sync-out/index.js`, used by both callers (an extraction, not a refactor of that controller);
- carry `kind` in the queue message and in resend (`index.js:227`), and re-read the row through a kind-to-repository registry;
- give each kind its own consumer (path, `bodyFor`, claim) and its own reconcile path.

`test/sync-out-triggers.test.js` sits at the test root beside `test/sync-out/sync-out.test.js`.

### The generic base stays thin

Shared code is the read `SPEC`, `writeHandler`, `_write.js` and `_schema.js`. Each object's creates, updates and actions are explicit. There is no "patch any catalogued field" path (see the comment at `document.js:1155-1160`). Read-only objects such as the sitemap get no domain module.

### Checklist: add an object

1. Tracker row: rules with eagle-api `file:line`, role scopes per route, field ownership per phase.
2. New fields in `src/vis/catalog/<entity>.js`, and `catalog/index.js` if the entity is new.
3. `src/repositories/<kind>.js`.
4. `src/domain/<kind>.js`: `SCHEMA`, write functions, rules, and `writeRow` with audit actions.
5. `src/controllers/native/<kind>.js`: read `SPEC` and `writeHandler` wrappers.
6. `src/http/routes.js` entries under the slice's `// port: <kind>` anchor, with guards per route.
7. `src/swagger/swagger.yaml`.
8. Tests: `test/domain/<kind>.test.js`, a new `test/controllers/native/<kind>-write.test.js`, and `test/controllers/route-inventory/<kind>.js`.
9. README line under its `port: <kind>` anchor in "Parity with eagle-api".
10. Flip slice: ownership move in the ingress, the push-does-not-overwrite test, and sync-out if needed. It ships with the eagle-admin caller move.
11. Retire slice.

### Trade-offs

1. The router stays a catch-all (`router.js:3-9`). The cost is that every pull request touches `routes.js`, swagger and the inventory table.
2. Only mechanics are shared. Rules are explicit per object, because a generic update path caused the ACL bypass.
3. With about 15 objects the cost is three helpers plus up to 13 domain modules, each with real rules. Read-only objects get none, and so do topic and vc (dropped 2026-10-14).
4. The hand-rolled schema needs no dependency. Switch to ajv only if nested schemas spread.
5. The layering test, `test/domain/layering.test.js`, is a text scan. It catches forgetting, not intent (same stance as `router-source.js`).

## Rules that hold for every object

- Visibility is a level on the document, read through the catalog (`src/vis/catalog/*.js`) and predicates (`src/vis/predicates.js`). A publish or unpublish is a level change, not a boolean, except where a rule below says otherwise.
- Direction flips per object. Today eagle-api pushes into DEMI through the `/eagle/<kind>/:eagleId` mirror routes (`requireEagleMirror`). Once an object has DEMI CRUD and eagle-admin writes through DEMI, DEMI is the source of truth for that object: `src/sync-out` pushes it to eagle-api, the mirror ingress for that object retires, and eagle-api becomes a read replica until it is retired. Never leave an object with two writers; record the owner of every field during the flip.
- Order per object: Dark, Flip, Retire, as defined in How to work this file.
- Nothing writes into Eagle Mongo directly. While eagle-api is live, a DEMI write that Eagle still needs goes back through eagle-api's API from `src/sync-out`, as comment periods do today.
- Field-level redaction happens at the response boundary, never in `getById`.
- Audit log on every staff write, through the existing path used by `src/controllers/nosql/document.js`.
- Public reads stay anonymous and cached as the existing read routes are. Staff writes carry the same role gates eagle-api applied (sysadmin, staff, project-specific) unless a rule below records a deliberate change.

## Objects

### Pins

Status: done, Dark (b9e4685f). Label read only; pin writes land in F1.

Today: `pins` is a field on the project document, resolved to `{_id, name, province}` in `src/merge/project.js:146-153`, shown when `pinsRead` includes `public` (`src/vis/predicates.js:18`). `PUT /projects/:id` strips `pins` and `pinsPublished` (`src/controllers/nosql/project.js:489-492`). `pinsRead` has maxVis 0 (`src/vis/catalog/projects.js:155`). eagle-public react reads pins through `GET /demi-projects/:id` (`src/app/api/api.ts:395-410`).

Design (Daniel, 2026-10-14): a pin is an organization, so DEMI has no pin routes. The organization is the object. A pin is only the link "organization X is pinned to project Y" plus a published flag, and that link lives on the project.
- Organization create and update: the Organizations section below. This section adds no organization rules.
- `PUT /projects/:id` accepts `pins` (a list of organization ids) and `pinsPublished` (boolean). It stops stripping both (`src/controllers/nosql/project.js:489-492`). The route keeps its existing project guard (`[authMiddleware, requireWrite]`, `routes.js:170`).
- Every id in `pins` must exist in the organizations table. Otherwise the PUT returns 400 and lists the unknown ids. This is a foreign-key check.
- DEMI has no `POST`, `DELETE` or `PUT` route under `/projects/:id/pins`. eagle-api's `/project/:id/pin` sub-routes edit an array; DEMI does not copy them.
- Reads: eagle-public and eagle-admin get pins from the project read, `GET /projects/:id`. There is no `GET /projects/:id/pins`.

Rules:
- `pins` replaces the stored list. De-duplicate the ids before the check and the write. Order is kept.
- The stored value is the id list. The project read returns each pin as `{_id, name, province}`, resolved from the organizations table.
- `pinsPublished` true adds `'public'` to `pinsRead`, false removes it, for the whole list (eagle-api `pins.js:167,194`). It applies to the whole list, not one pin.
- When the list is unpublished, the public response is `[]`. This is a deliberate change from eagle-api `[{total_items: 0}]` (`pins.js:42`).

Ownership per phase:
- Dark: Eagle owns `pins` and `pinsRead`. The strip at `project.js:489-492` stays. Slice 1 adds the label read `lists.listOrganizationLabels` (`c.id, c.name, c.province`, key `id`). It has no caller until F1, which maps `id` to `_id`.
- Flip: `pins`, `pinsRead` and `pinsHistory` move to `DEMI_ONLY_FIELDS` in `src/merge/project.js:182`. The strip is removed and the PUT accepts the fields as above. Fix the comment at `project.js:459-460`. Remove the dead pins-shape branch in `carryEagleOnlyFields` (`merge/project.js:220-232`) and its tests (`test/merge/project.test.js:899-913`).
- Sync-out: DEMI pushes the project's organization id list and published flag into eagle-api's `pins` and `pinsRead`. eagle-api project PUT does not touch `pins` (`api/controllers/project.js` has no `pins` reference on `origin/develop`), so the push uses the eagle-api pin routes: `POST /project/:id/pin` for ids to add, `DELETE /project/:id/pin/:pinId` for ids to remove, `PUT /project/:id/pin/publish` or `/unpublish` for the flag. The consumer reads the eagle-api list first and sends the difference.

Open before build:
- (a) Resolved: the label read exists as `listOrganizationLabels` in `src/repositories/lists.js`, selecting `c.id, c.name, c.province` with key `id`; the domain maps `id` to `_id` in F1; no caller until F1.
- (b) eagle-admin `pins-list.component.ts:128-136` reads the published flag from the eagle-api envelope, `read.includes('public')`. DEMI never returns `pinsRead` (maxVis 0). eagle-admin must read `pinsPublished` from `GET /projects/:id`, and the pins page must show the correct state after a change.
- (c) The eagle-api pin publish and unpublish guard was `staff, sysadmin`. The flag now rides on project PUT, whose guard is `requireWrite` (`routes.js:170`), and that guard admits the `demi-service-write` service key; the earlier pin design deliberately kept that key out of pin edits. Rule to apply: the domain policy for project PUT rejects changes to `pins` or `pinsPublished` (403) unless the caller holds `sysadmin`, `staff` or `project-system-admin`, so a service key may update other project fields but never pins. Confirmed 2026-10-14: DEMI has no pin routes. The pinned organization list and `pinsPublished` ride on project PUT, and a change to either returns 403 unless the caller holds sysadmin, staff or project-system-admin. eagle-api pin routes retire after F1.

Guard note, checked against eagle-api `origin/develop` `swagger.yaml`: `PUT /project/{projId}` lists `project-system-admin` alone (`swagger.yaml:1309-1310`). Of the pin sub-routes, `POST /project/{projId}/pin` (`:1620-1623`) and `DELETE /project/{projId}/pin/{pinId}` (`:1779-1781`) list it; `pin/publish` (`:1675-1677`) and `pin/unpublish` (`:1724-1726`) do not. So the role is already on the project PUT and needs no pins-only rule.

The `project-system-admin` role is kept. DEMI route guards accept it only on the routes where eagle-api's `x-security-scopes` lists it, copied per route into the route-inventory table. It never bypasses route scopes or record-level access the way `sysadmin` and `staff` do. `AUTHENTICATED_ROLES` is at `src/helpers/access-sql.js:214` (built from lines 181-183, 193, 207) and does not include it; `src/middleware/auth.js` only calls `isAuthenticatedRole` (`access-sql.js:276`). The role is held in prod (23 of 26 active users) and test (2 of 11), measured 2026-10-14 from eagle-api audit rows over 90 days. Every holder also has `sysadmin`, so the role admits no extra user. Revisit only if Keycloak is cleaned up.

Callers to move: eagle-admin `project.service.ts` pins methods (add, delete, publish, unpublish) on `origin/develop`. They become one project PUT carrying `pins` and `pinsPublished`.

### Comment periods

Status: Dark

Today: reads at `routes.js:293-295`. Mirror writes at `routes.js:249` (Eagle) and `routes.js:266` (ENGAGE ingest, ENGAGE-sourced periods only). Dark: the five write routes are served under the `port: comment-periods` anchor (`routes.js:367`), rules in `src/domain/comment-periods.js`, handlers in `src/controllers/native/comment-periods-write.js` (apart from the reads because the summary read answers `res` itself). eagle-admin still calls eagle-api. DEMI's own `src/sync-out/eagle.js:190,199,206,245` calls eagle-api `GET`, `PUT`, `DELETE` and `POST /commentperiod` to write back into Eagle.

Target routes: `POST /comment-periods`, `PUT /comment-periods/:id`, `DELETE /comment-periods/:id`, `PUT /comment-periods/:id/publish`, `PUT /comment-periods/:id/unpublish`. Then rewire `src/sync-out/eagle.js` so DEMI is the writer and Eagle receives the mirror (F2).

Guards: every route is `[authMiddleware, requireRole('staff', 'sysadmin')]` (eagle-api `swagger.yaml:5434,5697,5730,5781,5830`).

Business rules (eagle-api `api/controllers/commentperiod.js`):
- Create copies isMet, metURL, metURLAdmin, metBannerImageUrl, dateCompleted, dateStarted, instructions, informationLabel, commentTip, milestone, openHouses, relatedDocuments and project from the body (`:275-287`). DEMI takes `projectId` (required, a project DEMI holds, else 400) for `project`, and stores `''`, `null` or `[]` for an omitted field.
- Create sets `commentIdCount` 0, `addedBy` and `dateAdded` (`:271-274`). DEMI also sets `updatedBy` and `dateUpdated`, `sourceSystem: 'demi'`, `eagleId: null` and a UUID id, and answers 201.
- Create reads staff and sysadmin, plus `public` when `isPublished` is true (`:288-298`). DEMI caps that under the project's read like the mirror does, and answers 409 when `isPublished` is true under a project that is not public. `read` in the body is ignored. The uncapped read is kept in `sources.demi.read`, which the project ACL cascade reads for a DEMI row (`aclRowsForProject`).
- PUT copies commentTip, dateCompleted, dateStarted, isMet, instructions, informationLabel, metURL, metBannerImageUrl, milestone, openHouses and relatedDocuments, and stamps `updatedBy` and `dateUpdated` (`:326-341`). It never moves `project` (`:353-355`); in DEMI a `projectId` key is a 400. DEMI keeps `dateAdded`, answers 404 for a missing row, and 400 for an empty body.
- DELETE is a hard delete (`findOneAndDelete`, `:376`). DEMI removes the row on the revision it read, after narrowing the period's comments to staff (`DELETED_CEILING`).
- Publish and unpublish act on the period's own `read` and `isPublished` only (`:400,421`, `actions.js:7,31`).
- Each write records an action (`Post`, `Put`, `Delete`, `Publish`, `Unpublish`). DEMI writes `commentPeriod.create`, `.update`, `.delete`, `.publish` and `.unpublish`, with `detail.fields` holding field names only.
- `openHouses` (objects of strings) and `relatedDocuments` (strings) are checked in the domain module, since `_schema.js` has no type for them.

Decisions:
- PUT ignores `read` and `isPublished` from the body (eagle-api recomputes `read` from them, `:338-347`). Visibility moves only through publish and unpublish, per "Where authorization lives" above.
- A staff write to an ENGAGE period (`sourceSystem: 'engage'`, `sync-out/eagle.js:327`) is a 409, `conflict` in `controllers/native/write.js`, because the refusal comes from the row's state, not the caller's role (the document level change uses 409 the same way, `document.js:1300`).
- Publish does not change the comments' own ACL, as in eagle-api. It does re-derive their stored `read` from the period's new one through `comments.setAclForPeriod`, which is what the Eagle mirror already does on every eagle-api publish (`controllers/nosql/comment-period.js`, `cascadeToComments`); without it, comments of an unpublished period stay readable through `/search?dataset=Comment`. A failed cascade answers 500 and the period stays written; a retry runs the cascade again.
- Publishing above the project's level is a 409, as for documents (`document.js:1300`), rather than a silent cap.
- Dark: a publish or update of an Eagle-mirrored row is replaced by the next Eagle push, and the project ACL cascade derives an Eagle row from `sources.eagle.read`, not from a DEMI publish.
- `nextCommentId(periodId, projectId?)` in `repositories/comment-periods.js` is the atomic counter slice 3 calls: a Cosmos patch increment conditioned on `commentIdCount` being a number, else a set to 1 conditioned on it not being one, retried three times. It answers the count after the increment, as eagle-api's `$inc` does (`comment.js:380`).

Callers to move: eagle-admin `commentperiod.service.ts:98,104,109,115,120`; DEMI sync-out lines above.

### Comments

Status: todo

Today: reads at `routes.js:293-294`, export at `routes.js:306`. Writes only as the Eagle mirror (`routes.js:247`). `POST /public/comment` has no caller and is not ported.

Target routes: `POST /comments`, `PUT /comments/:id`, `PUT /comments/:id/status`.

Business rules (eagle-api `api/controllers/comment.js:303,435,476`): to extract. Known: status transitions (pending, published, rejected, deferred) and who may set each; a comment belongs to one period; attachments used `POST /public/document` (dead).

Callers to move: eagle-admin `comment.service.ts:47,52,73,139`.

### Project groups

Status: todo

Today: `GET /groups`, `GET /groups/:id` (`routes.js:272-273`), Eagle mirror at `routes.js:251`. Members need `/groups/:id` then `/users?ids=`.

Target routes: `GET /groups/:id/members`, `POST /groups`, `PUT /groups/:id`, `DELETE /groups/:id`, `POST /groups/:id/members`, `DELETE /groups/:id/members/:userId`.

Business rules (eagle-api `api/controllers/projectGroup.js`): to extract. Known: a group belongs to one project; members are user ids.

Callers to move: eagle-admin `project.service.ts` group and member methods.

### Updates (recent activity)

Status: todo

Today: `GET /updates`, `/updates/feed`, `/updates/:id` (`routes.js:298-300`), mirror at `routes.js:245`. `README.md:401-402` and `parity-map.js:292` still say `/updates` is pending; fix that doc line in this task.

Target routes: `POST /updates`, `PUT /updates/:id`, `DELETE /updates/:id`.

Business rules (eagle-api `api/controllers/recentActivity.js`): to extract. Known: pinned updates sort first and the public feed shows the top 4 (`parity-map.js:379-382` compares the wrong sort; fix with this object).

Callers to move: eagle-admin `recent-activity.ts`.

### Project notifications

Status: todo

Today: `GET /notifications`, `/notifications/:id` (`routes.js:301-302`), mirror at `routes.js:249`.

Target routes: `POST /notifications`, `PUT /notifications/:id`.

Business rules (eagle-api `api/controllers/projectNotification.js`): to extract. Known: notification documents attach through the document routes; the eagle-admin screen builds eagle-api fetch URLs (`project-notification-documents.component.ts:463`), move those too.

Callers to move: eagle-admin `notification-project.service.ts`.

### Organizations

Status: done (b9e4685f), Dark

Today: `GET /organizations`, `/organizations/:id` (`routes.js:288-289`), mirror at `routes.js:248`. Dark: `POST /organizations` and `PUT /organizations/:id` are served under the `port: organizations` anchor in `routes.js`, rules in `src/domain/organizations.js`; eagle-admin still calls eagle-api.

Target routes: `POST /organizations`, `PUT /organizations/:id`. Pins are organizations, so these are also the only routes that create or edit a pin's organization (see Pins). eagle-api publish and unpublish have no caller; decide whether organizations keep a visibility level at all.

Guards: `POST` is `[authMiddleware, requireRole('staff', 'sysadmin')]` (eagle-api `swagger.yaml:4241`); `PUT` is `[authMiddleware, requireRole('project-system-admin', 'sysadmin', 'staff')]` (scope `project-system-admin`, `swagger.yaml:4361`). eagle-api's auth admits `sysadmin` and `staff` on every route (`api/helpers/auth.js:35-43`), so each DEMI guard carries the route's `x-security-scopes` plus those two. The route-inventory `roles` entry lists the same names.

Business rules (eagle-api `api/controllers/organization.js`):
- Create copies the body fields name, description, country, postal, province, city, address1, address2, companyType, parentCompany, companyLegal, company; none is required (`:95-109`). eagle-api leaves an omitted one unset; DEMI stores `''` (`null` for `parentCompany`). `website` is not writable.
- Create stores a `parentCompany` that is not an id as `null`, without an error (`:107`). DEMI does the same on create; on update an invalid `parentCompany` is a 400, because eagle-api's update fails the cast there.
- Create stamps `addedBy` and `updatedBy` with the caller's `preferred_username` and sets `dateAdded` and `dateUpdated` to now (`:94,97-99`).
- Create sets read to `public`, `staff` and `sysadmin` (`:110-112`). DEMI stores that `read[]` and `isPublished: true`. The `write` and `delete` arrays have no DEMI field; the route guards cover them.
- Create answers 200 (`:119`). DEMI answers 201 with a UUID id, `sourceSystem: 'demi'` and `eagleId: null`.
- Update with an id that is not an ObjectId is 400 (`:129-133`). DEMI also takes UUIDs, so any unknown id is 404.
- Update of a missing organization answers 200 with `null` (`:161,167`). DEMI answers 404.
- Update rewrites `orgName` on that organization's users (`:162-163`). eagle-api and DEMI both run it on every update; DEMI rewrites only users whose `orgName` differs from the organization name, so any later PUT repairs a failed cascade. It skips deleted users and logs a user write that fails without failing the update. The orgName cascade writes users through `users.upsert` and records no audit row per user; only the `organization.update` action is audited, matching eagle-api.
- Each write records an action, `Post` or `Put` (`:117,165`). DEMI writes the audit actions `organization.create` and `organization.update`, with `detail.fields` holding field names only.
- A body field outside the list is ignored by eagle-api. DEMI answers 400 naming it, and an empty update body is 400.

Questioned:
- PUT writes the raw `obj` (`:161` against the cleaned map at `:140-156`), so any body key reaches the row and `updatedBy` is never set. Not dropped: DEMI writes only the allowlisted fields and stamps `updatedBy` and `dateUpdated`.
- PUT resets `dateAdded` (`:144`). Not dropped: DEMI keeps the original `dateAdded`.
- Publish and unpublish (`swagger.yaml:4414,4463`) have no caller. Not ported; decision pending.

Callers to move: eagle-admin `org.service.ts:19,29`.

### Users

Status: todo

Today: `GET /users`, `/users/:id` (`routes.js:270-271`), `GET /me` (`routes.js:116`), mirror at `routes.js:250`.

Target routes: `POST /users`, `PUT /users/:id`.

Business rules (eagle-api `api/controllers/user.js`): to extract. Known: eagle-api users are Keycloak-backed; decide which fields DEMI owns versus Keycloak.

Callers to move: eagle-admin `user.service.ts:13,19`.

### CAC

Status: todo

Today: `projectCAC`, `projectCACPublished`, `cacEmail` are project fields (`src/merge/project.js:87`, `src/vis/catalog/projects.js:80-81,101`). Public sign-up and remove-member live in eagle-notify (`subscriptions.js:56`, `codes.js:7-9`). eagle-api `cac.js` never pushes to DEMI, which contradicts `docs/rbac-architecture.md:346-348`. eagle-api admin CAC handlers are removed (b072e79).

Target routes: `GET /projects/:id/cac`, create, delete, publish, unpublish, remove member. Member sign-up stays in eagle-notify.

Business rules (eagle-api `api/controllers/cac.js` at `b072e79^`): to extract. Known: sign-up is anonymous and unconfirmed in eagle-api (workspace TODO 2026-10-14 asks for a confirm step; that belongs in eagle-notify, not here).

### Extensions

Status: todo

Today: `reviewExtensions` is an array on the project, replaced whole through `PUT /projects/:id`.

Target routes: `GET /projects/:id/extensions`, `POST`, `PUT /:id`, `DELETE /:id`.

Business rules (eagle-api `api/controllers/project.js` extension handlers): to extract. Known: an extension changes the project's review timeline; check what else eagle-api recalculates on add or delete.

Callers to move: eagle-admin `project.service.ts` extension methods.

### Project

Status: todo (one gap)

Today: create, update, delete and level exist (`routes.js:159-178`). Publish through `PUT /projects/:id/level`.

Gap: eagle-api publish also switches `currentLegislationYear` (`api/controllers/project.js:776-803`). Decide whether that belongs in `setLevel` or in a separate action. Unverified: whether a later Eagle push overwrites a level that DEMI `setLevel` wrote.

Business rules: legislation year switch on publish; extract the exact condition from `project.js:776-803`.

### Search

Status: todo (one gap)

Gap: no `CACUser` dataset on `GET /search` (`parity-map.js:426`). Dropped 2026-10-14, not ported. eagle-admin still calls eagle-api `/search?dataset=Project` (`full-project.resolver.ts:29-31`); move it.

### Sitemap

Status: todo

Today: nothing in eagle-demi, eagle-edge or eao-nginx. Prod Angular `robots.txt:6` points at `https://projects.eao.gov.bc.ca/api/public/sitemap.xml`.

Target: `GET /sitemap.xml` from DEMI public projects, then repoint `robots.txt` on the prod line and the react line.

Business rules (eagle-api `api/controllers/sitemap.js:62`): which objects and URLs appear; extract.

### Materialized view status

Status: todo

Today: eagle-demi-admin `src/api/eagle.ts:32` calls eagle-api `/materialized-views/status`. DEMI has nothing. `parity-map.js:395` marks it internal to Eagle.

Target: decided 2026-10-14. Keep the eagle-api call until DataBC moves to DEMI `/reports`, then a small eagle-demi-admin slice removes it.

### Jobs (bulk export)

Status: No port until a caller appears (decided 2026-10-14).

Today: `/bulk-downloads` (`routes.js:223-227`) replaces eagle-api `/jobs` with a document id list capped at 2500 (`src/config.js:199`) and no whole-project `includeAll` export (eagle-api `export-docs-helper.js:34,44`). No caller uses eagle-api `/jobs`.

Target: add whole-project export and a list route only if someone needs them.

### Topic and valued components

Status: Dropped (decided 2026-10-14). Not ported.

Reason: no caller in eagle-admin or eagle-public, eagle-api removed their write handlers (commit b072e79), and they hold no data.

Retire: delete the eagle-api topic and vc routes and models when eagle-api's remaining handlers retire.

## Consumer cutover

Status: todo

eagle-admin still calls eagle-api for writes that DEMI already serves. Move these with their objects, or as one task:
- Document create, update, delete, publish, unpublish, feature, unfeature (`document.service.ts:91-140`).
- Document fetch URLs built from eagle-api (`document.service.ts:18-20`, used in `update-images.ts:42`, `update-image-picker.component.ts:29`, `project-documents.component.ts:790`, `project-notification-documents.component.ts:463`).
- `GET /search?dataset=Project` (`full-project.resolver.ts:29-31`).
- eagle-demi-admin `src/api/eagle.ts:22` shows the eagle-api report URL; DataBC pulls that CSV from prod (external, unverified), so keep eagle-api `/reports` until DataBC is repointed.

Document feature: DEMI has no `MAX_FEATURE_DOCS` cap (eagle-api `document.js:919-922`). Decide whether the cap is a business rule; if so add it to the document PUT.

## Retire in eagle-api (after cutover is live on test)

Status: todo

Dead now, no caller found in any repo (external callers unverified where noted):
- `topic` and `vc` routes and models
- `cac` admin handlers (`protectedPublishCAC`, `protectedUnPublishCAC`, `protectedCreateCAC`, `protectedCACDelete`, `protectedCACRemoveMember`): already removed in eagle-api (b072e79)
- `inspection` POSTs: already removed in eagle-api (b072e79). `protectedElementItemGet` remains.
- `materialized-view` `protectedRefresh`
- `POST /public/comment`, `POST /public/document`
- `GET /audit` (no handler file, 404 on prod), `POST /task`
- `job` `listJobs`
- `login` (`POST /login/token`, replaced by Keycloak)
- `pin` routes under `/project/:id/pin*` and `/public/project/:id/pin`, with the project flip

Retire after their object above is done: every handler named under "Callers to move".
