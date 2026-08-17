# EPIC Email Service (EAGLE Mail)

ACS Email (send pipe) + [listmonk](https://listmonk.app) (campaign/template UI for
non-technical staff) + PostgreSQL Flexible Server behind a private endpoint.
Standalone stack — deliberately not wired into `azure/main.bicep` (not part of the
DEMI estate).

| Env | Subscription | RG | Host |
|---|---|---|---|
| dev | `d2f8d048-2af3-44fd-81cc-858c040001f2` | `c4b0a8-dev-rg` | `epic-listmonk-dev.azurewebsites.net` |
| test | `7897ceb1-9a86-4639-87d7-7f9ff67142b3` | `c4b0a8-test-rg` | `epic-listmonk-test.azurewebsites.net` |

## Deploy

Always pass `--subscription`. The CLI's active subscription on a dev machine is usually
`c4b0a8-prod`, and neither command below carries the RG's subscription implicitly.

One-time per subscription, or the first run fails `MissingSubscriptionRegistration`
part-way through:

```bash
az provider register -n Microsoft.Communication --subscription <sub>
```

```bash
export EPIC_EMAIL_PG_PASSWORD='...'        # Postgres admin, >= 8 chars
export EPIC_EMAIL_LISTMONK_PASSWORD='...'  # listmonk epicadmin bootstrap, >= 8 chars
export EPIC_EMAIL_SMTP_PRINCIPAL_ID='...'  # Entra SP object id (empty only on a first-ever pass)

# test
az deployment group what-if -g c4b0a8-test-rg --subscription 7897ceb1-9a86-4639-87d7-7f9ff67142b3 \
  -f email.bicep -p email.test.bicepparam
az deployment group create  -g c4b0a8-test-rg --subscription 7897ceb1-9a86-4639-87d7-7f9ff67142b3 \
  -f email.bicep -p email.test.bicepparam

# dev
az deployment group create  -g c4b0a8-dev-rg --subscription d2f8d048-2af3-44fd-81cc-858c040001f2 \
  -f email.bicep -p email.dev.bicepparam
```

Both passwords carry `@minLength(8)`: an unset env var fails at submit time instead of
booting a listmonk with no super-admin, whose public hostname then offers the
account-creation page to the first visitor.

Two passes only when the Entra app does not exist yet: deploy once with
`EPIC_EMAIL_SMTP_PRINCIPAL_ID` empty, register/reuse an app for SMTP auth, then redeploy
with the SP object id — the template adds the "Communication and Email Service Owner"
role assignment (Contributor is blocked by the landing zone's ABAC condition on role
delegation). The SP is tenant-wide, so any environment after the first is a single pass.

### Seed start.sh (required — the app crash-loops without it)

`appCommandLine` is `sh /home/start.sh` because App Service mangles quoted inline commands
(exits 2 in <1s with no logs). The template cannot create that file: `/home` is the per-app
Azure Files share and starts empty, so a fresh site restarts forever while ARM reports
`Succeeded`. PUT `start.sh` from this directory via Kudu VFS **before first boot**, then
`az webapp stop` / `start` (not `restart`).

SCM basic auth is allowed on these sites today, but the AAD path is the estate default:

```bash
TOK=$(az account get-access-token --resource https://management.core.windows.net/ --query accessToken -o tsv)
curl -X PUT -H "Authorization: Bearer $TOK" -H 'If-Match: *' \
  --data-binary @start.sh \
  https://epic-listmonk-<env>.scm.azurewebsites.net/api/vfs/start.sh
```

## Post-deploy settings (live in listmonk's DB, not bicep)

Settings → in the UI, or `PUT /api/settings`.

- `app.root_url` = the public hostname. Default `localhost:9000` breaks every
  unsubscribe/view link.
- `app.site_name` = `EAGLE Mail`.
- SMTP: `smtp.azurecomm.net:587` STARTTLS, username
  `<ACSResourceName>.<EntraAppId>.<TenantId>`, password = Entra app client secret.
  Azure-managed domain is rate-capped 5/min, 10/hr (no raises; custom domain 30/min
  after CITZ DNS + support ticket).
- OIDC (staff IDIR login): Keycloak client `epic-listmonk` in realm `eao-epic`, redirect
  `<root_url>/auth/oidc`. Users must pre-exist in listmonk with their IDIR email
  (auto-create off). dev/test/prod loginproxy are **three separate Keycloak installations** —
  a client in one realm does not exist in the others and its secret does not carry over, so
  each environment needs its own SSO request. Issuer per environment:
  `https://{dev,test,}loginproxy.gov.bc.ca/auth`. Today the client exists on
  **dev.loginproxy only**.
  Remove the dev redirect URI when the dev app is deleted: `azurewebsites.net` names are
  released globally on delete, so a dangling `epic-listmonk-dev.azurewebsites.net` redirect
  lets whoever registers that name next receive authorization codes for the realm.

**Trap:** `PUT /api/settings` stores the masked `••` placeholder secrets literally.
Every settings write — including UI-adjacent API automation — must re-send the real
`smtp[].password` and `security.oidc.client_secret`, or sends fail with ACS
`535 5.7.3` and IDIR login fails with `unauthorized_client`.

Postgres needs `azure.extensions = PGCRYPTO` (in the template) or
`listmonk --install` fails. A wedged app needs `az webapp stop`/`start`, not restart.

## Branding (theme/)

EAGLE Mail: white header, crest-only BC logo, BC Sans, design-system tokens
(blue `#013366`, gold `#FCBA19`, link `#255A90`, text `#2D2D2D`).

Paste into Settings → Appearance:

| File | Box |
|---|---|
| `theme/admin-custom.css` | Admin → Custom CSS |
| `theme/admin-custom.js` | Admin → Custom JS (tab title + favicon — Vue bundle hardcodes both) |
| `theme/public-custom.css` | Public → Custom CSS (login + subscribe/unsubscribe pages) |

Assets referenced as `/uploads/...` must exist in listmonk media (Media page):
`theme/bc-crest-navy.png` plus `BCSans-Regular.woff2` / `BCSans-Bold.woff2`
(copies live in `eagle-public/src/assets/fonts/BCSans/`) and
`bcgov-header-vert-SM.png` for the favicon (from `eagle-public/src/assets/images/`).
Set `upload.filesystem.upload_path` = `/home/uploads` first so uploads survive container
rebuilds, and point Settings → General logo/favicon URLs at the crest.

listmonk does **not** create that directory — the first upload fails
`500 open /home/uploads/<file>: no such file or directory`. Create it once via Kudu
(trailing slash makes a directory):

```bash
curl -X PUT -H "Authorization: Bearer $TOK" \
  https://epic-listmonk-<env>.scm.azurewebsites.net/api/vfs/uploads/
```

Admin CSS notes: the app stylesheet loads *after* custom.css, so contested props need
`!important`; the navbar logo is a data-URI SVG baked into the Vue bundle, swapped via
`content: url()`. Don't recolor `.navbar` text — it breaks the profile dropdown.
