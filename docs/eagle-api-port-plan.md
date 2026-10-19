# eagle-api to DEMI port: work plan

Companion to `docs/eagle-api-port.md`. Decided 2026-10-14.

Source of truth: `docs/eagle-api-port.md` on eagle-demi origin/main 1a2977a. Rules come from eagle-api origin/develop 3723e8c, and from `b072e79^` for CAC only. eagle-admin is at origin/develop 593e910ec. The local eagle-demi `src/` matches origin/main.

## Corrections to the tracker

- The CAC admin handlers are already gone from eagle-api (b072e79); `cac.js` on origin/develop has only public sign-up and remove-member. The CAC slice takes its rules from `b072e79^`.
- No eagle-admin code reads or writes the CAC fields (git grep on origin/develop finds none), so the CAC Flip has no eagle-admin half.
- The inspection writes are also gone: `inspection.js` on origin/develop keeps only `protectedElementItemGet` (`:10`); `demiPush.inspection` (`demiPush.js:420-422`) is called only from a test.
- Slice 1 does not own `merge/project.js`: pin resolution at `merge/project.js:146-153` already maps to `{_id, name, province}` and only lacks `province` from the label read in `lists.js`.
- The pins policy goes in a new `src/domain/project-pins.js`, owned by Flip F1.

## 1. Mechanism

1. Every object follows the same path: route entry (`src/http/routes.js`), then `controllers/native/<kind>.js`, then `domain/<kind>.js`, then `repositories/<kind>.js` (tracker lines 24-31). Each object owns its own domain module, controller, repository and catalog file. All catalog files already exist (`src/vis/catalog/index.js:3-14`).
2. The router tries routes in table order, but each path compiles to an anchored regex (`src/http/router.js:95,114-133`). So `/groups/:id/members` cannot be shadowed by `/groups/:id`. New lines can sit anywhere in a section set aside for them.
3. Native routes load their controller with an inline `require` (`routes.js:283-302`). New slices do the same and never edit the lazy-accessor block at `routes.js:28-60`.
4. The one shared prerequisite is slice 0. It adds the write mechanics, the tracker work plan, and labelled anchors in the shared files. After it, slices add new files and insert lines only in places they own.
5. During Dark, Eagle stays the writer and mirror pushes overwrite DEMI (tracker line 16), so Dark slices are independent. Flips change ownership. They need the sync-out generalization (FS) and the eagle-admin write client (A0), and they run one at a time where they share a file.

## 2. Slice 0: scaffold and work plan (eagle-demi, merges first)

Who runs it: the developer working on organizations, on branch `feat-port-organizations-pins`. Slice 0 is the first PR; organizations + pins is the second PR. Wave 2 starts when the slice 0 PR merges.

- **Tracker "Work plan" section, the first commit.**
  - One row per slice: id, objects, owns, after, size, status.
  - Claim rule: a developer sets their row to `in progress (feat-port-<slice>)` in its **first push**, not at PR time. The branch named in the slice's row in the table counts as the claim (default name `feat-port-<slice>`). The tracker row is the claim; `eagle-demi/TODO.md` gets no lines.
  - Fix the stale lines: the `require-roles.js` cite at tracker line 28 becomes `:51-61`; the CAC admin handlers and inspection POSTs in the retire list are already removed.
- **New files:**
  - `src/domain/_schema.js` and `src/domain/_write.js`
  - `src/controllers/native/write.js` (`writeHandler`)
  - `test/domain/_schema.test.js`, `test/domain/_write.test.js`, `test/controllers/native/write.test.js`
  - `test/domain/layering.test.js`: a text scan of import direction that reuses `code()` from `test/helpers/router-source.js`.
  - `test/controllers/route-inventory.test.js` and `test/controllers/route-inventory/existing.js`. The existing file holds every current non-GET route with its audit action or an exemption reason.
- **Edits:**
  - `src/middleware/require-roles.js:51-61`: `requireRole(...names)` admits any one of the names.
  - `routes.js`: a "Ported objects" section before `];` at line 355, with one comment anchor per slice in section 3 order and blank lines between anchors.
  - `README.md`: the same anchors under "Parity with eagle-api" (line 369).
  - Tracker: the Layering section, and the inventory text at line 48, now one file per object.
  - eagle-demi.wiki `Architecture.md`: a new layering section. The page has none today; its only "layer" heading is "Map boundary layers" at line 219.
- **Swagger rule:** slice 0 adds no swagger anchors for objects that already have path blocks. A slice adds its methods inside the existing block, because a second path key is a duplicate YAML key and no test parses the spec. The existing blocks are:
  - `/api/users` 4028 and `/api/users/{id}` 4098
  - `/api/groups` 4127 and `/api/groups/{id}` 4197
  - `/api/organizations` 4534 and `/api/organizations/{id}` 4640
  - `/api/comment-periods` 4710 and `/api/comment-periods/{id}` 4784
  - `/api/comments` 4853 and `/api/comments/{id}` 4933
  - `/api/updates` 4960 and `/api/updates/{id}` 5133
  - `/api/notifications` 5159 and `/api/notifications/{id}` 5260
  - `/api/projects/{id}` 958 and `/api/projects/{id}/level` 1132

  Anchors exist only for new paths: members, extensions, CAC, the publish and status action paths, and sitemap.
- **Inventory test:** fails if a non-GET route from `routeChains()` has no entry. Also fails if an entry's eagle-api roles differ from the `requireRole(...)` names in that route's guard chain.
- **Reused helpers, no new copies:** `writeGuarded` (`helpers/etag-write.js:37`), `auditEvent` (`utils/audit.js:200`), `redactForAccess` and `refusedWriteKeys` (`vis/redact.js:70,121`), `serverError` (`helpers/response.js:56`), `listHandler` and `getHandler` (`controllers/nosql/mirror-reads.js:109,128`).
- **No change to `access-sql.js`.** Every `project-system-admin` holder also holds `sysadmin` (tracker, pins guard note).
- **Done when:**
  - `yarn test` passes.
  - A temporary `require('../db/cosmos-nosql')` in a file under `src/domain` makes `layering.test.js` fail.
  - Deleting one entry from `existing.js` makes `route-inventory.test.js` fail and name that route.
  - The tracker shows the Work plan table.
- Size M. After: none.

## 3. Dark slices (eagle-demi, after slice 0 unless stated)

Every slice also does all of the following:
- adds swagger methods inside the object's existing path block (or under an anchor for a new path) and a README parity line under its anchor;
- adds `test/domain/<kind>.test.js`, a new `test/controllers/native/<kind>-write.test.js` (never edits the shared test files), and `test/controllers/route-inventory/<kind>.js`;
- updates its tracker section and Work plan row;
- logs new domain, write and refusal paths through `src/utils/logger.js`, never `console.*`.

Guards are `authMiddleware` plus `requireRole(<eagle-api scopes>)`. Line numbers marked `:N` refer to eagle-api `api/swagger/swagger.yaml`.

**1. Organizations + pins.** PR 2 of the `feat-port-organizations-pins` branch. Size M. After 0.
- Routes: `POST /organizations` [staff, sysadmin] (:4241); `PUT /organizations/:id` [project-system-admin] (:4361).
- Rules:
  - Create sets read to public, staff and sysadmin (`organization.js:110-112`).
  - Update rewrites `orgName` on that org's users (`:162-163`).
- Questioned:
  - PUT writes the raw `obj` (`:161` against the cleaned map at `:140-156`).
  - PUT resets `dateAdded` (`:144`).
  - Publish and unpublish (:4414, :4463) have no caller. Kept anyway (Daniel, 2026-10-19) as `PUT /organizations/:id/publish` and `/unpublish`, guarded like the PUT; create defaults to unpublished (tracker, Organizations).
- Pins in Dark: add a label read selecting `c.id, c.name, c.province` (tracker open item a, `lists.js:77`). It has no caller until F1: `merge/project.js:146-153` resolves pins only on the seed path (`opts.orgs`, `merge/project.js:388`, built at `src/seed/sources.js:426`).
- Owns: `domain/organizations.js`, `controllers/native/organizations.js`, `repositories/lists.js`, `repositories/users.js` (the orgName cascade only), `vis/catalog/lists.js`.
- Does it own `merge/project.js`? **No.**

**2. Comment periods.** Size M. After 0.
- Routes, all [staff, sysadmin]: `POST /comment-periods` (:5434), `PUT /comment-periods/:id` (:5697), `DELETE /comment-periods/:id` (:5730), `PUT /comment-periods/:id/publish` (:5781), `PUT /comment-periods/:id/unpublish` (:5830).
- Rules:
  - Create sets `commentIdCount` 0, `addedBy` and `dateAdded`, and uses `isPublished` to decide `public` (`commentperiod.js:270-298`).
  - PUT never moves `project` (`:353-355`).
  - DELETE is a hard delete (`:376`).
  - Publish acts on the period only (`:400,421`).
- Questioned: PUT recomputes `read` from the body (`:338-347`), against tracker line 38. Proposal: PUT ignores it.
- ENGAGE rows (`sync-out/eagle.js:327`): refuse staff writes. Confirm.
- Check whether publish must cascade to comments (`setAclForPeriod` in `repositories/comments.js`).
- Adds `nextCommentId(periodId)`, an atomic increment, for slice 3.
- Owns: `domain/comment-periods.js`, `controllers/native/comment-periods-write.js` (the reads in `comment-periods.js` answer `res` themselves), `repositories/comment-periods.js`, `vis/catalog/comment-periods.js`.

**3. Comments.** Size M. After 2. It only calls the `nextCommentId` that slice 2 adds; it does not own `repositories/comment-periods.js`.
- Routes, all [staff, sysadmin]: `POST /comments` (:5009), `PUT /comments/:id` (:5159), `PUT /comments/:id/status` (:5220).
- Rules:
  - Status sets read: Published adds public; Pending, Deferred and Rejected are staff only; Reset becomes Pending (`comment.js:32-64`).
  - `commentId` comes from the period counter (`:340,378-382`).
  - `datePosted` is set only when Published (`:361`).
  - `documents` and `valuedComponents` ids are validated (`:323-337`).
  - PUT field set is `:395-406`; documents are not updated (`:407-408`).
- Questioned: PUT moves read through `eaoStatus` (`:410`).
- Owns: `domain/comments.js`, `controllers/native/comments-write.js` (the reads in `comments.js` answer `res` themselves), `repositories/comments.js`, `vis/catalog/comments.js`.

**4. Project groups + members.** Size M. After 0.
- Routes, all [project-system-admin, staff, sysadmin]: `POST /groups` (:1878), `PUT /groups/:id` (:2086), `DELETE /groups/:id` (:2054), `GET /groups/:id/members` (:2188), `POST /groups/:id/members` (:2151), `DELETE /groups/:id/members/:userId` (:2268).
- Rules:
  - A group belongs to one project (`projectGroup.js:21`), with ACL [project-system-admin, sysadmin, staff] (`:22-24`).
  - DELETE is a hard delete (`:68`).
  - Removing a member is a `$pull` (`:190-193`).
  - The members read returns `_id, displayName, email, org, orgName, phoneNumber`, sorted and paged (`:150-168`), through the existing users read.
- Questioned:
  - PUT applies the whole body (`:48`). Allow `name` only.
  - Adding members allows duplicates (`:92-95`). De-duplicate.
- Owns: `domain/groups.js`, `controllers/native/groups.js` (new; reads stay in `controllers/nosql/group.js`), `repositories/groups.js`, `vis/catalog/groups.js`.

**5. Updates (recent activity).** Size L. After 0. If it overruns, split the image cascade into 5b (`domain/update-images.js`).
- Routes, all [project-system-admin, sysadmin]: `POST /updates` (:3142), `PUT /updates/:id` (:3191), `DELETE /updates/:id` (:3222).
- Rules:
  - DELETE archives: status archived, active false, `public` pulled, images released (`recentActivity.js:118-135`).
  - POST strips `_id`, `notifiedAt` and `read`; status sets read (`:151-157`).
  - Validation, all from `updateRules.js`:
    - status is draft, published or archived (`:11`)
    - shortHeadline at most 70, summary at most 280 (`:12-13`)
    - at most 5 images; caption at most 300, credit at most 150 (`:14-16`)
    - checks at `:77-110`: plain text only, featuredImage alt, http or https engagementUrl, Corporate needs subject, otherwise project required
    - images and attachments must be public (`:142-147`)
  - On create, pinned is false (`:183`).
  - `notificationName` is null unless the type is the project notification comment period type (`:188-190`).
  - Images are published before save and reverted on failure (`:173-179,202`).
  - PUT forces `active` to a boolean (`:217`).
  - A null `publishDate` keeps the stored one (`:244-246`).
  - A pin toggle skips the document check (`:251`).
  - A concurrent edit returns 409 (`:267-278`; use the etag).
  - Images are released and republished (`:282-290`).
- Also fixes `README.md:401-402` and `parity-map.js:292,379-382`.
- Also rewrites the `updates.js` UNGATED reason in `test/helpers/access-coverage.test.js:93-96`. It says the mirror is the only caller.
- Owns: `domain/updates.js`, `controllers/native/updates.js`, `repositories/updates.js`, `vis/catalog/updates.js`, `test/helpers/access-coverage.test.js`, plus `repositories/documents.js` if image level writes need a new function.

**6. Project notifications.** Size S-M. After 0.
- Routes, all [staff, sysadmin]: `POST /notifications` (:4763), `PUT /notifications/:id` (:4817), plus `PUT /notifications/:id/publish` and `/unpublish`. eagle-api uses a `?publish=` flag (`projectNotification.js:84,104`); tracker line 38 makes it an action. Borrow the PUT guard and record the choice.
- Rules:
  - ACL is SECURE_ROLES (`:79-81`).
  - PUT replaces every field with a default (`:114-135`).
  - Publish true adds public, false removes it, absent keeps the current value (`:137-144`).
- Owns: `domain/notifications.js`, `controllers/native/notifications.js`, `repositories/notifications.js`, `vis/catalog/notifications.js`.

**7. Users.** Size S-M. After 1, because both write `repositories/users.js`.
- Routes, both [project-system-admin]: `POST /users` (:4613), `PUT /users/:id` (:4661).
- Rules:
  - Public read only when `orgName` is 'Environmental Assessment Office' (`user.js:39,92`).
  - PUT replaces fields with '' defaults (`:69-90`).
- Questioned:
  - `setPassword` (`:45`) is dead under Keycloak.
  - POST audits as 'Put' (`:49`).
  - Which fields DEMI owns versus Keycloak.
- Owns: `domain/users.js`, `controllers/native/users.js` (new), `repositories/users.js`, `vis/catalog/users.js`.

**8. Extensions.** Size M. After 0.
- Routes, all [staff, sysadmin]: `GET /projects/:id/extensions`, `POST /projects/:id/extensions` (:1933), `PUT /projects/:id/extensions/:extId` (:1964), `DELETE /projects/:id/extensions/:extId` (:1995).
- Rules:
  - type 'Extension' goes to `reviewExtensions`; anything else goes to `reviewSuspensions` (`project.js:490,522,551-552`).
  - Unknown project returns 404 (`:502-503`).
  - Update removes the old item and adds the new one (`:556-570`).
  - Nothing on the timeline is recalculated (`:486-570`).
- DEMI gives each item an id; eagle-api matched the whole object (`:525-528`).
- Owns: `domain/extensions.js`, `controllers/native/extensions.js`, `vis/catalog/projects.js`.

**9. Project publish legislation-year switch.** Size M. After 0.
- Publish [project-system-admin] (:1402).
- Rules:
  - A locked act returns 409 (`project.js:777-782`).
  - An unknown year returns 404 (`:784-787`).
  - A year with no content returns 409 (`:790-795`).
  - The concurrent-move guard (`:796-800`).
  - `currentLegislationYear` is set (`:801`).
  - Locked keys come from `helpers/constants.js:63-102`.
  - eagle-api PUT applies the same lock (`:628-631,743-754`); DEMI PUT lacks it (`controllers/nosql/project.js:108-129`).
- A held level can be narrowed by Eagle but not widened (`merge/project.js:184-189`).
- Owns: `src/domain/project-legislation.js` (new) and `src/controllers/nosql/project.js`.

**10. Sitemap.** Size S. After 0. Read-only, so no domain module.
- Route: `GET /sitemap.xml`, anonymous.
- Rules:
  - Public projects only (`sitemap.js:20-29`).
  - `lastmod` is the current legislation block's `dateUpdated`.
  - The host defaults to prod (`:9`).
  - Cached for one hour (`:10`).
  - At most 50,000 entries, truncated with a warning (`:12`).
  - Each loc is `/p/<id>` (`:46`).
- Owns: `src/controllers/sitemap.js` and its test.
- Follow-up slice 10b: repoint `robots.txt` on eagle-public `develop` and `react`, one slice per line.

**11. CAC.** Size M. After 0. Fields are already catalogued (`vis/catalog/projects.js:80-81,101`). If a catalog edit turns out to be needed, run after 8.
- Routes, all [staff, sysadmin], scopes taken from `b072e79^` swagger: `GET /projects/:id/cac`; `POST /projects/:id/cac` (:2998); `DELETE /projects/:id/cac` (:2972); `PUT /projects/:id/cac/publish` (:1795); `PUT /projects/:id/cac/unpublish` (:1844); `DELETE /projects/:id/cac/members/:memberId` (the PUT at :2941).
- Rules, from `b072e79^:api/controllers/cac.js`:
  - Create sets `projectCAC` true, `cacEmail`, and `projectCACPublished` false (`:192`).
  - Publish sets `projectCACPublished` true (`:23`); unpublish sets it false (`:50`).
  - Delete removes the members and sets `projectCAC` false and `cacMembers` [] (`:221-225`).
  - Removing a member pulls it and deletes it (`:167-169`).
  - Members sign up in eagle-notify (tracker line 222), and DEMI holds no member store. eagle-api's delete ran `CACUser.deleteMany` on its own Mongo (`b072e79^:cac.js:221`). Decided 2026-10-14: eagle-notify stays the member store and never hard-deletes. It has no staff or service route to remove members today; its only removal routes are the anonymous code-authorised `subscriptions/unsubscribe*` routes (`api/functions/subscriptions.js:228,269,295`), which soft delete with a TTL. DEMI's client `src/services/notify.js` only POSTs `/api/events`.
  - Half A (eagle-notify, own PR there, merges first): a staff or service-key route that unsubscribes one CAC member, and one that unsubscribes every member of a project's CAC. Both soft delete with the existing TTL and log through the existing logger.
  - Half B (eagle-demi, after half A is live on test): `src/services/notify.js` gains those two calls. `domain/cac.js` remove-member calls the first; CAC delete calls the second. A failed eagle-notify call fails the DEMI write.
- Owns: `domain/cac.js`, `controllers/native/cac.js`, `src/services/notify.js`. Writes go through the existing projects repository functions. Slice 11 also touches eagle-notify (half A, own PR there, merges first).

**T. Parity-map tidy.** Size S. After 4 and 5.
- Edits in `src/scripts/parity-map.js`: point group-members (`:316-320`) at `/groups/:id/members`, mark topic-vc (`:383`) dropped, and mark CACUser (`:426`) dropped (decided 2026-10-14).
- Owns: `parity-map.js` once slice 5 has merged.

**Decisions with no slice yet (decided 2026-10-14):**
- **CACUser search dataset.** Dropped. No caller: git grep on eagle-admin origin/develop finds none, and members live in eagle-notify. Slice T marks it dropped.
- **Materialized-view status.** Kept until DataBC moves to DEMI `/reports`; then a small eagle-demi-admin slice removes the call. eagle-demi-admin uses it only for BCGW export freshness (`src/api/eagle.ts:24-33`; screens `DataExport.tsx`, `Uptime.tsx`).
- **Jobs.** No port until a caller appears. No caller today.
- **Inspections.** The mirror lines `routes.js:252-254` stay as a frozen import path, with no Dark slice. eagle-api keeps no inspection write (`inspection.js:10` is the only handler), and `demiPush.inspection` has no live caller.
- **Topic and vc.** Dropped 2026-10-14.

**eagle-admin slices outside the Flips:**
- **A0. DEMI write client.** Size S. After: none.
  - Add create, update, remove and action methods to `src/app/services/demi-api.service.ts`; it only reads today (lines 24, 31, 46).
  - Update `demi-api.service.spec.ts`.
  - Check that TokenInterceptor attaches the bearer on write verbs (`demi-api.service.ts:14`).
- **A2. Project legislation read.** Size S. After: none.
  - Move `full-project.resolver.ts:29` to DEMI `GET /projects/:id`.
  - Update `full-project.resolver.spec.ts`.
  - First check that DEMI returns every `legislation_<year>` block.

## 4. Merge order and conflict rules

- **Waves:**
  - Wave 1: slice 0 (with the Work plan), A0, A2.
  - Wave 2, after slice 0 merges: 1, 2, 4, 5, 6, 8, 9, 10, 11, FS.
  - Wave 3: 3 (after 2), 7 (after 1), T (after 4 and 5).
- **Anchored files** (`routes.js`, README parity, swagger for new paths only): insert only under your own anchor, and rebase on main before push.
- **Existing swagger path blocks:** one slice per block, so there are no conflicts.
- **Route inventory:** one file per object.
- **Tracker:** each slice edits only its own section and Work plan row. Slice 0 alone edits Layering and the Work plan header.
- **Files that must not be edited in parallel:**
  - `repositories/users.js`: 1, then 7.
  - `repositories/comment-periods.js`: 2, then 3 (which only calls it).
  - `controllers/nosql/project.js`: 9, then F1, then F9.
  - `merge/project.js`: F1, then F8, then F11.
  - `parity-map.js`: 5, then T.
  - `vis/catalog/projects.js`: 8, then 11 if needed.
- **Mirror lines** (`routes.js:243-254`) are adjacent. A Flip ignores Eagle fields inside its kind's `upsertFromEagle` and never edits those lines.
- **Wiki** (one owner per page per PR):
  - `Architecture.md`: slice 0.
  - `ADR-014-Sync-Out.md` amendment: FS.
  - `Eagle-Mirror-Reference.md`: each Flip adds its kind's line under "Mirrored kinds" (line 6) and rebases before push.

## 5. Flip slices

**FS. Sync-out generalization** (eagle-demi). Size M. After 0.
- Raise `syncVersion` on every `writeRow` (`sync-out/index.js:8,72`).
- Move `enqueueQuietly` out of `src/controllers/nosql/engage-comment-period.js:141-149` into one export in `sync-out/index.js`.
- Carry `kind` in the message and in the resend at `index.js:227`.
- Re-read the row through a new `src/sync-out/kinds.js` registry. Today `run()` reads only `commentPeriods.readForWrite` (`:199`).
- Give each kind its own consumer and reconcile hook. The consumers list is at `index.js:18-20`.
- Also amends ADR-014.
- Owns: `sync-out/index.js`, `sync-out/kinds.js`, `domain/_write.js`, `src/controllers/nosql/engage-comment-period.js`, `test/sync-out/sync-out.test.js`, `test/sync-out-triggers.test.js`.
- Each Flip later adds one line to `kinds.js` and one to the consumers list.

**Every Flip** (one release window; after its Dark slice, FS and A0) does all of the following:
1. eagle-admin: moves its service calls to the `demi-api.service.ts` methods and updates the matching `.spec.ts`.
2. DEMI: stops taking the object's fields from Eagle. Embedded fields move into `DEMI_ONLY_FIELDS` (`merge/project.js:182`). A whole kind makes its `upsertFromEagle` accept the push and ignore DEMI-owned fields, answering 2xx, the same way ENGAGE-sourced comment periods treat the echo today. It never refuses with an error: eagle-api echoes every write it receives back through the mirror routes, and a rejected echo would surface as a failure of DEMI's own sync-out push. FS adds the echo test (push, echo, row unchanged, 2xx) before the first Flip.
3. Adds a consumer `src/sync-out/<kind>.js` if an Eagle reader remains.
4. Adds a reconcile check for the kind.
5. Adds a test that an Eagle push leaves the DEMI-owned fields unchanged.
6. Adds its line to `Eagle-Mirror-Reference.md`.
7. Logs refusals through `logger`.
8. Release order: DEMI tag to test, then eagle-admin to test, then compare the drift report.

**F1. Pins + organizations.** After 1, 9, FS, A0.
- DEMI half:
  - New `src/domain/project-pins.js`, called from `updateProject` in `controllers/nosql/project.js`, holds these rules:
    - `pins` replaces the stored list, de-duplicated with order kept.
    - An organization id that does not exist returns 400 listing the unknown ids.
    - `pinsPublished` adds or removes `public` on `pinsRead` for the whole list.
    - The public response is `[]` when the list is unpublished.
    - `pinsPublished` true returns 409 unless every organization in `pins` is published.
    - A change to `pins` or `pinsPublished` returns 403 unless the caller holds sysadmin, staff or project-system-admin. This keeps `demi-service-write` out of pins.
    - Read side: `getProject` and every project read that returns pins resolves the stored id list through slice 1's label read, maps `id` to `_id`, and drops unknown ids, so the response stays `{_id, name, province}` per pin (tracker line 114). Without this, reads after F1 would return bare ids, because the only resolver today is the seed path.
  - Remove the strip at `controllers/nosql/project.js:458-460` and fix its comment.
  - Move `pins`, `pinsRead` and `pinsHistory` into DEMI_ONLY.
  - Delete the pins branch at `merge/project.js:220-232` and its test at `test/merge/project.test.js:899-913`.
  - Ignore Eagle fields in `controllers/nosql/organization.js`.
  - Sync-out uses the pin routes, sending only the difference (tracker).
- eagle-admin half:
  - `project.service.ts:231-247` becomes one project PUT.
  - `pins-list.component.ts:126-136` reads `pinsPublished` from DEMI.
  - `org.service.ts:38,48` moves to DEMI.
  - The organization form gets a publish toggle on `PUT /organizations/:id/publish` and `/unpublish`.
  - Specs: `project.service.spec.ts`, `pins-list.component.spec.ts`, `pins-page.spec.ts`, `org.service.spec.ts`.

**The other Flips:**

| Flip | After | eagle-admin change and spec | DEMI seam | Sync-out |
|---|---|---|---|---|
| F2 Comment periods | 2, FS | `commentperiod.service.ts:98-120`; `commentperiod.service.spec.ts` | ignore Eagle fields in `nosql/comment-period.js`; widen `wants()` (`sync-out/eagle.js:327`) | existing consumer |
| F3 Comments | 3, F2 | `comment.service.ts:47,52,73,139`; `comment.service.spec.ts` | ignore Eagle fields in `nosql/comment.js` | new |
| F4 Groups | 4, F8 | `project.service.ts:253-271`; `project.service.spec.ts` | ignore Eagle fields in `nosql/group.js` | if Eagle reads them |
| F5 Updates | 5 | `recent-activity.ts:42,52,73`; `recent-activity.spec.ts` | ignore Eagle fields in `nosql/update.js` | yes |
| F6 Notifications | 6 | `notification-project.service.ts:61,67`; its spec | ignore Eagle fields in `nosql/notification.js` | yes |
| F7 Users | 7 | `user.service.ts:56,62`; `user.service.spec.ts` | ignore Eagle fields in `nosql/user.js` | if Eagle reads them |
| F8 Extensions | 8, F1 | `project.service.ts:217-226`; `project.service.spec.ts` | `reviewExtensions` and `reviewSuspensions` into DEMI_ONLY | project consumer |
| F9 Project writes | 9, F4 | `project.service.ts:188-213`; `project.service.spec.ts` | project-wide ownership | project consumer |
| F10 Documents | FS, A0 | `document.service.ts:18-20,91-140`, `project-documents.component.ts:790`, `project-notification-documents.component.ts:463`, all to `/documents/:id/download` (`routes.js:196`); `document.service.spec.ts` | ignore Eagle fields in the document mirror; decide on MAX_FEATURE_DOCS (eagle-api `document.js:919-922`) | yes |
| F11 CAC | 11, F8 | none: no eagle-admin caller | `projectCAC`, `projectCACPublished` and `cacEmail` into DEMI_ONLY | none. eagle-api has no write path for the CAC fields: `project.js:79-82` is the GET `fields=` allowlist (`tagList`, `:9`), `protectedPut` (`:602`, field map about `:662-690`) carries no CAC field, and b072e79 removed the CAC write routes. If an Eagle reader (eagle-public Angular line) needs the fields, Daniel decides on an eagle-api write path. |

## 6. Retire (last)

- **eagle-api, dead now, one slice:** topic and vc; materialized-view `protectedRefresh`; `POST /public/comment` and `/public/document`; `POST /task`; `job listJobs`; `login`.
- **Already removed in eagle-api:** the CAC admin handlers (b072e79) and the inspection writes.
- **Kept until DataBC moves:** `/reports`.
- **eagle-api, one slice per object:** delete the handlers under "Callers to move", the pin routes and the extension routes. A retire PR may merge once that object's Flip is live on test. The retire **tag may reach prod only after that Flip is live on prod**. This is stricter than tracker line 20; record the change there.
- **DEMI final retire:** delete the mirror lines and each kind's `upsertFromEagle`, only for kinds whose Flip is live on prod. Inspections (`routes.js:252-254`) stay as a frozen import path (decided 2026-10-14).

Risks:
- **Prod releases, each needs its own approval from Daniel, from a tag verified on test, never a branch:**
  - every DEMI release that carries Dark slices;
  - A2's eagle-admin release;
  - each Flip window: the DEMI tag, then eagle-admin;
  - slice 10b's eagle-public `develop` and `react` releases;
  - each eagle-api retire tag, which also waits until its Flip is live on prod;
  - the DEMI final retire.
- **Echo loop after a Flip:** sync-out writes to eagle-api, then eagle-api pushes the write back through the mirror. The mirror must accept and ignore it (Flip step 2); a refusal would fail the original write on the eagle-api side. FS verifies how eagle-api handles a failed push and adds the echo test before the first Flip.

Not checked:
- Which eagle-api reads the Angular eagle-public prod line still makes. This decides whether each object needs sync-out.
- Whether DEMI returns every legislation block (A2).
- Whether TokenInterceptor attaches the bearer on write verbs (A0).
- Whether sitemap URLs should carry the Eagle id or the DEMI id.
- How `commentIdCount` is stored in DEMI.
- Whether eagle-public reads the CAC fields.
