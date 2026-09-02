/** One entry per screen: adding a page is a row here, a route, and a component. */

export const GROUPS = ['Discover', 'Account', 'Operate', 'Reference'] as const;
export type Group = (typeof GROUPS)[number];

export interface Screen {
  key: string;
  label: string;
  /** null = reachable by router and the account menu, but not listed in the sidebar. */
  group: Group | null;
  path: string;
}

export const SCREENS: Screen[] = [
  { key: 'me', label: 'Overview', group: 'Account', path: '/workspace' },
  { key: 'sessions', label: 'Active sessions', group: 'Account', path: '/sessions' },
  { key: 'map', label: 'Map Explorer', group: 'Discover', path: '/map' },
  { key: 'index', label: 'Index Search', group: 'Discover', path: '/index' },
  { key: 'content', label: 'Document Content Search', group: 'Discover', path: '/content' },
  { key: 'summary', label: 'AI Summary', group: 'Discover', path: '/summary' },
  { key: 'notify', label: 'eagle-notify', group: 'Operate', path: '/notify' },
  { key: 'links', label: 'Short URLs', group: 'Operate', path: '/links' },
  { key: 'rbac', label: 'Access model', group: 'Reference', path: '/rbac' },
  { key: 'api', label: 'API documentation', group: 'Reference', path: '/developers' },
  { key: 'keys', label: 'API keys', group: 'Reference', path: '/keys' }
];

export interface Tech {
  title: string;
  chips: string[];
  note: string;
}

/** Per-screen technology provenance, drawn from the repo README and package manifests. */
export const TECH: Record<string, Tech> = {
  me: {
    title: 'My account',
    chips: ['Cosmos DB — userdata', 'GET /me/data', 'Keycloak token claims', 'localStorage preferences', 'Cosmos DB — links'],
    note: 'Saved areas and preferences arrive in one read of /me/data, keyed by the IDIR in the token, so the API never returns another account’s row. Name, email, IDIR, roles and groups are token claims and are read-only here. A preference change is written to this browser’s localStorage first and pushed to the account after, so it holds even when the API call fails. “Apply on map” writes the saved ring into the same shared signal the lasso tool writes, which is why Map Explorer already shows the shape when it opens. The short-link list is filtered in the browser from the rows the API was willing to send.'
  },
  map: {
    title: 'Map Explorer',
    chips: ['Leaflet + markercluster', 'OpenStreetMap tiles (keyless)', 'DataBC Wildfire WFS (live)', 'AI Search — projects (GeographyPoint)', 'Cosmos DB — boundaries'],
    note: 'Centroids are stored and returned as [longitude, latitude] end to end; boundary geometry comes from the boundaries container as GeoJSON. Tiles stay on OSM in every environment — CARTO watermarks every tile without an API key. The fire layer polls DataBC’s WFS straight from the browser; the backend’s own wildfire sync only tags project search results.'
  },
  index: {
    title: 'Index Search',
    chips: ['Azure AI Search (Basic)', 'projects, documents indexes', 'Cosmos DB NoSQL', '_ts high-water indexers', 'read[] ACL filter'],
    note: 'Indexers pull from Cosmos every five minutes; nothing is pushed. Counts use the same WHERE fragment as the read, so totals never leak hidden records.'
  },
  content: {
    title: 'Document Content Search',
    chips: ['AI Search — chunks index', 'Docling extraction (off-platform)', 'deterministic chunk ids', 'lexical BM25', 'MinIO / S3 download'],
    note: 'Ids take the form <documentId>::p<page>::c<index>, so a passage always resolves back to its page and re-ingest reconciles rather than duplicating. "Open document" resolves a five-minute presigned URL under the same ACL as the row.'
  },
  summary: {
    title: 'AI Summary',
    chips: ['Azure AI Foundry — gpt-4.1-mini', 'retrieval over chunks index', 'server-side citation resolution', 'managed identity, keyless', 'token-based cost estimate'],
    note: 'The model only ever emits a source number; the API maps those numbers back to real chunk ids under the caller’s access, which is what lets a citation render as a link.'
  },
  notify: {
    title: 'eagle-notify',
    chips: ['Keycloak bearer token', 'eagle-notify /staff/stats', 'Azure Communication Services'],
    note: 'DEMI holds no mailing list of its own. eagle-notify is a different origin, so the screen attaches the Keycloak token explicitly rather than through the app’s fetch interceptor. Figures are sample data until NOTIFY_API_LOCATION is configured and the stats call succeeds.'
  },
  links: {
    title: 'Short URLs',
    chips: ['Cosmos DB — links', 'eao-nginx rproxy', '302 no-store redirect', 'audit log'],
    note: 'Codes are 3–64 letters, digits, hyphens or underscores; left blank, DEMI generates one. Destinations must be an https gov.bc.ca address. Printed/emailed links resolve through projects.eao.gov.bc.ca, which rproxy forwards to demi-api — not through Front Door.'
  },
  rbac: {
    title: 'Access model',
    chips: ['Keycloak realm eao-epic', 'POST /access/simulate', 'access-sql.js resolveAccess / canRead', 'read[] + project scope', 'field catalog + dials'],
    note: 'Describe a caller — roles, identity provider, team projects, key project scope, a Selected Credential — and the screen posts it to the access engine, which answers with that caller’s level, tier, ladder rows and field catalogs. The screen holds no rules of its own, so it cannot drift from the API. Team project ids are a grant, opening the level-1 team arm; a projectScope list is the opposite, a restriction ANDed into every read that shows as tier scoped.'
  },
  keys: {
    title: 'API keys',
    chips: ['Cosmos DB — apikeys', 'SHA-256 + timingSafeEqual', 'Keycloak roles + scope', 'express-rate-limit', 'audit log'],
    note: 'A key’s roles and project scope are resolved before the privilege check, so a privileged key carrying a scope is privileged within those projects only. ADMIN_API_KEY is break-glass: one shared secret with no identity.'
  },
  sessions: {
    title: 'Active sessions',
    chips: ['keycloak-js', 'local token claims'],
    note: 'DEMI keeps no session store; tokens are stateless. This list reads only the current browser’s Keycloak token — other devices are not visible or revocable from here. Signing out ends this browser’s session at the identity provider, not any admin API call.'
  },
  api: {
    title: 'API documentation',
    chips: ['swagger-ui-express', 'Keycloak realm eao-epic', 'JWKS, RS256 pinned', 'registry API keys', 'express-rate-limit'],
    note: 'Swagger is mounted in dev and test only, so this link is a 404 anywhere else.'
  }
};

export const TECH_CHIP = 'display: inline-flex; padding: 0.1rem 0.45rem; border: var(--layout-border-width-small) solid var(--surface-color-border-default); border-radius: var(--layout-border-radius-circular); font: var(--typography-regular-label); background: var(--surface-color-background-white); color: var(--typography-color-secondary);';
