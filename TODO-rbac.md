# TODO — attribute-level access control

Goal: every field of every entity classified and redacted per caller level. The design is
`docs/rbac-architecture.md`. The shipped behaviour is wiki `Attribute-Level-Access.md`.
`TODO-frontend.md` holds frontend items.

**This file holds open work only.** A finished unit is one line in [Shipped](#shipped); `git log`
holds its detail.

How to work it: append a unit here before doing it, date every measurement, `node --test` per new or
changed endpoint, swagger in the same PR, `src/utils/logger.js` for logging, ask before commit.
**Merging is deploying** on test, so every unit leaves anonymous responses byte-identical unless its
line says otherwise. Line cites verified 2026-09-02 at `7215e11`; re-verify before editing.

Order for what is left: U1, then the U3 and U4 prod steps, then P3-0's prod schedule, then
P4-3 → P4-4 → P4-5. P3-2 and P3-6 residues are independent. P5b is optional and unscheduled.

## Facts

1. `DEMI_ALLOWED_CLIENTS` is enforced by `isAllowedClient` (`src/helpers/auth.js:114`): a verified
   token from an unlisted `azp` gets 401. `src/config.js:271-275` throws when the list is empty in
   any environment other than `dev` and `local`. That throw does not boot-loop the app —
   `api/index.js:58` requires `src/http/router` inside the request handler, so the Function App
   starts and answers 500 on every request instead. This is why the app setting deploys before the
   code that needs it.
2. `aud` is verified only when `SSO_AUDIENCE` is non-empty (`src/helpers/auth.js:275-280`). Test
   carries `account`; prod carries `''` (`azure/main.prod.bicepparam:76`), so prod verifies no
   audience.

## External dependencies (owner and date before the unit that needs them)

- [x] Realm roles: DEMI reuses Eagle's vocabulary, no `demi-*` realm roles (2026-08-28). `staff` and
      `compliance` exist on test and prod (2026-09-02, `kc-create-demi-clients.sh`). Level 3 is the
      `identity_provider` claim and level 1 is project scope, so neither is a realm role.
- [x] Track `GET /api/v1/projects/team-members` (bcgov/EPIC.track#2829): merged 2026-09-01, on test
      2026-09-02. Prod pending Track's own prod release (last 2026-05-20).
- [x] Realm clients `demi-track-reader` and `demi-role-sync` in `eao-epic`, secrets in
      `demi-app-secrets`: test and prod 2026-09-02.
- [ ] `project:<id>` roles issued in `eao-epic` to every EAO user who must see their own team's
      records. Minted by P3-0's sync, not by hand. Test 2026-09-02: 96 roles, 115 mappings; 53 Track
      staff have no test-realm user. Prod: blocked on Track prod, see the row above. Owner: Daniel.
      Delivered (prod): ______
- [x] EAO questions 1-4: closed 2026-08-28, answers in `docs/rbac-architecture.md` §3.
- [ ] Entra app registration for the DEMI API, app roles named exactly as the realm roles, issuer and
      audience recorded in the wiki. Blocks P4-3. The tenant refuses non-admin `az ad app create`
      (2026-09-02, "Insufficient privileges"), so the identity team must create it; the app-role
      manifest to hand them is `docs/entra-app-roles.json`. Owner: Daniel. Requested: ______
      Delivered: ______

---

## Pick-up checks (do these first)

- [ ] First live Track mirror on test ran 2026-09-03 10:00 UTC. Read the `[track-teams]` summary
      line in App Insights for `demi-api-fc-test`; expected `trackProjects=384 created=2 updated=17
      failures=0` (dry run 2026-09-02). Anything else: `src/scripts/sync-track-projects.js`.
- [ ] Staff-login checks on test, with Daniel signed in as IDIR staff on a Track team: a level-1
      row of that team returns 200, `PATCH` on a project as `staff` returns 403, and the audit
      container holds the rows. Closes the P3-2 residue staff-token box too.
- [ ] Prod runs v0.58.3; main carries #288 (trusted proxy), #290 (`/api/me` credentials), #294. Tag
      and deploy when wanted: `gh workflow run "Deploy DEMI to Azure production" --ref <tag> -f
      version=<tag>`; a dispatch from `main` is rejected by the environment tag policy.
- [ ] Rotate the prod `demi-user` Keycloak password (it passed through a terminal 2026-09-02) and
      update `demi-keycloak-admin` in `6cdc9e-prod`.

## U1 — ADR

- [ ] Wiki `ADR-010-Attribute-Level-Access-Control.md` (ADR-009 is Track Feed): Status Accepted;
      Context / Decision / Consequences; links `docs/rbac-architecture.md`.
- [ ] Tick this unit and date it once the page exists.

## U3 — prod rollout of the client allowlist

Code and the `DEMI_ALLOWED_CLIENTS` app setting ship in two pipelines, so infra goes first (Fact 1).

- [ ] `MINIO_*=… ADMIN_API_KEY=… DOCLING_API_KEY=… TRACK_CLIENT_SECRET=… ROLE_SYNC_CLIENT_SECRET=…
      ./scripts/deploy-infra.sh prod --what-if`, review, then
      `CONFIRM_PROD=yes ./scripts/deploy-infra.sh prod --live`.
- [ ] Verify: `GET /api/deployments/latest`, then anonymous `/api/projects` → 200 and unchanged, and
      a Bearer token from an unlisted client → 401.
- [ ] Rollback is revert the code commit and redeploy the API. Leave the app setting in place; never
      revert the setting and keep the code.

## U4 — prod audience

- [ ] Measure `aud` on a live prod-realm token and record it in the PR. Test measured 2026-08-28: a
      staff login through the DEMI frontend (`azp=eagle-admin-console`) carries
      `["epictrack-web","realm-management","epic-search","epic-engage","account"]`, so `account`
      verifies (jsonwebtoken matches any element).
- [ ] `azure/main.prod.bicepparam:76`: `param ssoAudience = '<measured>'`. It stays `''` until then,
      which means prod checks no audience.

## P3-0 residue — prod team sync

- [ ] `syncTeamsSchedule` stays `''` in `azure/main.prod.bicepparam:159` until Track prod serves
      `/api/v1/projects/team-members`. The realm clients and roles already exist in prod.

## P3-2 residue — level 3 measurement

`identity_provider === 'idir'` is what mints the level-3 token (`src/helpers/access-sql.js:192`).

- [ ] Confirm `identity_provider` is the claim name on a live loginproxy token, on test, and record
      the measurement. Level 3 is dead until it is right.
- [ ] Count `project:*` roles and any role named `team` or `idir` on the PROD realm; a realm role by
      those names would forge a ladder token. Test carried zero of each on 2026-08-28.
- [ ] With a staff token on test: `GET /api/projects` returns the same ids as before the deploy
      (every stored row carries `staff`) and `GET /api/me` reports `level: 2`, `privileged: false`.
- [ ] Anonymous `GET /api/search?dataset=Project&pageSize=5` on test, `jq -S` against a pre-P3-2
      capture: 0 lines. P3-3 measured `/api/projects` and `/api/documents` only; the search-side
      team arm (`access-odata.js` `filterFor`) has no recorded anonymous diff.

## P3-6 residue — Selected Credentials auto-revoke

Auto-revoke on state change. The closed-project arm runs nightly inside `sync-track-teams.js`.
Expiry is visible, not mailed (2026-09-02): the holder reads `end` on `GET /api/me`, the grantor on
`GET /api/credentials`. No mailer.

- [ ] Work complete. Track's project feed exposes no such field, so `detail.cause: 'work-complete'`
      is unused and there is nothing to act on.

## P4-3 dual issuer in auth.js

Branch: `feat/entra-dual-issuer`. Blocked on the Entra app registration above.

- [ ] `src/helpers/auth.js`: `clientInstance` is a single module-level `jwksClient` bound to
      `config.ssoJwksUri` (`:139-147`) and `getKey` closes over it (`:149-157`). Replace both with an
      ISSUERS map `{ [iss]: { jwks, audience } }` built once at module load, and a `keyFor(issuer)`
      returning that issuer's `getKey`.
- [ ] `jwt.decode(token, { complete: true })` already runs at `:267`; take `payload.iss` from it and
      select the entry BEFORE `jwt.verify`. Unknown `iss` → 401, no verification attempted.
- [ ] `src/helpers/auth.js:274-280` options: `issuer` and `audience` both come from the selected
      entry.
- [ ] `rolesFor` (`src/helpers/access-sql.js:175-178`) reads `realm_access.roles`. Add the Entra
      `roles` claim as a second source; role names stay identical, so `ROLE_LEVELS` is untouched.
- [ ] `src/config.js:256-257`: `ssoJwksUri`/`ssoIssuer` stay; add optional `entraIssuer`,
      `entraJwksUri`, `entraAudience`. With none set the map has one entry and behaviour is unchanged.

Tests — `test/helpers/dual-issuer.test.js`

- [ ] `'a token from an unknown issuer is rejected without a JWKS fetch'` asserts 401 and that the
      jwks stub was never called. Fails if `iss` is read after verification.
- [ ] `'each issuer verifies against its own audience'` — a token valid for issuer A carrying issuer
      B's `aud` is rejected. Fails on a shared-audience shortcut.
- [ ] `'Entra roles claim maps to the same levels'` — `roles: ['staff']` with no `realm_access`
      resolves to level 2.

Acceptance

- [ ] `node --test test/helpers/*.test.js` — 0 fail.
- [ ] With no Entra config set, `curl -H "Authorization: Bearer $KC_TOKEN" $API/api/me` answers
      exactly as before the PR.

## P4-4 MSAL in the frontend

Branch: `feat/entra-msal-frontend`. Follows P4-3.

- [ ] `frontend/package.json:25` — replace the `keycloak-js` dependency with `@azure/msal-browser`.
- [ ] `frontend/src/app/services/registry-state.service.ts:823-831` — replace the Keycloak
      `init({ onLoad: 'check-sso', pkceMethod: 'S256', silentCheckSsoRedirectUri })` with MSAL
      `initialize()` + `ssoSilent()`; keep `authSettled()` (`:708`) as the single barrier so data
      loading still waits for auth.
- [ ] `:632-695` — the `window.fetch` patch: `this.keycloak.token` (`:659`) becomes an MSAL
      `acquireTokenSilent` result and `updateToken(30)` (`:671`) becomes that call's own refresh.
      Keep `isApiUrl` (`:617`) exactly as is — it is the guard that stops the bearer reaching the
      DataBC WFS.
- [ ] `loginKeycloak()` (`:866`) and `logout()` (`:1964`) move to MSAL equivalents; method names may
      stay so templates are untouched.
- [ ] `visLevel` still comes from `/api/me` — no claim parsing in the browser.

Tests — `frontend/src/app/services/registry-state.service.spec.ts`

- [ ] `'the interceptor attaches no token to a third-party URL'` calls the patched `fetch` with a
      DataBC URL and asserts no Authorization header. Fails on a regression of the `isApiUrl` guard.
- [ ] `'a 401 triggers exactly one silent refresh for concurrent calls'` — the `refreshPromise`
      single-flight (`:632`, `:670-690`) must survive the port. Fails if each call refreshes.

Acceptance

- [ ] `cd frontend && yarn lint && yarn test && yarn build` — green.
- [ ] `grep -c keycloak frontend/package.json` → 0.
- [ ] Manual: staff login through Entra, `/api/me` returns the expected level, project list renders.

## P4-5 remove the Keycloak issuer

Branch: `chore/entra-drop-keycloak`. Last of Phase 4.

- [ ] Delete the Keycloak entry from the ISSUERS map in `src/helpers/auth.js` and the
      `ssoIssuer`/`ssoJwksUri` lines (`src/config.js:256-257`) only after Entra has carried
      production traffic for a full business week. Date the window here: ______
- [ ] Keep `realm_access.roles` parsing in `rolesFor` until the API keys minted with realm role names
      are re-minted (`src/controllers/nosql/api-key.js:35` `GRANTABLE_ROLES`).
- [ ] `node --test` — 0 fail.
- [ ] A Keycloak token returns 401; an Entra token returns 200 on `/api/me`.

## P5b envelope encryption (optional, unscheduled)

Row-plane level 0 keeps plaintext in Cosmos, so a data-plane operator or a backup still reaches it.
Closing that means per-record envelope encryption under a Key Vault key in `demi-kv-<env>`.

- [ ] Take it only when the compartment holds real C&E material, and only with a second Function App
      whose own UAMI holds the sole Crypto User grant.

---

## Shipped

| Unit | What | PR | Date |
|---|---|---|---|
| U1 (part) | Four `docs/rbac-architecture.md` §3 questions closed | | 2026-08-28 |
| U2 | Merge/seed ACL constants read `access-sql.ADMIN_ROLES` | #199 | 2026-08-27 |
| U3 (test) | `DEMI_ALLOWED_CLIENTS` required in test and prod, enforced in `auth.js` | #199 | 2026-08-27 |
| U4 (test) | `SSO_AUDIENCE` verified when set; test pinned to `account` | #199 | 2026-08-28 |
| U5 | Admin API key in Key Vault | #207 | 2026-08-28 |
| U6 | `vis` level plumbing | #200 | 2026-08-27 |
| U7 | Projects field catalogue | #200 | 2026-08-27 |
| U8 | Redaction helper | #200 | 2026-08-27 |
| U9 | Projects redaction | #200 | 2026-08-27 |
| U10 | `select` projection honours the catalogue | #200 | 2026-08-27 |
| U11 | `PUT /api/projects/:id` rejects hidden keys | #200 | 2026-08-27 |
| Phase 1 close-out | Deployed to test, anonymous diff 0 lines | #201 | 2026-08-27 |
| P2-1 | Documents catalogue and document redaction | #203 | 2026-08-27 |
| P2-2 | Search parity: index-name catalogues, drift ratchet | #204 | 2026-08-27 |
| P2-3 | Query parameters gated by the catalogue | #205 | 2026-08-27 |
| P2-4 | `GET /api/me` | #202 | 2026-08-27 |
| P2-5 | Frontend level signal | #206 | 2026-08-27 |
| P3-0 | Track team feed: sync script, timer, infra, realm clients, project mirror | #216, #217, #268, #269, #276 | 2026-09-02 |
| P3-1 | `vis` carried through the two whole-item writers | #219 | 2026-08-28 |
| P3-2 | Ladder vocabulary `team`, `idir`, `staff` off the short-circuit | #220 | 2026-08-28 |
| P3-3 | New records admitted at level 1 | #270 | 2026-09-02 |
| P3-4 | `PUT /api/{projects,documents}/:id/level` | #221 | 2026-08-28 |
| P3-5 | Field dials and the classify endpoint | #222 | 2026-08-28 |
| P3-6 | Selected Credentials: container, middleware, endpoints, closed-project revoke | #231, #273, #278, #290 | 2026-08-31 |
| P3-7 | `vis` indexed in AI Search, reindex run (393 processed, 0 failed) | #226 | 2026-08-29 |
| P3-8 | `projectCACPublished` and the `cacPublished` predicate gated | #225 | 2026-08-28 |
| P3-9 | Takedown runbook | #221 | 2026-08-28 |
| P4-1 | Chunks catalogue | #275 | 2026-09-02 |
| P4-2 | Level-0 material in the runbook | #275 | 2026-09-02 |
| P5-1 | `readForLevel(0)` and the privileged exclusion | #264 | 2026-09-02 |
| P5-2 | Compartment routes `/api/sealed*` | #265 | 2026-09-02 |

## Parked

- `visLevelCap` on API keys, `GET /api/vis-catalog`, golden fixtures: dropped, see
  `docs/rbac-architecture.md` §2 item 13. Revisit only with a named consumer.
