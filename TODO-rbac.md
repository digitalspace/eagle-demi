# TODO — attribute-level access control

**Goal: every field of every entity classified and redacted per caller level, per
`docs/rbac-architecture.md`.** `TODO.md` (prod cutover) retired 2026-08-27 (#198); this is the only open tracker.
Rules: append work here before doing it, strike wrong lines with a reason, date every
measurement, `node --test` per new/changed endpoint, swagger same PR, `src/utils/logger.js` only,
ask before commit. **Merging is deploying** on test: every unit leaves anonymous responses
byte-identical unless its line says otherwise. Line cites are at `5c6ce05` (2026-08-27).

Merge order: U1-U5 (Phase 0) then U6-U11 (Phase 1) then P2-1..P2-5, P3-1..P3-5, P4-1..P4-5.
U5 (Key Vault) may slide behind U6-U11; nothing depends on it.

## Facts — verified 2026-08-27 at `5c6ce05`

1. Anonymous `GET /api/projects` on test returns `projectLead`, `projectLeadEmail`,
   `responsibleEPDEmail`, `eaoMember`, `cacEmail`, plus Cosmos `_rid`, `_self`, `_ts`,
   `_attachments`. `eagle-public` renders the staff fields anonymously from eagle-api, so this is
   current product behaviour. Whether it is policy is EAO question 2.
2. `DEMI_ALLOWED_CLIENTS` is set in every bicepparam and enforced by `isAllowedClient`
   (`src/helpers/auth.js`): a verified token from an unlisted `azp` gets 401. `src/config.js`
   throws unless `ENVIRONMENT` is `dev` or `local`. That throw does not boot-loop the app —
   `api/index.js:205` requires `src/app` inside the request handler, so the Function App starts and
   answers 500 on every request instead. `aud` is verified when `SSO_AUDIENCE` is non-empty.
3. `demi-admin`, `demi-service-read` exist only in DEMI constants, not in realm `eao-epic`.
4. `upsertFromEagle` (`src/controllers/nosql/project.js:280`) and `seed-nosql.js:403` replace
   whole items; only `sources` is carried.
5. `src/merge/project.js:22` and `src/seed/transform.js:16` each hold a 3-role list equal to
   `ADMIN_ROLES` (`access-sql.js:42`), not `SECURE_ROLES` (5 roles). They build stored `read[]`.

## External dependencies (owner and date before the unit that needs them)

- [ ] Realm roles `demi-vis-0`, `demi-vis-1`, `demi-vis-2`, `demi-vis-3` in `eao-epic` (`test.loginproxy.gov.bc.ca`). Claude scripts against secret `demi-keycloak-admin` in `6cdc9e-test`; Daniel fires the mutation. Owner: ______  Requested: ______  Created: ______
- [ ] Realm role `demi-classify` in `eao-epic`, same mechanism. Blocks P3-2, P3-3. Owner: ______  Requested: ______  Created: ______
- [ ] `demi-service-write` realm role (ADR-007) exists before `demi-classify` is created. Owner: ______  Confirmed: ______
- [ ] EAO question 1 (nested vs lateral groups). Blocks all of Phase 3. Owner: Daniel. Asked: ______  Answered: ______
- [ ] EAO question 2 (lead/EPD names and emails public by policy). Gates the P2-1 tightening list. Asked: ______  Answered: ______
- [ ] EAO questions 3 and 4 (`forMAEE = Y` implies `maxVis >= 3`; `project_tracking_number` and `epic_guid` ceilings). Asked: ______  Answered: ______
- [ ] Entra app registration for DEMI API, app roles named exactly as the realm roles, issuer and audience recorded in the wiki. Blocks P4-3. Owner: ______  Requested: ______  Delivered: ______

---

# Phase 0 — decisions and token hardening

## U1 — chore/rbac-adr-and-questions (docs + wiki only)

- [ ] Send EAO the four questions in `docs/rbac-architecture.md:155-166`. Owner: Daniel. Answers
      land in that doc (§3), not in `TODO-rbac.md`.
- [ ] Wiki `ADR-010-Attribute-Level-Access-Control.md` (ADR-009 is Track Feed): Status Accepted;
      Context / Decision / Consequences; links `docs/rbac-architecture.md`.
- [ ] `TODO-rbac.md`: tick the ADR line, date it.
- Tests: none (no code).
- Acceptance: `yarn test` unchanged green.

---

## U2 — chore/merge-secure-roles-single-source

`src/merge/project.js:22` `SECURE_ROLES = ['sysadmin','staff','demi-admin']` is byte-equal to
`ADMIN_ROLES` in `src/helpers/access-sql.js:42`, NOT to `SECURE_ROLES` there
(`access-sql.js:30-32`, 5 entries). This constant BUILDS stored `read[]`
(`merge/project.js:192`), so importing the 5-entry list rewrites every project ACL on the next
push/seed and breaks `test/scripts/close-unpublished-track-projects.test.js:181`.

- [x] `src/merge/project.js:22`: delete the literal; `const { ADMIN_ROLES } = require('../helpers/access-sql');`
      and `const SECURE_ROLES = ADMIN_ROLES;`. Keep the export at `merge/project.js:405` (consumers:
      `test/scripts/close-unpublished-track-projects.test.js:14,80`).
- [x] Comment above it: naming it `SECURE_ROLES` here is historical; widening it to
      `access-sql.SECURE_ROLES` is an ACL data change, not a refactor.
- [x] `src/seed/transform.js:16` holds a THIRD copy — same swap, same reason (`transform.js:33,199`,
      exported at `:215`).
- [x] `docs/rbac-architecture.md` §2 item 12 says "removed in favour of the one in access-sql.js" —
      amend to name `ADMIN_ROLES`, with the widening consequence, or leave §2 and record the
      deviation. Decide in this PR, do not leave both readings.
- Tests: `test/merge/project.test.js`
  - [x] `merge ACL constant is the same object access-sql exports` — asserts
        `require('../../src/merge/project').SECURE_ROLES === require('../../src/helpers/access-sql').ADMIN_ROLES`.
        Fails if someone re-inlines a literal.
  - [x] `an unpublished merge writes exactly three roles` — literal
        `deepStrictEqual(resolveProjectAcl(null), ['sysadmin','staff','demi-admin'])`. Fails if the
        import is switched to the 5-entry `SECURE_ROLES`. Expected value is written out, not read
        from either constant.
- Acceptance: `node --test test/merge/project.test.js test/seed/transform.test.js test/scripts/close-unpublished-track-projects.test.js`, then `yarn test`. Anonymous output unchanged (`read[]` never leaves — `src/repositories/projects.js:144`).

---

## U3 — fix/auth-require-allowed-clients

Doc §2 item 10. Code and app setting ship together.

- [x] `src/config.js:174`: keep `allowedClients` parsing. Add at the end of the file, before
      `module.exports`: throw when `environmentName` (`config.js:170`) is `test` or `prod` and
      `allowedClients.length === 0`. Message names `DEMI_ALLOWED_CLIENTS`. Dev/local unchanged.
- [x] `src/helpers/auth.js:77-92`: replace `applyClientAllowlist(decoded)` with
      `isAllowedClient(decoded) => boolean` — true when the list is empty (dev), true when
      `decoded.azp || decoded.client_id` is listed, false otherwise. Delete the demote arm
      (`auth.js:84-91`) and the now-unused `SECURE_ROLES` import (`auth.js:10`). One behaviour, not
      two. TODO-rbac line "Demote arm, if kept for dev" is answered: not kept.
- [x] `src/helpers/auth.js:245-247`: on false, `logger.warn` the azp and
      `onFailure(401, 'Unauthorized. Client is not permitted to call this API.')`; on true keep the
      existing `logger.info` line and `onSuccess(decoded)`.
- [x] `src/helpers/auth.js:257`: export `isAllowedClient`, drop `applyClientAllowlist`.
- [x] `azure/modules/api-web-app.bicep`: new `param allowedClients string = ''` beside
      `keycloakClientId` (`:142-143`); new entry `{ name: 'DEMI_ALLOWED_CLIENTS', value: allowedClients }`
      in the `appSettings` array (`:240`) inside the Keycloak block (`:456-478`).
- [x] `azure/main.bicep`: `param allowedClients string` (no default — unset must fail the build,
      same rule as `adminApiKey` at `:59-62`); pass `allowedClients: allowedClients` in the
      `apiWebApp` module params (`:358-393`, beside `keycloakClientId:` at `:373`).
- [x] `azure/main.test.bicepparam`: `param allowedClients = '<real azp list>'`. Measure first:
      decode one token from the DEMI frontend and one from eagle-admin-console against
      `test.loginproxy.gov.bc.ca` realm `eao-epic` and read `azp`. A guessed value 401s every staff
      user.
- [x] `azure/main.prod.bicepparam`: same, for `loginproxy.gov.bc.ca`. Prod's callers today are
      eagle-api's push (API key, unaffected) and eagle-public (anonymous, unaffected).
- [x] `src/swagger/swagger.yaml`: under `components.securitySchemes.BearerAuth`, add that a verified
      token whose `azp` is not in `DEMI_ALLOWED_CLIENTS` is rejected 401.
- Tests: rename `test/helpers/client-allowlist.test.js` cases to the new function.
  - [x] `empty allowlist admits any client` — `isAllowedClient({azp:'anything'})` true with
        `config.allowedClients = []`. Fails if the default flips to deny.
  - [x] `a listed azp is admitted` / `an unlisted azp is refused` — literal true/false.
  - [x] `client_id is accepted as an alias for azp` — keeps `client-allowlist.test.js:64-69`.
  - [x] `a token with no azp is refused when the list is on` — false.
  - [x] `unlisted client gets 401, not a demoted identity` — drive `authenticate()` with a stubbed
        `jwt.verify` (pattern: `test/middleware/auth.test.js:96-110`), assert `onFailure` ran with
        401 and `onSuccess` did not. Fails if the demote arm is restored.
  - [x] `test/controllers/config.test.js` (or new `test/config-required.test.js`):
        `ENVIRONMENT=test with no DEMI_ALLOWED_CLIENTS refuses to boot` — set env, `delete
        require.cache[require.resolve('../src/config')]`, `assert.throws(() => require('../src/config'))`.
        And `ENVIRONMENT=dev boots with none`. Fails if the guard is dropped or applied to dev.
  - [x] `test/azure/main-bicep-wiring.test.js`: `main.bicep passes allowedClients into the API
        module` (asserts both the `param` line and the `allowedClients: allowedClients` line, same
        shape as `:27-32`); `both param files set a non-empty allowlist` — regex
        `/^param allowedClients = '([^']+)'$/m` on each file, assert capture length > 0. Fails on the
        deploy that would leave the app answering 500 on every request.
- Acceptance: `node --test test/helpers/client-allowlist.test.js test/azure/main-bicep-wiring.test.js`,
  then `yarn test`. After deploy: `curl -s -o /dev/null -w '%{http_code}' https://demi-api-test.azurewebsites.net/api/projects` → `200`
  (anonymous path untouched); a Bearer token from an unlisted client → `401`.
- Deployment (test first, prod after a week):
  - [x] (test 2026-08-27, `infra-f688bd7-224457` Succeeded) App setting and code in ONE deploy is not possible across two pipelines — so **infra first**:
        `MINIO_ACCESS_KEY=… MINIO_SECRET_KEY=… ADMIN_API_KEY=… DOCLING_API_KEY=… az deployment group create -g c4b0a8-test-rg --subscription 7897ceb1-9a86-4639-87d7-7f9ff67142b3 -f azure/main.bicep -p azure/main.test.bicepparam`
        (or `./scripts/deploy-infra.sh test --live`). The setting is inert for the running build.
  - [x] (test 2026-08-27, #199 merged `3707bee`) Then merge, which is deploying on test (CI `azure-deploy-staging-api`). Boot guard sees the
        setting already present.
  - [ ] Prod: `MINIO_*=… ADMIN_API_KEY=… DOCLING_API_KEY=… ./scripts/deploy-infra.sh prod --what-if`,
        review, then `CONFIRM_PROD=yes ./scripts/deploy-infra.sh prod --live`.
  - [ ] Verify: `GET /api/deployments/latest` status 4, then the two curls above. Test 2026-08-27:
        anonymous `/api/projects` 200 and byte-identical. The unlisted-client 401 is NOT shown live —
        a malformed Bearer 401s at `jwt.verify` before the allowlist runs. It needs a signed token
        from a client other than `eagle-admin-console` (e.g. `epic-admin` client credentials);
        until then the guard is proved only by `test/helpers/client-allowlist.test.js`.
  - [ ] Rollback: revert the code commit and redeploy the API. The app setting alone is harmless —
        the old build ignores `DEMI_ALLOWED_CLIENTS` only if it is empty, so leave the setting in
        place and revert code, never the reverse. An empty setting on the new build is not a boot
        loop: `src/app` is required per request, so the app starts and 500s every call.

---

## U4 — fix/auth-verify-audience

- [ ] Measure first, record in the PR: `aud` on a live token per realm. Keycloak public clients
      commonly emit `account`, not the client id. A wrong value 401s everyone.
- [x] `src/config.js`: add `ssoAudience: process.env.SSO_AUDIENCE || ''` beside `ssoIssuer`
      (`config.js:181`). Empty = not enforced, so local and dev keep working.
- [x] `src/helpers/auth.js:225-228`: add `...(config.ssoAudience ? { audience: config.ssoAudience } : {})`
      to the `jwt.verify` options object (`algorithms`, `issuer` stay).
- [x] `azure/modules/api-web-app.bicep`: `param ssoAudience string = ''`; app setting
      `{ name: 'SSO_AUDIENCE', value: ssoAudience }` next to `SSO_ISSUER` (`:472-478`).
- [x] `azure/main.bicep`: `param ssoAudience string = ''`, passed into the module.
- [ ] `azure/main.test.bicepparam` and `azure/main.prod.bicepparam`: `param ssoAudience = '<measured>'`.
- [x] `src/swagger/swagger.yaml`: `BearerAuth` description — token `aud` must match the configured
      audience.
- Tests: `test/middleware/auth.test.js`
  - [x] `jwt.verify is given the configured audience` — stub `jwt.verify`, capture `options`, assert
        `options.audience === 'demi-test-aud'` after setting `config.ssoAudience`. Fails if the
        option is dropped.
  - [x] `no audience configured means no audience option` — assert `'audience' in options === false`.
        Fails if someone hardcodes a default in `auth.js`.
  - [x] `issuer and algorithms are still pinned` — literal `['RS256']` and `config.ssoIssuer`.
  - [x] `test/azure/main-bicep-wiring.test.js`: `both param files pin ssoAudience` (declaration
        present; the value stays empty until `aud` is measured).
- Acceptance: `node --test test/middleware/auth.test.js`, `yarn test`. After deploy, a real staff
  login through the DEMI frontend still reaches an authenticated route (401 here is the failure
  mode to watch). Same deploy ordering and rollback as U3.

---

## U5 — chore/admin-api-key-keyvault

No Key Vault exists in this subscription's DEMI template (`azure/main.bicep:19` says so). This unit
creates one; it is the largest Phase 0 item and merges alone.

- [ ] New `azure/modules/key-vault.bicep`: vault `demi-kv-${environmentName}`, RBAC authorization,
      `publicNetworkAccess: 'Disabled'` if the landing zone demands it, secret `admin-api-key` from
      `@secure() param adminApiKey`, role assignment `Key Vault Secrets User`
      (`4633458b-17de-408a-b874-0445c86b69e6`) to `identityPrincipalId`. Outputs
      `adminApiKeySecretUri`.
- [ ] `azure/main.bicep`: module `deploy-key-vault` after `identity`, passing
      `identity.outputs.principalId` (`azure/modules/identity.bicep:26`) and `adminApiKey`
      (`main.bicep:61`); pass `adminApiKeySecretUri: keyVault.outputs.adminApiKeySecretUri` into
      `apiWebApp` (`main.bicep:358-393`).
- [ ] `azure/modules/api-web-app.bicep:386-389`: `ADMIN_API_KEY` value becomes
      `'@Microsoft.KeyVault(SecretUri=${adminApiKeySecretUri})'`; keep `param adminApiKey` only if
      the vault module still needs it via main (it does — main writes the secret, the app reads it).
- [ ] `docs/prod-flip-runbook.md`: name the rotation owner and the sequence (OpenShift
      `demi-app-secrets` → vault secret new version → app restart). `docs/FUTURE.md:23-27` already
      describes the hand sequence; link it.
- Tests: `test/azure/main-bicep-wiring.test.js`
  - [ ] `the API app reads ADMIN_API_KEY through a Key Vault reference` — assert
        `/@Microsoft\.KeyVault\(SecretUri=/` appears in the `ADMIN_API_KEY` setting and that no
        `value: adminApiKey` line remains for it. Fails on a revert to a plain setting.
  - [ ] `the app identity is granted Key Vault Secrets User` — assert the role GUID string is in
        `key-vault.bicep`. Fails if the assignment is dropped (the app would 401 on startup key
        reads and the break-glass credential would silently be empty).
- Acceptance: `az bicep build -f azure/main.bicep` exits 0; `./scripts/deploy-infra.sh test --what-if`
  shows the vault + secret + role assignment and no change to any other app setting; then `--live`.
  Verify `curl -H "X-Api-Key: $ADMIN_API_KEY" https://demi-api-test.azurewebsites.net/api/db/stats`
  → 200 after the app restarts.
- Rollback: redeploy the previous template (plain `ADMIN_API_KEY` app setting, value re-supplied
  from OpenShift `demi-app-secrets`). Reference resolution failures show as a literal
  `@Microsoft.KeyVault(...)` string in the setting and a 401 on every admin call — check before
  leaving.

---

# Phase 1 — level plumbing and projects redaction

## U6 — feat/vis-level

- [x] New `src/vis/level.js`: `ROLE_LEVELS` map and `levelFromRoles(roles) => 0..4`, lowest wins,
      unknown role contributes nothing, empty/absent gives 4. Include `compliance`
      (`src/controllers/nosql/api-key.js:31` makes it grantable). Initial map per the source design:
      `sysadmin` 0, `demi-admin` 0, `staff` 2, `demi-service-read` 2, `demi-service-write` 2,
      `compliance` 2 `?`, `public` 4. Levels 1 and 3 have no role until EAO question 1 (doc §3) is
      answered; do not invent `demi-vis-*` names here.
- [x] `src/helpers/access-sql.js:109-135` `resolveAccess`: add `level: levelFromRoles(roles)` to all
      three returned objects.
- [x] `src/helpers/access-sql.js:201-203` `systemAccess`: add `level: 0`.
- [x] Export `levelFromRoles`, `ROLE_LEVELS` from `src/vis/level.js`; no change to any caller.
- Tests: new `test/vis/level.test.js`
  - [x] `a role table entry maps to its level` — literal pairs, e.g. `levelFromRoles(['staff'])===1`.
  - [x] `the lowest level of several roles wins` — `['public','sysadmin'] === 0`.
  - [x] `an unknown role does not grant a level` — `['not-a-role'] === 4`.
  - [x] `no roles at all is anonymous` — `[] === 4`, `undefined === 4`.
  - [x] `compliance is in the table` — `ROLE_LEVELS.compliance !== undefined`; doc §2 item 12.
  - [x] In `test/helpers/access-sql.test.js`: `resolveAccess carries a level` (anonymous req → 4;
        `{user:{realm_access:{roles:['sysadmin']}}}` → 0) and `systemAccess is level 0`.
        All expectations are literals, never `levelFromRoles(...)` re-run.
- Acceptance: `node --test test/vis/level.test.js test/helpers/access-sql.test.js`, `yarn test`.
  No response changes.

---

## U7 — feat/vis-catalog-projects

Catalog only; nothing reads it yet. Every key below is emitted today by `mergeTrackProject`
(`src/merge/project.js:228-271`) or `mergeEagleOnlyProject` (`:294-315`), or written by a
non-merge writer, and is in the anonymous response today unless noted — `publicView`
(`src/repositories/projects.js:141-158`) strips only `sources`, `read`, `_etag`.

`?` = public rendering by eagle-public NOT confirmed; a human resolves it before merge.
Confirmation source used: `eagle-public/src/app/services/api.ts:263-320` (the field list
eagle-public asks eagle-api for) and `src/controllers/search.js:374-415` (what DEMI itself already
returns anonymously to eagle-public through `/api/search`).

- [x] New `src/vis/catalog/projects.js`: `module.exports = { <key>: { defaultVis, maxVis } }`,
      dotted keys allowed one level, no predicates this phase (doc §2 item 7).

Structural / identity — `defaultVis: 4, maxVis: 4`:
- [x] `id` · `trackProjectId` · `eagleId` · `sourceSystem` · `isPublished` · `updatedAt`
- [x] `createdAt` (`src/controllers/nosql/project.js:155`) `?` — only rows created through POST
      carry it
- [x] `centroid` (`merge/project.js:257`)

Track-precedence targets (`merge/project.js:32-42`) — `defaultVis: 4, maxVis: 4`:
- [x] `name` · `description` · `projectType` · `proponentName` · `projectState` · `abbreviation` ·
      `address`
- [x] `projectSubType` `?` (Track-only; not in eagle-public's field list)
- [x] `isActive` `?` (Track record flag; not rendered)

Eagle-only fields (`merge/project.js:48-57`, 31 entries) — `defaultVis: 4, maxVis: 4` unless marked:
- [x] `eacDecision` · `decisionDate` · `currentPhaseName` · `legislation` · `substitution` ·
      `CEAAInvolvement` · `projectLead` · `responsibleEPD` · `eaoMember` · `sector` · `commodity` ·
      `region` · `fedElecDist` · `provElecDist` · `projectCAC` · `projectCACPublished` ·
      `overallProgress` · `code`
- [x] `projectLeadEmail` · `responsibleEPDEmail` · `cacEmail` — `defaultVis: 4, maxVis: 4` today.
      Move to `defaultVis: 2` ONLY with EAO sign-off (doc §2 item 3, §3 question 2). Without
      sign-off they stay at 4; leave a one-line comment naming the question.
- [x] `complianceLead`, `execProjectDirector` — `defaultVis: 2, maxVis: 4` per doc §2 item 3.
      **This is a byte change** on any row that carries a value. Before merging, count rows:
      `SELECT VALUE COUNT(1) FROM c WHERE IS_DEFINED(c.complianceLead)` over `projects` (via the
      container tunnel, README). If the count is 0 the change is byte-identical; if not, record the
      count and the deviation in `TODO-rbac.md`.
- [x] `eaStatus` `?` · `phaseHistory` `?` (on eagle-public's model at
      `eagle-public/src/app/models/project.ts:37` but NOT in its request field list) ·
      `legislationYear` `?` · `review180Start` `?` · `review45Start` `?` · `reviewExtensions` `?` ·
      `reviewSuspensions` `?` · `nameSearchTerms` `?` — all `defaultVis: 4, maxVis: 4` to keep
      today's bytes; the `?` is about whether they SHOULD be 4.

Written by jobs, not by the merge — `defaultVis: 4, maxVis: 4`:
- [x] `regionalDistrict` · `municipality` · `electoralDistrict`
      (`src/repositories/projects.js:235-241`; also query params, `projects.js:27-35`)
- [x] `sources.wildfire` — dotted key, `defaultVis: 4, maxVis: 4`, still gated by
      `ENRICHMENT_SOURCES` (`src/config.js:61`; prod empty)

Never public — `defaultVis: 0, maxVis: 0`:
- [x] `read` (doc §2 item 8; `isPublished` is derived from it in the redactor)
- [x] `sources` (the parent object; only the dotted child above is publishable)
- [x] `vis` (does not exist yet; catalogued so it can never leak — doc §2 item 8)
- [x] `_rid`, `_self`, `_attachments`, `_ts` — Cosmos system fields. **These are in the anonymous
      response today** (`publicView` does not strip them). Setting them to 0 removes them; no
      consumer found in `eagle-public/src/app` or `frontend/src`. Stated deviation from
      byte-identical; record it in `TODO-rbac.md` with the grep that found no consumer.

Writer-visible only:
- [x] `_etag` — `defaultVis: 2, maxVis: 2` (doc §2 item 8). Today `publicView` strips it entirely,
      so level 2 gaining it is a widening for writers only; note it in the PR.

- [x] `src/vis/catalog/index.js`: `catalogFor(entity)` — throws `Error` on an unknown entity
      (doc §2 item 4). One entity registered: `projects`.
- Tests: new `test/vis/catalog-completeness.test.js`
  - [x] `every key mergeTrackProject emits is catalogued` — build a hand-written Track fixture with
        every `TRACK_PRECEDENCE` source field populated and a hand-written Eagle fixture with every
        `EAGLE_ONLY_FIELDS` name populated (literal objects in the test, not derived from the
        constants), call `mergeTrackProject`, assert
        `Object.keys(out).filter(k => !(k in catalog))` is `[]`. Fails when a field is added to the
        merge without a catalog entry.
  - [x] `every key mergeEagleOnlyProject emits is catalogued` — same, via
        `mergeEagleOnlyProject`.
  - [x] `the fixtures actually populate every merge constant` — assert every name in
        `EAGLE_ONLY_FIELDS` and every `TRACK_PRECEDENCE[1]` appears as a key of the fixture. Without
        this the test above can pass vacuously.
  - [x] `the job-written fields are catalogued` — literal list
        `['regionalDistrict','municipality','electoralDistrict','createdAt','sources.wildfire']`.
  - [x] `no upstream field is named vis` — assert `'vis' not in` either merge output.
  - [x] `every entry has both bounds and defaultVis <= maxVis` — over `Object.entries(catalog)`.
  - [x] `read, sources and vis can never be seen` — literal `maxVis === 0` for the three names.
  - [x] `catalogFor throws on an unknown entity` — `assert.throws(() => catalogFor('widgets'))`.
- Acceptance: `node --test test/vis/catalog-completeness.test.js`, `yarn test`. No runtime change.

### U7 recorded deviations from byte-identical

- `_rid`, `_self`, `_attachments`, `_ts` at `maxVis: 0` remove four keys from the anonymous project
  response. No consumer:
  `grep -rEn "\b_rid\b|\b_attachments\b|\b_ts\b|\._self\b" eagle-public/src/app eagle-demi/frontend/src`
  returns nothing.
- `complianceLead` and `execProjectDirector` at `defaultVis: 2` drop those keys for anonymous
  callers on any row that carries a value. No row does: measured 2026-08-27 on test, anonymous
  `GET /api/projects?pageSize=100` (no continuation token returned; 100 rows = full anonymous set):
  0 rows carry `complianceLead`, 0 carry `execProjectDirector`, 0 uncatalogued keys.
- `_etag` at `defaultVis: 2` is a WIDENING for level 2 and below: `publicView` strips it from every
  caller today. Also has no call site until U9.

---

## U8 — feat/vis-redact

Engine only; still no call sites.

- [x] New `src/vis/redact.js`:
      `visible(level, effVis)` — the ONLY scalar comparison (doc §2 item 11), `level <= effVis`;
      `effectiveVis(entry, dial)` — `clamp(dial, 0, entry.maxVis)` when the dial is an integer in
      range after clamping, else `entry.defaultVis` (invalid dial → `defaultVis`, doc §1);
      `redactForAccess(entity, doc, access)` — `catalogFor(entity)` FIRST for every caller including
      level 0 (doc §2 item 4); missing `access.level` treated as 4; reads `doc.vis` as the dial map;
      uncatalogued key removed; dotted keys descended only when listed; `isPublished` derived from
      `Array.isArray(doc.read) && doc.read.includes('public')`, falling back to `doc.isPublished === true`
      when `read` is absent (same rule as `src/repositories/projects.js:146-150`);
      `redactAllForAccess(entity, docs, access)`.
      No predicates this phase (doc §2 item 7) — but `entry.when` present must throw at module load
      so a half-shipped predicate cannot silently pass.
- Tests: new `test/vis/redact-matrix.test.js` — all expectations literal.
  - [x] `a level 4 caller sees the public fields and not the ACL` — hand-built stored row, assert
        `name` present, `read`/`sources`/`_rid` absent.
  - [x] `level 0 runs the same loop` — assert `redactForAccess('projects', row, {level:0})` still
        drops `read` (maxVis 0). Fails on an `if (level === 0) return record` shortcut.
  - [x] `an unknown entity throws for every level` — `assert.throws` at level 0 and level 4.
  - [x] `a missing level is treated as anonymous` — `{}` access behaves as level 4.
  - [x] `a dial restricts below defaultVis` — row with `vis: { projectLead: 1 }`, level 4 caller
        does not see `projectLead`, level 1 does.
  - [x] `a dial cannot exceed maxVis` — `vis: { read: 4 }`, level 4 caller still does not see
        `read`.
  - [x] `an invalid dial falls back to defaultVis` — `vis: { name: 'yes' }` and `vis: { name: -3 }`
        both leave `name` visible at 4.
  - [x] `isPublished is derived, not copied` — row `{ read: ['public'], isPublished: false }` →
        `isPublished === true`; row `{ read: ['staff'], isPublished: true }` → `false`.
  - [x] `the dotted enrichment key survives while its parent does not` — row with
        `sources: { track: {...}, wildfire: { fires: 2 } }` → output `sources` is
        `{ wildfire: { fires: 2 } }` exactly.
  - [x] `visible() is the only comparison` — read `src/vis/redact.js` source with
        `test/helpers/router-source.js` `code()` and assert `<=` / `>=` against a level appears once.
        Falsifiable: inlining a second comparison fails it.
- Acceptance: `node --test test/vis/redact-matrix.test.js`, `yarn test`. No runtime change.

### U8 deviations from the unit spec

- `level 0 runs the same loop` does NOT assert that `read` is dropped. `visible(0, 0)` is true, so
  level 0 sees every field — doc §2 item 4 states exactly that, and the unit spec contradicts it.
  Making level 0 drop `maxVis: 0` fields needs a second comparison, which correction 11 forbids.
  The test keeps its ratchet against an `if (level === 0) return record` shortcut by asserting the
  uncatalogued key is still removed and `isPublished` is still derived at level 0.
- The dial map is withheld at levels 1-4 rather than at every level, for the same reason.
- An out-of-range integer dial (`-3`, `9`) falls back to `defaultVis` instead of clamping, per the
  unit's own `an invalid dial falls back to defaultVis` test. Only `0..4` are valid dial values.
- `sources.wildfire` is NOT gated on `ENRICHMENT_SOURCES` in the redactor; `publicView` gates it
  (`src/config.js:61`, empty in prod). U9 replaces `publicView`, so U9 must carry that gate or
  prod starts publishing `sources.wildfire` the moment the container holds one.

---

## U9 — feat/vis-redact-projects

The behaviour change. Keep the diff to the projects entity.

- [x] `src/controllers/nosql/project.js:87` — `items.map(p => redactForAccess('projects', p, access))`.
- [x] `:103` — `redactForAccess('projects', project, access)`.
- [x] `:167` — createProject has no `access` in scope; add `const access = resolveAccess(req);` at
      the top of the handler (`:109`) and use it.
- [x] `:247` — updateProject already has `access` (`:175`).
- [x] `:332` — deleteProject already has `access` (`:314`).
- [x] `src/controllers/search.js:414` — replace `projectsRepo.publicView(p).sources || {}` with the
      redacted row: hoist `const row = redactForAccess('projects', p, access);` above the mapper
      literal (`:374`) and read `row.sources || {}`, `row.isPublished` (replacing `:408-411`), and
      every other `p.<field>` in `:374-415`. Doc §2 item 9: redact the repository row, then map —
      the mapper emits eagle-search wire names, so the redactor must never run on its output.
- [x] `src/repositories/projects.js:141-158`: delete `publicView` and its export (`:257`); remove
      the now-unused `config` import if nothing else uses it (`projects.js:16`).
- [x] Update the comment at `src/merge/project.js:262-265` which names `publicView`.
- [x] `src/swagger/swagger.yaml:94-107`: note on `GET /api/projects/{id}` that the response fields
      depend on the caller's level. No new endpoint this phase.
- Tests:
  - [x] `test/controllers/nosql/document-projection.test.js` — the projects half
        (`:191-275`) is rewritten against `redactForAccess`: same assertions (`read`, `_etag`,
        `sources.track` absent; `sources.wildfire` present when `ENRICHMENT_SOURCES` names it;
        `isPublished` derived) so the old guarantees are re-proved, not deleted.
  - [x] Extend `test/helpers/access-coverage.test.js` — new subtest
        `every project response site redacts`: reuse the balanced-paren `res.json(` scanner from
        `test/controllers/nosql/document-projection.test.js:143-188` over
        `src/controllers/nosql/project.js` and `src/controllers/search.js`, per CALL SITE not per
        file (doc §2 item 1); a site naming a bare repository row (`saved|existing|items|p|page`)
        without `redactForAccess` fails. Falsifiable: reverting any one of the six sites fails it.
  - [x] New `test/vis/tripwire.test.js` — boot the app the way `test/app.boot.test.js:20-29` does,
        stub the projects repository to return a row carrying every restricted name, then
        `GET /api/projects/:id`, `GET /api/projects` and `GET /api/search?dataset=Project`
        anonymously and assert the raw response TEXT contains none of
        `['"read"','"_rid"','"_self"','"_attachments"','"_etag"','"sources":{"track"','"vis"']`.
  - [x] Same file: `an error response carries no raw document` — force the handler into its
        `serverError` path (`src/helpers/response.js`) and assert the same absence, plus that the
        logger line carries `error`/`stack` only (doc §2 item 1: raw docs now flow through error and
        log paths).
- Acceptance:
  - [x] `node --test test/vis/tripwire.test.js test/helpers/access-coverage.test.js test/controllers/nosql/document-projection.test.js`, then `yarn test`.
  - [x] Before/after on test, anonymous `GET /api/projects?pageSize=100`, `jq -S` on both sides:
        measured 2026-08-27 on test (no continuation token returned; 100 rows = full anonymous set):
        0 rows carry `complianceLead`, 0 carry `execProjectDirector`, 0 uncatalogued keys. The
        output is JSON-equal, NOT byte-identical — `isPublished` is derived now, so its key position
        moves; the `jq -S` diff is clean, a raw byte diff is not.
  - [x] `search-diff.js` is moot: its baseline is retired eagle-search, which returns the 502 sentinel
        for every case (run 2026-08-27). Replaced by the raw response diff: anonymous
        `GET /api/projects?pageSize=100` and `GET /api/search?dataset=Project&pageSize=5` on test,
        `jq -S` before (`e9f97b1`) and after (`6711d45`), 0 lines of diff for both (2026-08-27).

### U9 deviations from the unit spec

- The `ENRICHMENT_SOURCES` gate U8 flagged lives in `visibleChildren` (`src/vis/redact.js`), the one
  place dotted children are built, rather than in `redactForAccess` after the loop. Same effect, no
  second pass over the output.
- Level 0 now sees `sources.track`/`sources.eagle`, `read[]`, `vis` and the Cosmos system fields on
  a project response. `publicView` stripped those from every caller. This is doc §2 item 4 ("level 0
  sees every field") holding, not a regression — anonymous output stays JSON-equal.
- `src/controllers/search.js` no longer reads `p.proponent?.name`. The merge emits `proponentName`
  and never `proponent`, so the key is uncatalogued and the redactor removes it; the fallback could
  only ever have fired on a row no writer produces.
- The balanced-paren `res.json(` scanner moved from `document-projection.test.js` into
  `test/helpers/router-source.js` (`balancedArgs`, `jsonEmissions`) so both suites share one copy,
  and `withServer` moved from `test/app.boot.test.js` into `test/helpers/with-server.js`.
- `access-coverage.test.js` asserts the search mapper BODY, not its `res.json` argument: search
  redacts one step earlier (doc §2 item 9), so the emission text names no row. All six sites were
  mutation-checked — reverting any one fails the subtest.
- `search-diff.js` diffs against retired eagle-search (502 sentinel); superseded by the raw response diff above.

---

## U10 — feat/vis-select-projection

- [x] New `selectFor(entity, access)` in `src/repositories/_sql.js` (beside `selectWhere`, `:68`):
      returns `'*'` when `access.level === 0`; otherwise `c.<field>` for every catalog field with
      `maxVis >= level`, PLUS the row-plane fields the gates need — `id`, `read`, `isPublished`,
      the partition field, and `vis` (the dial must be readable to be applied). Dotted keys project
      their parent (`c.sources`) — the redactor still narrows it.
- [x] `src/repositories/projects.js:42-51` `listVisible`: pass `select: selectFor('projects', access)`.
      Leave `getById` (`:70-74`) on the raw point read — `canRead` needs the whole row and the
      controllers upsert what they read (doc §2 item 1).
- [x] Do NOT touch `listByIds` (`:103-116`), `listWithCentroid` (`:119-128`), `listEagleOnlyIds`,
      `listWithEagleId` — they already project explicitly.
- Tests: new `test/vis/select-for.test.js`
  - [x] `level 0 projects everything` — `selectFor('projects', {level:0}) === '*'`.
  - [x] `an anonymous projection omits the writer-only fields` — the string does not contain
        `c._etag`; it does contain `c.name`, `c.read`, `c.id`, `c.sources` (the dotted child's
        parent).
  - [x] `a level 2 projection contains _etag` — literal.
  - [x] `the projection always carries the ACL` — `c.read` present at every level 1..4. Fails if a
        refactor drops the row-plane fields, which would blank `isPublished` for every caller.
  - [x] In `test/repositories/repositories.test.js`: `listVisible projects through selectFor` —
        capture the spec passed to `cosmos.query` (stub pattern already in that file) and assert
        `spec.query` starts with `SELECT c.` for an anonymous access and `SELECT *` for level 0.
- Acceptance: `node --test test/vis/select-for.test.js test/repositories/repositories.test.js`,
  `yarn test`; then the same anonymous `/api/projects` diff as U9 → empty.

### U10 deviations from the unit spec

- `selectFor(entity, access, partitionField)` takes the partition field as a REQUIRED argument.
  `_sql.js` cannot import a repository to look one up without a cycle, and defaulting it would give
  the next entity a projection missing its own partition key.
- The comparison is `visible(level, entry.maxVis)`, not an inline `maxVis >= level`, so doc §2 item
  11 still holds: the level order is assumed in exactly one function.
- `repositories.test.js` "list criteria carry no provenance predicate" now reads the WHERE clause
  rather than the whole statement — `c.sourceSystem` is a catalogued field, so it appears in the
  projection without being filtered on.
- The anonymous `/api/projects` diff needs the deployed app; it is the same run U9 left pending.

---

## U11 — fix/projects-put-rejects-hidden-keys

- [x] `src/controllers/nosql/project.js:173-251` `updateProject`: after the destructure
      (`:187-192`), reject with 400 when any remaining key of `changes` is not visible to the caller
      — i.e. not in the catalog, or `catalog[key]` fails `visible(access.level, effVis)` for the
      existing row — and unconditionally when the body carries `vis`. Message names the offending
      keys. Doc §2 item 1: "PUT returns 400 on any body key the caller cannot see".
- [x] `src/controllers/nosql/project.js:109-171` `createProject` already allowlists its body
      (`:111-114`); add `vis` to nothing — it cannot arrive. Assert that in a test rather than
      writing code.
- [x] `src/swagger/swagger.yaml:105-127` (`put /api/projects/{id}`): add
      `'400': description: Body contains a field the caller cannot see, or a vis key.`
- Tests: `test/controllers/nosql-controllers.test.js` (mockRes pattern at `:20-31`)
  - [x] `PUT rejects a body key the caller cannot see` — level 4 caller sending
        `{ complianceLead: 'x' }` (or whichever field U7 put at 2) → 400, and `projects.upsert` was
        never called.
  - [x] `PUT rejects vis for every caller` — sysadmin (level 0) sending `{ vis: { name: 0 } }` → 400.
        Fails if the guard is level-gated instead of unconditional.
  - [x] `PUT still accepts an ordinary edit` — `{ description: 'new' }` from a writer → 200 and the
        stored doc keeps `read`, `sources`, `_etag` (the redaction-safe-update rule).
  - [x] `POST silently drops unknown keys, as before` — `{ vis: {...} }` in a create body → 201 and
        `saved.vis === undefined`. Locks in `project.js:111-114`.
- Acceptance: `node --test test/controllers/nosql-controllers.test.js`, `yarn test`;
  (400 confirmed on test 2026-08-27) `curl -X PUT -H "X-Api-Key: $ADMIN_API_KEY" -H 'Content-Type: application/json' -d '{"vis":{"name":0}}' https://demi-api-test.azurewebsites.net/api/projects/207`
  → 400.

### U11 deviations from the unit spec

- The guard sits before the ACL is computed, so a refused body never reaches `upsert` and never
  writes an audit row.
- The curl acceptance needs the deployed app. Pending with the U9 diffs.

---

## Phase 1 close-out

- [x] `TODO-rbac.md`: Phase 1 lines ticked, the two deviations recorded (Cosmos system fields;
      `complianceLead`/`execProjectDirector`). EAO sign-off on the three email fields is still
      outstanding, so they stay at `defaultVis: 4`.
- Anonymous response: measured 2026-08-27 on test, anonymous `GET /api/projects?pageSize=100`
  (no continuation token returned; 100 rows = full anonymous set): 0 rows carry `complianceLead`,
  0 carry `execProjectDirector`, 0 uncatalogued keys. JSON-equal, not byte-identical — the
  `isPublished` key position moves, `jq -S` diff clean.
- [x] Deployed to test 2026-08-27 (#199 `3707bee`, #200 `6711d45`). Anonymous `/api/projects` and
      `/api/search?dataset=Project` `jq -S` diff before/after: 0 lines. `PUT /api/projects/207`
      with `{"vis":{"name":0}}` as ADMIN_API_KEY: 400. Level 0 `GET /api/projects/207` carries
      `read`, `_etag`, `sources.track` and no `vis` (none dialled yet). `search-diff.js` moot, see U9.

---

# Phase 2 — documents, search parity, frontend

## P2-1 documents catalog and document redaction

Branch: `feat/vis-documents-catalog`

- [x] Add `src/vis/catalog/documents.js`, authored from `transformDocument` (`src/seed/transform.js:97`, return block `:111-166`), plus the four keys `createDocument` adds (`src/controllers/nosql/document.js:213-227`: `createdAt`, `isDeleted`, and the `sourceSystem: 'demi'` and `read` it writes) and the two `patchExtraction` adds (`src/controllers/nosql/document.js:781-787`: `extractionMethod`, `extraction`).
- [x] `defaultVis: 4, maxVis: 4` for every key today's `publicView` lets through: `id`, `projectId`, `eagleId`, `sourceSystem`, `displayName`, `documentFileName`, `description`, `fileExt`, `fileSize`, `mimeType`, `type`, `typeId`, `milestone`, `milestoneId`, `projectPhase`, `projectPhaseId`, `documentAuthorType`, `documentAuthorTypeId`, `datePosted`, `dateUploaded`, `documentAuthor`, `documentSource`, `isFeatured`, `region`, `eaoStatus`, `orcsClassification`, `edrmsRecordNumber`, `legislation`, `isPublished`, `contentExtracted`, `contentExtractedAt`, `contentPageCount`, `contentExtractionError`, `extractionMethod`, `extraction`, `isDeleted`, `createdAt`, `updatedAt`.
- [x] `s3Key: { defaultVis: 0, maxVis: 0 }` — `publicView` strips it today (`src/controllers/nosql/document.js:90`), and `downloadDocument` reads `doc.s3Key` off the RAW repository row (`:151-157`), not off a redacted one, so the ceiling costs nothing.
- [x] `read: { maxVis: 0 }`, `vis: { maxVis: 0 }`; `_etag: { defaultVis: 2, maxVis: 2 }`.
- [x] `isPublished` derived in the redactor from `read.includes('public')` — same derivation `publicView` does at `src/controllers/nosql/document.js:90-92`, so it must not be copied from the stored field.
- [x] Record `orcsClassification` and `edrmsRecordNumber` in the doc as candidates for a later tightening to `defaultVis: 2`; they stay 4 without EAO sign-off (question 2 mechanism).
- [x] Register `documents` in `src/vis/catalog/index.js` so `catalogFor('documents')` resolves.
- [x] Replace `publicView` at the six document call sites that emit a stored row with `redactForAccess('documents', doc, access)` / `redactAllForAccess`: `src/controllers/nosql/document.js:118` (list), `:132` (get), `:236` (create 201), `:360` (update), `:447` (setPublished), `:579` (delete `deleted:` body). Sites `:182` (download URL), `:541` (eagle upsert ack), `:800`, `:871`, `:931` (ingest acks) are hand-built payloads with no stored field except `displayName` at `:185` — leave them and list them in the coverage test as hand-built.
- [x] Delete `publicView` from `src/controllers/nosql/document.js:84-93` and its 40-line header.
- [x] `documents.listVisible` gains `select: selectFor('documents', access)` (`src/repositories/documents.js`, the `selectWhere` call in `listVisible`), level 0 keeps `*`. Do NOT touch the `EXTRACTION_FIELDS` projection at `src/repositories/documents.js:307` — it runs under `systemAccess()`.
- [x] PUT `/documents/:id` returns 400 on any body key the caller cannot see and on `vis` (`src/controllers/nosql/document.js:326-334`, where the body is destructured).

Tests

- [x] `test/vis/catalog-completeness.test.js` — extend the existing Phase 1 file: case `'documents catalog covers every transformDocument key'` calls `transformDocument` on a fixture Eagle doc and asserts `Object.keys(result)` is a subset of the catalog keys. Fails when someone adds a field to `src/seed/transform.js:111` without classifying it.
- [x] Same file, case `'s3Key never exceeds maxVis 0'` asserts `catalog.s3Key.maxVis === 0`. Fails on any widening.
- [x] `test/controllers/nosql/document-redaction.test.js` — case `'anonymous GET /api/documents/:id omits s3Key, read, _etag'` drives the controller with a stub repo row carrying all three and asserts they are absent from `res.json`. Fails if a call site is missed.
- [x] Same file, case `'level 0 GET /api/documents/:id returns s3Key'` — asserts the level-0 caller still sees it, proving the redactor is level-driven and not a strip.
- [x] Same file, case `'PUT /api/documents/:id rejects a hidden body key'` posts `{ s3Key: 'x' }` as an anonymous-level caller and asserts 400. Fails if the guard is missing.
- [x] `test/helpers/access-coverage.test.js` — add `src/controllers/nosql/document.js` per-`res.json` to the scan, with `:182`, `:541`, `:800`, `:871`, `:931` on the hand-built allowlist. Fails when a new `res.json` of a stored row appears without a redactor.

Acceptance

- [x] `yarn test` — all green.
- [x] `node --test test/vis/catalog-completeness.test.js test/controllers/nosql/document-redaction.test.js` — 0 fail.
- [ ] `curl -s $API/api/documents/<id> | jq 'has("s3Key"), has("read"), has("_etag")'` on test → `false false false`; same output as before the PR.
- [ ] `curl -s $API/api/documents/<id> | jq -S 'keys'` before and after are identical.

### P2-1 recorded deviations

- `ownRead` is a THIRD document field the unit list does not name and `publicView` did not strip, so
  it is in the anonymous response today. It is the pre-cascade ACL (`documents.setAclForProject`
  captures it lazily, `upsertFromEagle` writes it), so it is the same role vocabulary as `read`:
  catalogued at `0/0`, and stripped from PUT bodies beside `read` — setting it by hand widens the
  document the next time the cascade re-derives `read` from it. Removes one key from the anonymous
  document response.
- `_rid`, `_self`, `_attachments`, `_ts` at `maxVis: 0` remove four more keys, the same deviation
  U7 recorded for projects and for the same reason. They are unavoidable here regardless of the
  catalog: `selectFor` projects named fields, so a list read no longer fetches them at all.
- Both bullets above mean the two `jq -S 'keys'` acceptance lines will differ by those five names.
  The `has("s3Key"), has("read"), has("_etag")` line is unaffected.
- Level 0 now sees `s3Key`, `read`, `ownRead` and the Cosmos system fields on a document response.
  `publicView` stripped them from every caller. Doc §2 item 4 holding, not a regression.
- The coverage ratchet identifies hand-built payloads by the dotted-name lookahead the projects
  subtest already uses, NOT by the line-number allowlist the unit names: the same file records that
  line citations rot, and `:182`/`:541`/`:800`/`:871`/`:931` had already drifted by one commit.
  Two emissions are asserted present so the filter cannot pass vacuously.
- `test/controllers/nosql/document-projection.test.js` loses two subtests rather than gaining an
  updated copy: `a privileged caller gets the same projection` asserted the opposite of the level
  model, and `narrowing the response does not narrow what is stored` moved to
  `document-redaction.test.js`, next to the PUT guard that depends on it. Its `publicView` source
  scan moved to `access-coverage.test.js` per the unit.
- `documents.listVisible` also gains the `selectFor` coverage U10 gave projects
  (`test/vis/select-for.test.js`, `test/repositories/repositories.test.js`); the unit named no test
  for the projection it adds.

## P2-2 search parity: index-name catalogs and the drift ratchet

Branch: `feat/vis-search-drift`

- [x] Add `src/vis/catalog/index-projects.js` and `src/vis/catalog/index-documents.js`, keyed by AI SEARCH field names, not Cosmos names — the index renames (`azure/search/datasources/demi-projects-ds.json` `container.query`: `abbreviation AS displayName`, `proponentName AS proponent`, `projectState AS status`, `eagleId AS legacyEagleId`, `projectType AS type`). Every field in `azure/search/indexes/projects.json` and `documents.json` gets an entry; `read` at `maxVis: 0`.
- [x] Redact the repository row before mapping, never after: the three mappers emit eagle-search wire names (`_id`, `proponent.name`, `location`, `status`) which are not catalog keys. Sites: `src/controllers/search.js:291-329` (AI project hits → index-projects catalog), `:374-415` (Cosmos project rows → the Phase 1 `projects` catalog), `:460-491` (AI document hits → index-documents catalog), `:588-621` (chunk mapper: redact `parent` and `project`, which come from `documentsRepo.listByIds` / `projectsRepo.listByIds` at `:570-573`).
- [x] `src/controllers/search.js:414` still calls `projectsRepo.publicView(p).sources` — Phase 1 deleted `publicView`; replace with the `sources.wildfire` dotted catalog key, gated by `config.enrichmentSources` exactly as `src/repositories/projects.js:152-157` did.
- [x] `src/controllers/search.js:701-760` `summarize`: redact the `documentsRepo.listByIds` and
      `projectsRepo.listByIds` rows before building `citations`. The `chunksRepo.getById` rows are
      deferred to P4-1, which is where the chunks catalog they need is authored.
- [x] Chunks keep the `select` string as the enforcement point, per doc section 2 item 9 — do not change `retrievable` on `content` (`azure/search/indexes/chunks.json`), semantic ranking needs it.

Tests

- [x] `test/vis/search-drift.test.js` — case `'DOCUMENT_SELECT is a subset of maxVis 4 index fields'` parses `src/search/ai-search.js:64-66` `DOCUMENT_SELECT` and asserts every name is in `index-documents` with `maxVis === 4`. Fails the moment someone adds a restricted field to the select.
- [x] Same file, case `'PROJECT_SELECT is a subset of maxVis 4 index fields'` over `src/search/ai-search.js:82-84`. Fails identically.
- [x] Same file, case `'chunk select never names content'` asserts the literal at `src/search/ai-search.js:773` is exactly `chunkId,documentId,projectId,pageNumber,read`. Fails when `content` is added — the change that would start shipping whole chunk text.
- [x] Same file, case `'every retrievable index field is catalogued at maxVis 4'` reads all three `azure/search/indexes/*.json`, filters `retrievable !== false`, and asserts each is in the matching index catalog with `maxVis === 4`, except `read` (`maxVis 0`). Fails on an index PUT that exposes a restricted field.
- [x] `test/controllers/search.test.js` — add case `'anonymous Project hit carries no read[]'` and `'anonymous Document hit carries no read[]'`, asserting on the mapped rows. Fails if a mapper starts spreading the raw row.

Acceptance

- [x] `node --test test/vis/search-drift.test.js test/controllers/search.test.js` — 0 fail.
- [ ] Anonymous `GET /api/search?dataset=Project&pageSize=5` and `dataset=Document&pageSize=5` on test, `jq -S` before and after: 0 lines (`search-diff.js` is moot, its baseline is retired eagle-search). Date the run here: ______
- [ ] `curl -s "$API/api/search?dataset=Project&pageSize=5" | jq -S '.[0].searchResults[0] | keys'` identical before and after.

### P2-2 recorded deviations

- The `summarize` chunk rows are NOT redacted: `catalogFor('chunks')` does not exist until P4-1, and
  authoring it here would pull that unit forward. Nothing off a chunk row reaches the response —
  `citations` reads its ids off the AI Search hit and `content` goes to the model only — so the
  deferral costs no wire exposure. Carried as a line under P4-1.
- `read` is exempted from the two `*_SELECT` subset cases and from the retrievable-fields case: it is
  selected and retrievable on purpose, because the redactor derives `isPublished` from it and then
  drops it. The cases assert `maxVis === 0` for it rather than skipping it.
- The retrievable-fields case covers `projects.json` and `documents.json` only. `chunks.json` has no
  catalog until P4-1, and `content` is retrievable there by design (semantic ranking); the
  `'chunk select never names content'` case is its ratchet instead.
- `labelWithProjectNames` (`src/controllers/search.js:39`) redacts its `projectsRepo.listByIds` rows
  too. The unit did not name it — it hydrates the document hits the unit does name, off raw
  repository rows, so it is the same site one function further out. `name` and `eagleId` are 4/4, so
  no output moves.
- Both AI mappers now read `isPublished` off the redacted row instead of recomputing it from
  `doc.read`. Recomputing was not optional to change: the redactor drops `read`, so the old
  expression would have reported every hit published.
- Two catalog entries are not index fields: `highlighted` on both, the marked-up copy `ai-search.js`
  attaches to a hit. Classified at 4/4, the ceiling of the fields it is derived from.

## P2-3 query parameters gated by the catalog

Branch: `feat/vis-query-params`

- [x] `src/search/eagle-query.js` `buildFilter` (`:313`) and `buildOrderBy` (`:443`): after alias resolution through `ALIASES` (`:44-70`), drop any key whose resolved index field is not visible at the caller's level. Pass `access` in from `src/controllers/search.js:268` and `:475`. Dropped keys already flow to `noteDropped` (`src/controllers/search.js:194`), so the response meta says so — no new wire shape.
- [x] `src/repositories/projects.js:27-35` `buildCriteria`: reject (not silently drop) `regionalDistrict`, `municipality`, `electoralDistrict` when the caller cannot see them; today they are unconditional `eq` clauses. All three are `defaultVis: 4` in the Phase 1 catalog, so this is a guard with no behaviour change today.
- [x] `KNOWN_PARAMS` (`src/search/eagle-query.js:113-121`) is unchanged — an unknown param stays a 400.

Tests

- [x] `test/search/eagle-query.test.js` — case `'every ALIASES target is a maxVis 4 index field'` iterates `ALIASES.Project`, `.Document`, `.DocumentChunk` values and asserts each is catalogued at `maxVis 4`. Fails if an alias ever points at a restricted column.
- [x] Same file, case `'DEFAULT_ORDER fields are maxVis 4'` over `:108-111` (`name asc`, `displayName asc`). Fails on a sort default that would leak ordering over a hidden field.
- [x] `test/repositories/projects.test.js` — case `'buildCriteria keys are all catalogued'` asserts the three criteria field names exist in `src/vis/catalog/projects.js`. Fails when a filter is added for an uncatalogued field.
- [x] `test/controllers/search.test.js` — case `'a filter on a hidden field is dropped, not applied'` drives an anonymous search with a filter on a `defaultVis: 2` field and asserts the key appears in `meta.dropped` and not in the emitted OData filter. Fails if the filter is composed.

Acceptance

- [x] `node --test test/search/eagle-query.test.js test/controllers/search.test.js test/repositories/projects.test.js` — 0 fail.
- [ ] `curl -s "$API/api/search?dataset=Project&complianceLead=x"` → 400 (unknown param, unchanged).
- [ ] Same anonymous `/api/search` `jq -S` diff as P2-2: 0 lines. Date: ______

### P2-3 recorded deviations

- The catalog gate lives in one helper, `fieldVisible` (`src/search/eagle-query.js`), shared by
  `buildFilter` and `buildOrderBy`. An index field with NO catalog entry is dropped, not passed —
  same allowlist rule the redactor applies to a response field.
- `src/vis/level.js` gains `levelOf(access)`. The fail-closed level read was already written twice
  inside `redact.js`; a third copy in `eagle-query.js` and a fourth in `repositories/projects.js`
  would have been four. Both `redact.js` copies now call it, so no behaviour moves.
- `recoverChunkFilters` (`src/controllers/search.js:96`) takes `access` too. The unit did not name
  it — it rebuilds a `Document` filter out of the chunk drop list, so without it a Document field
  the caller cannot see would come back as chunk scope.
- The `'a filter on a hidden field is dropped, not applied'` case filters on `read`, not on a
  `defaultVis: 2` field: the index catalogs classify nothing at 2. `read` is `defaultVis: 0` and
  filterable, so it is the only key that exercises the gate today.
- `CRITERIA_FIELDS` is exported from `src/repositories/projects.js` so the new test iterates the
  real key list. A literal list in the test would not fail when a fourth criterion is added.

## P2-4 GET /api/me

Branch: `feat/vis-me-endpoint`

- [x] New `exports.getMe` in `src/controllers/me.js` (no Cosmos read, so beside `config.js`, not under `nosql/`) (new file, ~15 lines): `resolveAccess(req)` then `res.json({ roles: access.roles, level: access.level, tier: access.tier })`. No Cosmos read.
- [x] Route `router.get('/me', passiveAuthMiddleware, meController.getMe)` in `src/routes/api.js`, beside `/config` at `:38`. Passive, not `authMiddleware`: an anonymous caller must get `{ roles: ['public'], level: 4, tier: 'public' }` rather than a 401.
- [x] `src/swagger/swagger.yaml`: add `/api/me` under `paths:` (`:15`), before `/api/projects` (`:39`); response schema in `components:` (`:499`).

Tests

- [x] `test/controllers/me.test.js` — case `'anonymous /api/me returns level 4'` asserts `{ level: 4, tier: 'public' }` and `roles` contains only `public`. Fails if the route is mounted behind `authMiddleware` (401 instead of 200).
- [x] Same file, case `'/api/me never returns a token or a key id'` asserts the response has exactly the keys `roles`, `level`, `tier`. Fails if someone spreads `req.user` in.
- [x] `test/app.api-docs-prod.test.js` already asserts swagger parses; confirm `/api/me` appears.

Acceptance

- [x] `node --test test/controllers/me.test.js` — 0 fail.
- [ ] `curl -s $API/api/me` → `{"roles":["public"],"level":4,"tier":"public"}`.
- [ ] `curl -s -H "X-Api-Key: $KEY" $API/api/me | jq .level` → the level of that key's roles.

## P2-5 frontend level signal

Branch: `feat/vis-frontend-level`

- [ ] `frontend/src/app/services/registry-state.service.ts`: add `visLevel = signal<number>(4)` beside `isAuthenticated` / `isUnauthorized` (`:52-53`).
- [ ] Fetch `/api/me` in `authSettled()` (called at `:771` and `:778`) and set `visLevel`. The fetch monkey-patch at `:602-628` already attaches the bearer, so no header work here.
- [ ] Replace the hard-coded role check at `:757` (`roles.includes('sysadmin') || roles.includes('staff') || roles.includes('demi-admin')`) with `level <= 2` from the `/api/me` answer; keep `isUnauthorized` as the rendered signal so no template changes.
- [ ] `frontend/src/app/models/registry.models.ts`: make every field a redactor can remove optional — `Project` (`:1-35`) `sector`, `status`, `region`, `description`, `proponent`, `centroid`, `legacyEagleId`; `Document` (`:37-53`) `orcsCode`, `documentType`, `projectName`. `id` and `name` stay required (`maxVis 4` in the catalog).
- [ ] Templates render on field presence, never on role: grep `isStaff()` and `isUnauthorized()` in `frontend/src/app/**/*.html` and convert any field-level use to `@if (project.x)`. Screen-level gating stays.
- [ ] Wiki page: catalog format and the level table. Link it from `docs/rbac-architecture.md`.

Tests

- [ ] `frontend/src/app/services/registry-state.service.spec.ts` — case `'visLevel defaults to 4 before /api/me answers'` asserts the initial signal value. Fails if the signal is initialised optimistically at 0 or 2, which would render staff UI to anonymous.
- [ ] Same file, case `'visLevel 2 clears isUnauthorized'` stubs `/api/me` → `{ level: 2 }` and asserts `isUnauthorized()` is false; `{ level: 3 }` asserts true. Fails if the old role check survives.
- [ ] Same file, case `'a project row with no sector renders'` — construct a `Project` without the now-optional fields and assert no throw. Fails if a template dereferences a removed field.

Acceptance

- [ ] `cd frontend && yarn lint && yarn test && yarn build` — all green.
- [ ] Anonymous load of the deployed frontend shows no staff panel; DevTools Network shows `/api/me` returning `level: 4`.
- [ ] Staff login shows the same panels as before the PR.

---

# Phase 3 — per-record dials

Blocked on EAO question 1 and on the realm roles above. Nothing in Phase 3 merges before both lines
carry a date.

## P3-1 carry `vis` forward through the two whole-item writers

Branch: `fix/vis-carry-forward`

- [ ] `src/controllers/nosql/project.js:280` — the line is `merged.sources = { ...(existing && existing.sources), ...merged.sources };`. Add beside it: `if (existing && existing.vis) merged.vis = existing.vis;` A Cosmos upsert replaces the item, so without this every eagle-api push wipes the dials.
- [ ] `src/scripts/seed-nosql.js:398-408` — the project stage upserts at `:403` with NO existing-row read at all (unlike the document stage, which builds `existingFor` at `:444-450`). Add a `projects.getById(systemAccess(), project.id)` lookup mirroring `existingFor` and carry both `vis` and `sources` forward; count carried rows in `summary.stages.projects`.
- [ ] Ordinary POST and PUT strip `vis` from bodies: `src/controllers/nosql/project.js:187-192` (destructure) and `:115-118` (create). PUT returns 400 on `vis` per the Phase 1 rule.

Tests

- [ ] `test/controllers/nosql/nosql-controllers.test.js` — case `'upsertFromEagle preserves an existing vis map'` stubs an existing row with `vis: { eacExpires: 3 }`, pushes an Eagle doc, asserts the upserted item still carries it. Fails on the current code, which drops it.
- [ ] `test/scripts/seed-nosql.test.js` — case `'the project stage carries vis forward'`, same assertion against the seeder's dry-run item set. Fails on the current code.
- [ ] `test/controllers/nosql/nosql-controllers.test.js` — case `'PUT /api/projects/:id rejects a vis body key'` asserts 400. Fails if the strip is a silent drop.

Acceptance

- [ ] `node --test test/controllers/nosql/nosql-controllers.test.js test/scripts/seed-nosql.test.js` — 0 fail.
- [ ] `node src/scripts/seed-nosql.js --only projects` (dry run, in the app container) reports `vis carried forward on N rows` with N equal to the number of dialled rows.

## P3-2 PATCH /api/projects/:id/visibility

Branch: `feat/vis-classify-endpoint`

- [ ] `requireRole(name)` factory in `src/middleware/require-roles.js`, next to `requireWrite` (`:24-31`) and `requireAdmin` (`:33-41`); same shape — read `req.user.realm_access.roles`, 403 with a message naming the missing role. Export it at `:43`.
- [ ] Route: `router.patch('/projects/:id/visibility', authMiddleware, requireWrite, requireRole('demi-classify'), projectController.setVisibility)` in `src/routes/api.js`, after `:68`.
- [ ] `exports.setVisibility` in `src/controllers/nosql/project.js`, after `updateProject` (ends `:250`). Body `{ vis: { field: level } }`. 400 on a field absent from `catalogFor('projects')`, 400 on a level outside `0..maxVis`, 400 on more than 10 keys (`src/db/cosmos-nosql.js:262-265` caps patch at 10 operations).
- [ ] Write with `cosmos.patch(CONTAINER, id, id, ops)` — the precedent is `src/repositories/api-keys.js:78-86` `touchLastUsed`, and the reason is the same: an upsert writes the whole record and would race the content writers. Add `patchVis` to `src/repositories/projects.js` beside `patchWildfireStats` and export it at `:263`.
- [ ] `auditEvent(req, { action: 'project.reclassify', targetType: 'project', targetId, projectId, detail: { fields, from, to } })` BEFORE responding — signature at `src/utils/audit.js:182`, an existing call to copy at `src/controllers/nosql/project.js:222-232`. Field names and levels only, never values.
- [ ] `src/swagger/swagger.yaml`: `patch:` under `/api/projects/{id}` (`:94`), 200 / 400 / 403.

Tests

- [ ] `test/controllers/nosql/project-visibility.test.js` — case `'403 without demi-classify'` drives the route with a `staff`-only token. Fails if the middleware is missing from the chain.
- [ ] Same file, case `'400 on an uncatalogued field'` posts `{ vis: { notAField: 2 } }`.
- [ ] Same file, case `'400 on a level above maxVis'` posts a level 4 dial for a `maxVis: 2` field.
- [ ] Same file, case `'patches, never upserts'` asserts the stub repo saw `patch` and not `upsert` — an upsert here would clobber a concurrent content write.
- [ ] Same file, case `'audits before responding'` asserts the audit buffer holds `project.reclassify` at the time `res.json` is called.
- [ ] `test/controllers/audit-cud-coverage.test.js` — add the new mutating route to the covered set. Fails if a mutating route ships without an audit row.

Acceptance

- [ ] `node --test test/controllers/nosql/project-visibility.test.js test/controllers/audit-cud-coverage.test.js` — 0 fail.
- [ ] `curl -X PATCH -H "Authorization: Bearer $STAFF" -d '{"vis":{"cacEmail":2}}' $API/api/projects/207/visibility` → 403.
- [ ] Same with a `demi-classify` token → 200; a follow-up anonymous `GET /api/projects/207` omits `cacEmail`.
- [ ] `DemiAudit_CL | where Action == "project.reclassify"` returns the row.

## P3-3 gate `projectCACPublished`, then ship the `cacPublished` predicate

Branch: `feat/vis-cac-predicate`

- [ ] `projectCACPublished` is an ordinary `EAGLE_ONLY_FIELDS` content field (`src/merge/project.js:52`) that any `WRITE_ROLES` caller sets through PUT. Add it to the PUT strip list at `src/controllers/nosql/project.js:187-192` so only `PATCH /visibility` (P3-2) or the Eagle push may set it. Merges before the predicate, per doc section 2 item 7.
- [ ] Only then: `cacPublished: (record) => record.projectCACPublished === true` in `src/vis/predicates.js`, and `when: 'cacPublished'` on `cacEmail` in `src/vis/catalog/projects.js` with `defaultVis: 2, maxVis: 4`.

Tests

- [ ] `test/controllers/nosql/nosql-controllers.test.js` — case `'PUT /api/projects/:id cannot set projectCACPublished'` asserts the stored row is unchanged. Fails today, where the body spreads in at `:211`.
- [ ] `test/vis/redact-matrix.test.js` — case `'cacEmail is public only while the CAC is published'`: level 4 + `projectCACPublished: true` → present; level 4 + false → absent; level 2 → present in both. Fails if the predicate narrows instead of widening.
- [ ] Same file, case `'a dial beats the predicate'`: `vis: { cacEmail: 0 }` with `projectCACPublished: true` → absent at level 4 and at level 2. Fails on the source design's AND semantics.

Acceptance

- [ ] `node --test test/vis/redact-matrix.test.js test/controllers/nosql/nosql-controllers.test.js` — 0 fail.
- [ ] Anonymous `GET /api/projects/<published-CAC-project>` still returns `cacEmail` (today's behaviour, per doc section 2 item 3).

## P3-4 index the `vis` map

Branch: `feat/vis-index-field`

- [ ] `azure/search/indexes/projects.json`: add `{ "name": "vis", "type": "Edm.String", "retrievable": true, "searchable": false, "filterable": false, "sortable": false, "facetable": false }` — a JSON string, because the index has no map type.
- [ ] `azure/search/datasources/demi-projects-ds.json` `container.query`: append `, c.vis` to the SELECT before `, c._ts`.
- [ ] `src/search/ai-search.js:82-84` `PROJECT_SELECT`: append `,vis`.
- [ ] `src/controllers/search.js:291` mapper: `JSON.parse(doc.vis || '{}')` inside a try, fall back to `{}` on a throw (fail closed = no dial = `defaultVis`), then hand the parsed map to the redactor before mapping.
- [ ] Same for `azure/search/indexes/documents.json` only if documents get dials; do not add it speculatively.

Tests

- [ ] `test/vis/search-drift.test.js` — case `'vis is retrievable and never searchable'` asserts the three flags on the index definition. Fails if a later PUT makes it searchable, which would let a caller find records by their classification.
- [ ] `test/controllers/search.test.js` — case `'a malformed vis string falls back to defaultVis'` feeds `vis: '{'` and asserts the row is redacted at `defaultVis`, not returned raw. Fails on an unguarded `JSON.parse`.
- [ ] `test/search/ai-search.test.js` — the existing select-vs-index guard covers the new name.

Acceptance

- [ ] `node --test test/vis/search-drift.test.js test/search/ai-search.test.js test/controllers/search.test.js` — 0 fail.
- [ ] Reindex block below, run in order.
- [ ] After the indexer reset: `GET {endpoint}/indexers/projects-indexer/status` reports `393 processed, 0 failed` and a dialled project's search hit is redacted.

## P3-5 lateral clearance sets — only if the EAO answers "lateral"

Branch: `feat/vis-clearance-set`

- [ ] Replace `visible(level, effVis)` in `src/vis/redact.js` and `levelFromRoles` in `src/vis/level.js` with set membership. Doc section 2 item 11 says these two are the only places the scalar order is assumed — hold that claim with a grep for `<=` under `src/vis/` in the completeness test before writing any dial.
- [ ] Must land BEFORE any `demi-vis-*` role is created or any dial is written.

---

# Phase 4 — content plane and Entra

## P4-1 chunks catalog

Branch: `feat/vis-chunks-catalog`

- [ ] `src/vis/catalog/chunks.js` over the stored chunk shape (`src/chunker.js` output plus `documentId`, `projectId`, `read`, `pageNumber`, `content`). `read` and `vis` at `maxVis: 0`.
- [ ] Decide and record: chunk content classification is the PARENT DOCUMENT's, not the chunk's. The gate already works that way — `src/controllers/search.js:581` filters chunks whose parent document is not visible, and `src/repositories/chunks.js:68-73` `getById` gates on `canRead`. No new plane; the catalog only classifies chunk METADATA.
- [ ] `content` stays out of the wire by the `select` string at `src/search/ai-search.js:773` and by `content: ''` at `src/controllers/search.js:617`. Catalogue `content` at `maxVis: 0` so the drift test can hold both.
- [ ] There is no chunk read endpoint: `src/routes/api.js` mounts only `POST /documents/:id/chunks` (`:96`). No new `res.json` site to redact.
- [ ] `src/controllers/search.js` `summarize`: redact the `chunksRepo.getById` rows, deferred from
      P2-2 because the catalog did not exist yet.

Tests

- [ ] `test/vis/catalog-completeness.test.js` — case `'chunks catalog covers the chunker output'` runs `chunkMarkdown` on a fixture and asserts every emitted key is catalogued. Fails when the chunk shape grows.
- [ ] `test/vis/search-drift.test.js` — case `'content is maxVis 0 and absent from every select'`. Fails if `content` enters `src/search/ai-search.js:773`.

Acceptance

- [ ] `node --test test/vis/catalog-completeness.test.js test/vis/search-drift.test.js` — 0 fail.
- [ ] `curl -s "$API/api/search?dataset=DocumentChunk&keywords=water" | jq '.[0].searchResults[0].content'` → `""`.

## P4-2 level-0 material in the runbook

Branch: `docs/vis-level-zero-exports`

- [ ] `docs/prod-flip-runbook.md`: name `src/scripts/export-chunks-to-eagle.js --dump`, `src/scripts/audit-chunk-quality.js` and `src/scripts/probe-phrase-presence.js` as level-0 material — all three read under `systemAccess()` (`src/scripts/audit-chunk-quality.js:111`, `src/scripts/probe-phrase-presence.js:241`).
- [ ] Add the deletion step for the App Service `/home` filesystem on `demi-api-test` and `demi-api-prod` after any `--dump`.
- [ ] `src/ai/summarize.js`: one comment line stating it consumes chunk `content` only and never a project or document row. No code change.

Tests

- [ ] `test/ai/summarize.test.js` — case `'summarize reads no project or document field'` asserts the prompt builder is called with objects whose only keys are chunk keys. Fails if a future change feeds it a project row.

Acceptance

- [ ] `node --test test/ai/summarize.test.js` — 0 fail.
- [ ] `grep -n systemAccess src/scripts/*.js` output matches the runbook list exactly.

## P4-3 dual issuer in auth.js

Branch: `feat/entra-dual-issuer`

- [ ] `src/helpers/auth.js`: `clientInstance` is a single module-level `jwksClient` bound to `config.ssoJwksUri` (`:112-119`) and `getKey` closes over it (`:121-129`). Replace both with an ISSUERS map `{ [iss]: { jwks: jwksClient({...}), audience } }` built once at module load from config, and a `keyFor(issuer)` returning that issuer's `getKey`.
- [ ] `jwt.decode(token, { complete: true })` already runs at `:214`; take `payload.iss` from it and select the entry atomically as `{ issuer, jwks, audience }` BEFORE `jwt.verify`. Unknown `iss` → 401, no verification attempted.
- [ ] `src/helpers/auth.js:225-228` options: `issuer` from the selected entry, and `audience` too — Phase 0 added `aud` validation; this makes it per-issuer.
- [ ] `rolesFor` (`src/helpers/access-sql.js:74`) reads `realm_access.roles` today. Add the Entra `roles` claim as a second source; role NAMES stay identical, so `ROLE_LEVELS` is untouched.
- [ ] `src/config.js:180-181`: `ssoJwksUri`/`ssoIssuer` stay; add `entraIssuer`, `entraJwksUri`, `entraAudience`, all optional. With none set the map has one entry and behaviour is unchanged.

Tests

- [ ] `test/helpers/registry-key-auth.test.js` (or a new `test/helpers/dual-issuer.test.js`) — case `'a token from an unknown issuer is rejected without a JWKS fetch'` asserts 401 and that the jwks stub was never called. Fails if `iss` is read after verification.
- [ ] Same file, case `'each issuer verifies against its own audience'` — a token valid for issuer A with issuer B's `aud` is rejected. Fails on a shared-audience shortcut.
- [ ] Same file, case `'Entra roles claim maps to the same levels'` asserts a token with `roles: ['demi-vis-2']` and no `realm_access` resolves to level 2.

Acceptance

- [ ] `node --test test/helpers/*.test.js` — 0 fail.
- [ ] With no Entra config set, `curl -H "Authorization: Bearer $KC_TOKEN" $API/api/me` answers exactly as before the PR.

## P4-4 MSAL in the frontend

Branch: `feat/entra-msal-frontend`

- [ ] `frontend/src/index.html:39` — drop the `keycloak-js@25.0.6` CDN `<script>`; add `@azure/msal-browser` as a real dependency in `frontend/package.json` instead of a CDN tag.
- [ ] `frontend/src/app/services/registry-state.service.ts:728-784` — replace the Keycloak init (`onLoad: 'check-sso'`, `pkceMethod: 'S256'`, `silentCheckSsoRedirectUri` at `:735-741`) with MSAL `initialize()` + `ssoSilent()`; keep `authSettled()` at `:771`/`:778` as the single barrier so data loading still waits for auth.
- [ ] `:602-628` — the `window.fetch` monkey-patch: replace `this.keycloak.token` (`:632`) with an MSAL `acquireTokenSilent` result and `this.keycloak.updateToken(30)` (`:644`) with the same call's own refresh. Keep `isApiUrl` (`:590-600`) exactly as is — it is the guard that stops the bearer being attached to the DataBC WFS.
- [ ] `loginKeycloak()` (`:786`) and the logout path (`:1863-1864`) move to MSAL equivalents; method names may stay to avoid touching templates.
- [ ] `visLevel` still comes from `/api/me` (P2-5) — no claim parsing in the browser.

Tests

- [ ] `frontend/src/app/services/registry-state.service.spec.ts` — case `'the interceptor attaches no token to a third-party URL'` calls the patched `fetch` with a DataBC URL and asserts no Authorization header. Fails on a regression of the `isApiUrl` guard.
- [ ] Same file, case `'a 401 triggers exactly one silent refresh for concurrent calls'` — the `refreshPromise` single-flight at `:605`/`:643-648` must survive the port. Fails if each call refreshes.

Acceptance

- [ ] `cd frontend && yarn lint && yarn test && yarn build` — green.
- [ ] `grep -c keycloak frontend/src/index.html` → 0.
- [ ] Manual: staff login through Entra, `/api/me` returns the expected level, project list renders.

## P4-5 remove the Keycloak issuer

Branch: `chore/entra-drop-keycloak`

- [ ] LAST. Delete the Keycloak entry from the ISSUERS map in `src/helpers/auth.js` and the `ssoIssuer`/`ssoJwksUri` config lines (`src/config.js:180-181`) only after Entra has carried production traffic for a full business week. Date the window here: ______
- [ ] Keep `realm_access.roles` parsing in `rolesFor` until the API keys minted with realm role names are re-minted (`src/controllers/nosql/api-key.js:31` `GRANTABLE_ROLES`).

Acceptance

- [ ] `node --test` — 0 fail.
- [ ] A Keycloak token now returns 401; an Entra token returns 200 on `/api/me`.

---

# Reindex (P3-4 only)

Procedure from `azure/search/README.md:116-170`. Run inside the `demi-api-test` container over the
App Service SSH tunnel — the search service is `publicNetworkAccess: Disabled` and a workstation
gets a 403, not a connection error. Grant `Search Service Contributor`
(`7ca78c08-252a-4471-8644-bb5ff32d4ba0`) at the SERVICE scope for the run and revoke it after.

- [ ] 1. PUT the index: `node src/scripts/apply-search-definitions.js --only projects --live`. Adding a field is an additive change, so no `allowIndexDowntime`.
- [ ] 2. PUT the data source: `node src/scripts/put-search-datasources.js --only projects --live`. `apply-search-definitions.js` deliberately never writes a data source; without this the indexer keeps its old SELECT and `vis` stays null on every row.
- [ ] 3. Deploy the app carrying the new `PROJECT_SELECT` and the mapper. Order matters: an app selecting a field the index lacks is a 400 on every query, and a 400 is not retried.
- [ ] 4. Reset and run the indexer: `POST {endpoint}/indexers/projects-indexer/reset?api-version=2024-07-01` → 204; `POST .../run` → 202; poll `GET .../status` until `lastResult.status` is `success` — treat `reset` as still-running, not terminal. Expect `393 processed, 0 failed`.
- [ ] 5. Confirm: a dialled project's AI Search hit carries `vis`, and the mapper redacts it.

**The window where the mapper redaction is the only guard** opens at step 1 and closes at step 5.
Between the index PUT and a successful indexer run, `vis` is `null` on every indexed row: every
project search hit is redacted at `defaultVis` from the catalog with no dial applied, so a project
dialled BELOW its default is over-exposed in search results while remaining correct on
`GET /api/projects/:id` (Cosmos, no indexer). Two consequences:

- [ ] Do not write any dial that RESTRICTS below `defaultVis` until step 5 is green.
- [ ] If a restricting dial must be applied first, unpublish the project (`read[]`, the row plane) for the duration — the row plane is indexed and enforced by `filterFor`, and it does not depend on the new field.

---

# Parked

- `visLevelCap` on API keys, `GET /api/vis-catalog`, golden fixtures: dropped, see doc section 2
  item 13. Revisit only with a named consumer.
