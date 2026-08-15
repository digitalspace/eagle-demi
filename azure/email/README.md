# EPIC Email Service (EAGLE Mail)

ACS Email (send pipe) + [listmonk](https://listmonk.app) (campaign/template UI for
non-technical staff) + PostgreSQL Flexible Server behind a private endpoint.
Standalone stack — deliberately not wired into `azure/main.bicep` (not part of the
DEMI estate). Dev prove-out lives at `epic-listmonk-dev.azurewebsites.net` in
`c4b0a8-dev-rg`.

## Deploy

```bash
export EPIC_EMAIL_PG_PASSWORD='...'        # Postgres admin
export EPIC_EMAIL_LISTMONK_PASSWORD='...'  # listmonk epicadmin bootstrap
export EPIC_EMAIL_SMTP_PRINCIPAL_ID='...'  # Entra SP object id (empty on first pass)

az deployment group what-if -g c4b0a8-dev-rg -f email.bicep -p email.dev.bicepparam
az deployment group create  -g c4b0a8-dev-rg -f email.bicep -p email.dev.bicepparam
```

Two passes when starting from nothing: deploy once with `EPIC_EMAIL_SMTP_PRINCIPAL_ID`
empty, register/reuse an Entra app for SMTP auth, then redeploy with the SP object id —
the template adds the "Communication and Email Service Owner" role assignment
(Contributor is blocked by the landing zone's ABAC condition on role delegation).

The container startup command is `sh /home/start.sh`; put this there via Kudu
(App Service mangles quoted inline commands — exits 2 in <1s with no logs):

```sh
#!/bin/sh
cd /listmonk
./listmonk --install --idempotent --yes && exec ./listmonk
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
- OIDC (staff IDIR login): Keycloak client `epic-listmonk` in realm `eao-epic` on
  loginproxy, redirect `<root_url>/auth/oidc`. Users must pre-exist in listmonk with
  their IDIR email (auto-create off).

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
(copies live in `eagle-public/src/assets/fonts/BCSans/`). Set
`upload.filesystem.upload_path` = `/home/uploads` first so uploads survive container
rebuilds, and point Settings → General logo/favicon URLs at the crest.

Admin CSS notes: the app stylesheet loads *after* custom.css, so contested props need
`!important`; the navbar logo is a data-URI SVG baked into the Vue bundle, swapped via
`content: url()`. Don't recolor `.navbar` text — it breaks the profile dropdown.
