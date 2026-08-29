/** One entry per screen: adding a page is a row here, a route, and a component. */

export const GROUPS = ['Discover', 'Operate', 'Access', 'Developers'] as const;
export type Group = (typeof GROUPS)[number];

export interface Screen {
  key: string;
  label: string;
  /** null = reachable by router and the account menu, but not listed in the sidebar. */
  group: Group | null;
  path: string;
}

export const SCREENS: Screen[] = [
  { key: 'profile', label: 'Profile and preferences', group: null, path: '/profile' },
  { key: 'sessions', label: 'Active sessions', group: null, path: '/sessions' },
  { key: 'map', label: 'Map Explorer', group: 'Discover', path: '/map' },
  { key: 'index', label: 'Index Search', group: 'Discover', path: '/index' },
  { key: 'content', label: 'Document Content Search', group: 'Discover', path: '/content' },
  { key: 'summary', label: 'AI Summary', group: 'Discover', path: '/summary' },
  { key: 'intake', label: 'Document Intake', group: 'Operate', path: '/intake' },
  { key: 'notify', label: 'eagle-notify', group: 'Operate', path: '/notify' },
  { key: 'links', label: 'Short URLs', group: 'Operate', path: '/links' },
  { key: 'rbac', label: 'Access model', group: 'Access', path: '/rbac' },
  { key: 'api', label: 'API documentation', group: 'Developers', path: '/developers' },
  { key: 'keys', label: 'API keys', group: 'Developers', path: '/keys' }
];

export interface Tech {
  title: string;
  chips: string[];
  note: string;
}

/** Per-screen technology provenance, drawn from the repo README and package manifests. */
export const TECH: Record<string, Tech> = {
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
  intake: {
    title: 'Document Intake',
    chips: ['Express 5 on Functions v4', 'MinIO / S3 object store', 'Docling (off-platform)', 'chunker.js → Cosmos', 'AI Search indexer PT5M'],
    note: 'This screen only uploads the file and creates the document row. Extraction runs off-platform and returns as markdown to POST /documents/:id/chunks, where chunker.js assigns each chunk its id; the AI Search indexer picks the new chunks up within five minutes.'
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
    chips: ['Keycloak realm eao-epic', 'GET /me', 'access-sql.js / access-odata.js', 'read[] + project scope', 'field-level redaction (preview)'],
    note: 'A record is visible when its read[] array intersects the caller’s roles. Project scope is a second, orthogonal dimension: privilege lifts the role predicate, never the project one. Field-level rules are being defined — this screen previews the intended behaviour.'
  },
  keys: {
    title: 'API keys',
    chips: ['Cosmos DB — apikeys', 'SHA-256 + timingSafeEqual', 'Keycloak roles + scope', 'express-rate-limit', 'audit log'],
    note: 'A key’s roles and project scope are resolved before the privilege check, so a privileged key carrying a scope is privileged within those projects only. ADMIN_API_KEY is break-glass: one shared secret with no identity.'
  },
  profile: {
    title: 'Profile and preferences',
    chips: ['Keycloak realm eao-epic', 'token claims', 'localStorage preferences'],
    note: 'Name, email, IDIR, roles and groups are token claims and are read-only here. Preferences (landing screen, page size) persist to this browser’s localStorage only — nothing here is written to Cosmos.'
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
