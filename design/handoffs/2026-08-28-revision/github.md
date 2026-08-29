repo: digitalspace/eagle-demi
branch: main
path: frontend/src

## Last sync

date: 2026-08-28T19:45:22Z

### Updated in this project

- Recreated the four current demo screens (Map Explorer, Deep Text Search, AI Summary, Document Intake) from the Angular source and its stylesheet.
- Built a revised front end: full Keycloak gate, header plus grouped left sidebar, eight screens.
- Split today's three-column Deep Search into Index Search and Document Content Search.
- Added eagle-notify and Short URLs screens grounded in the EPIC DEMI Admin design system (the eagle-notify repo was not reachable).
- Demo basemap uses keyless OpenStreetMap tiles; prod keeps the CARTO `light_all` URL from `map-explorer.component.ts:248`, which watermarks tiles without a key.
- Added Access model (RBAC) and API keys screens; the sharing levels come from the user-supplied "EAO Sharing Model — Levels and Definitions" draft, not from repo code.

## Screen map

| Project screen | Repo files |
|---|---|
| DEMI Demo (current).dc.html — shell and nav | frontend/src/app/app.component.html, app.component.ts, app.routes.ts, guards/auth.guard.ts, index.html, styles.css |
| DEMI Demo (current).dc.html — Map Explorer | frontend/src/app/components/map-explorer/map-explorer.component.html, map-explorer.component.ts |
| DEMI Demo (current).dc.html — Deep Text Search | frontend/src/app/components/deep-search/deep-search.component.html |
| DEMI Demo (current).dc.html — AI Summary | frontend/src/app/components/summarizer/summarizer.component.html |
| DEMI Demo (current).dc.html — Document Intake | frontend/src/app/components/document-intake/document-intake.component.html |
| Demo data used across both files | frontend/src/app/mocks/mock-registry.data.ts, frontend/src/app/models/registry.models.ts |
| DEMI Demo.dc.html — auth gate and roles | README.md (Authentication & authorization), frontend/src/app/guards/auth.guard.ts |
| DEMI Demo.dc.html — eagle-notify, Short URLs | EPIC DEMI Admin design system (EagleNotify, ShortUrls); eagle-notify repo not accessible |
| DEMI Demo.dc.html — API keys | EPIC DEMI Admin design system (ApiKeys); README.md "Authentication & authorization" |
| DEMI Demo.dc.html — Access model | uploads/EAO Sharing Model - Levels and Definitions.txt (user draft); README.md ADR-004 read ACL section |
