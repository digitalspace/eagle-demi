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
- Demo basemap uses keyless OpenStreetMap tiles; prod kept the CARTO `light_all` URL from the Angular map, which watermarks tiles without a key. Obsolete: the React map (`frontend/src/map/basemaps.tsx`) uses keyless Esri tiles.
- Added Access model (RBAC) and API keys screens; the sharing levels come from the user-supplied "EAO Sharing Model — Levels and Definitions" draft, not from repo code.

## Screen map

| Project screen | Repo files |
|---|---|
| DEMI Demo (current).dc.html — shell and nav | frontend/src/App.tsx, routes.tsx, shell/Shell.tsx, shell/screens.ts, index.html, styles.css |
| DEMI Demo (current).dc.html — Map Explorer | frontend/src/screens/MapExplorer.tsx, frontend/src/map/ |
| DEMI Demo (current).dc.html — Deep Text Search | frontend/src/screens/UnifiedSearch.tsx, frontend/src/search/ (index and document content search are one page now) |
| DEMI Demo (current).dc.html — AI Summary | frontend/src/screens/Summarizer.tsx |
| DEMI Demo (current).dc.html — Document Intake | Obsolete: the React app has no intake screen |
| Demo data used across both files | Obsolete: the React app ships no mock registry; frontend/src/api/types.ts holds the record types, frontend/parity/fixtures/ the sample API answers |
| DEMI Demo.dc.html — auth gate and roles | README.md (Authentication & authorization), frontend/src/App.tsx (`Gate`), frontend/src/shell/SignIn.tsx, frontend/src/session/SessionProvider.tsx |
| DEMI Demo.dc.html — eagle-notify, Short URLs | EPIC DEMI Admin design system (EagleNotify, ShortUrls); eagle-notify repo not accessible |
| DEMI Demo.dc.html — API keys | EPIC DEMI Admin design system (ApiKeys); README.md "Authentication & authorization" |
| DEMI Demo.dc.html — Access model | uploads/EAO Sharing Model - Levels and Definitions.txt (user draft); README.md ADR-004 read ACL section |
