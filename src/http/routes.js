'use strict';

const fs = require('fs');
const path = require('path');

const config = require('../config');
const authMiddleware = require('../middleware/auth');
const passiveAuthMiddleware = require('../middleware/passiveAuth');
// Layered on top of authMiddleware. `requireWrite` gates application data, so a read-only
// credential (demi-service-read) can be issued without also granting the ability to delete.
// `requireAdmin` is the narrower gate on /admin/*, so a machine writer (demi-service-write) can
// mirror data without being able to mint itself a wider credential.
const { requireWrite, requireAdmin, requireRole } = require('../middleware/require-roles');
// Loads the caller's Selected Credentials. Mounted after the auth layer on the read routes where a
// grant can widen what one caller sees — see middleware/credentials.js.
const { credentialsMiddleware } = require('../middleware/credentials');

// One data layer. The `USE_COSMOS_NOSQL` switch and the MongoDB-API controllers behind it are
// gone — the flag was the rollback path during the Cosmos cutover, and the account it fell back
// to is decommissioned.
//
// Required LAZILY, one accessor per controller: the route table is loaded on every cold start and
// `/health` must not pay for the Cosmos client, the search index definitions or pdf-lib.
const healthController = () => require('../controllers/health');
const configController = () => require('../controllers/config');
const meController = () => require('../controllers/me');
const dbController = () => require('../controllers/db');
const searchController = () => require('../controllers/search');
const wildfireController = () => require('../controllers/wildfire');
const projectController = () => require('../controllers/nosql/project');
const documentController = () => require('../controllers/nosql/document');
const boundaryController = () => require('../controllers/nosql/boundary');
const apiKeyController = () => require('../controllers/nosql/api-key');
const linkController = () => require('../controllers/nosql/link');
const credentialController = () => require('../controllers/nosql/credentials');
const userDataController = () => require('../controllers/nosql/userdata');

/**
 * Liveness only — the process is up. Deliberately does NOT claim anything about the database; it
 * once reported `db: true` unconditionally, so every probe stayed green with no database at all.
 * Inline because it is one line, and because it keeps a health probe's cold start free of requires.
 */
const liveness = (req, res) => res.json({ status: 'ok' });

/** The spec itself, not a UI: swagger-ui streamed its assets and could not be served here. */
const openApiSpec = (req, res) =>
  res.type('yaml').send(fs.readFileSync(path.join(__dirname, '..', 'swagger', 'swagger.yaml'), 'utf8'));

/**
 * Every route the API serves, in the order the dispatcher tries them. One leading `/api` is
 * stripped before matching, so each line covers both the `/api`-prefixed and root-mounted forms.
 */
const routes = [
  { method: 'get', path: '/health', guards: [], load: () => liveness },
  { method: 'get', path: '/health/db', guards: [], load: () => healthController().db },

  { method: 'get', path: '/config', guards: [], load: () => configController().getConfig },
  // Passive, not authMiddleware: an anonymous caller gets the public tier, not a 401.
  { method: 'get', path: '/me', guards: [passiveAuthMiddleware], load: () => meController().getMe },

  // Database Management Routes
  // Removed: /db/import and /db/query (generic bulk-write and arbitrary-query endpoints over
  // any collection — nothing called them, and under the NoSQL API they would have to become a
  // SQL passthrough). /db/seed-boundaries removed with the dead boundary seeder.
  //
  // Also removed: /db/seed, /sync, /admin/sync and /admin/seed-track. They drove the Mongo-era
  // scripts; src/scripts/seed-nosql.js replaces them and runs inside the network, not behind a
  // request that a 60k-document seed would outlive.
  { method: 'get', path: '/db/stats', guards: [authMiddleware], load: () => dbController().getDbStats },
  // Issues no container query at all, so it still answers when the counts behind /db/stats are
  // timing out. Ranked queries are only meaningful at progress 100, so this gates any bulk load.
  { method: 'get', path: '/admin/index-progress', guards: [authMiddleware], load: () => dbController().getIndexProgressHandler },

  { method: 'get', path: '/search', guards: [passiveAuthMiddleware, credentialsMiddleware], load: () => searchController().search },
  // authMiddleware, NOT passiveAuth — the summary is privileged-only in v1 while cost, abuse and the
  // wider disclosure surface of a synthesised paraphrase are measured. See wiki ADR-006.
  { method: 'get', path: '/search/summary', guards: [authMiddleware, credentialsMiddleware], load: () => searchController().summarize },

  // GET /wildfires removed — no consumer. The frontend reads the DataBC WFS directly, and the
  // project-level aggregate this sync writes is served with the project.
  { method: 'post', path: '/admin/sync/wildfires', guards: [authMiddleware, requireAdmin], load: () => wildfireController().syncWildfiresAdmin },

  // Projects Routes
  { method: 'get', path: '/projects', guards: [passiveAuthMiddleware, credentialsMiddleware], load: () => projectController().getProjects },
  { method: 'get', path: '/projects/:id', guards: [passiveAuthMiddleware, credentialsMiddleware], load: () => projectController().getProject },
  { method: 'post', path: '/projects', guards: [authMiddleware, requireWrite], load: () => projectController().createProject },
  { method: 'put', path: '/projects/:id', guards: [authMiddleware, requireWrite], load: () => projectController().updateProject },
  // Ladder moves — docs/rbac-architecture.md §1, "Widening is an act". Nothing else raises a level.
  { method: 'put', path: '/projects/:id/level', guards: [authMiddleware, requireWrite], load: () => projectController().setLevel },
  { method: 'delete', path: '/projects/:id', guards: [authMiddleware, requireWrite], load: () => projectController().deleteProject },
  // Classifying a field is narrower than writing one: `requireWrite` admits staff and the machine
  // writer, `sysadmin` is who may change the policy itself.
  { method: 'patch', path: '/projects/:id/visibility', guards: [authMiddleware, requireWrite, requireRole('sysadmin')], load: () => projectController().setVisibility },

  // Documents Routes
  { method: 'get', path: '/documents', guards: [passiveAuthMiddleware, credentialsMiddleware], load: () => documentController().getDocuments },
  { method: 'get', path: '/documents/:id', guards: [passiveAuthMiddleware, credentialsMiddleware], load: () => documentController().getDocument },
  // Presigned download link — ACL-gated inside the controller, same as the metadata read.
  { method: 'get', path: '/documents/:id/download', guards: [passiveAuthMiddleware, credentialsMiddleware], load: () => documentController().downloadDocument },
  { method: 'post', path: '/documents', guards: [authMiddleware, requireWrite], load: () => documentController().createDocument },
  // The multipart upload. The dispatcher writes the part to os.tmpdir() and hands the handler
  // `req.file`; the handler unlinks it, exactly as it did under multer.
  { method: 'post', path: '/documents/extract', guards: [authMiddleware, requireWrite], load: () => documentController().extractDocument },
  { method: 'put', path: '/documents/:id', guards: [authMiddleware, requireWrite], load: () => documentController().updateDocument },
  { method: 'put', path: '/documents/:id/level', guards: [authMiddleware, requireWrite], load: () => documentController().setLevel },
  // Deprecated alias for the line above — eagle-admin-console still sends `{ isPublished }`.
  { method: 'put', path: '/documents/:id/published', guards: [authMiddleware, requireWrite], load: () => documentController().setDocumentPublished },
  // Extracted-text ingest. The body is markdown for a whole document, or an NDJSON stream the
  // handler reads off `req.stream`. The caller supplies text only — never an ACL: read[] is copied
  // from the live document inside the controller, so an extraction host cannot widen visibility.
  { method: 'post', path: '/documents/:id/chunks', guards: [authMiddleware, requireWrite], load: () => documentController().ingestChunks },
  { method: 'delete', path: '/documents/:id', guards: [authMiddleware, requireWrite], load: () => documentController().deleteDocument },

  // Eagle mirror. eagle-api pushes fire-and-forget on every write it makes, keyed by its own `_id`;
  // DEMI holds the merge rules, so the body is the RAW Eagle record rather than a DEMI-shaped one.
  // Write-gated like every other mutation — the push authenticates as a registry key.
  { method: 'put', path: '/eagle/projects/:eagleId', guards: [authMiddleware, requireWrite], load: () => projectController().upsertFromEagle },
  { method: 'put', path: '/eagle/documents/:eagleId', guards: [authMiddleware, requireWrite], load: () => documentController().upsertFromEagle },

  // Boundaries (Borders) Routes. Regions went with an empty collection nothing consumed.
  { method: 'get', path: '/boundaries', guards: [passiveAuthMiddleware], load: () => boundaryController().getBoundaries },
  { method: 'get', path: '/boundaries/:id', guards: [passiveAuthMiddleware], load: () => boundaryController().getBoundary },
  { method: 'post', path: '/boundaries', guards: [authMiddleware, requireWrite], load: () => boundaryController().createBoundary },
  { method: 'put', path: '/boundaries/:id', guards: [authMiddleware, requireWrite], load: () => boundaryController().updateBoundary },
  { method: 'delete', path: '/boundaries/:id', guards: [authMiddleware, requireWrite], load: () => boundaryController().deleteBoundary },

  // API key administration. requireAdmin, NOT requireWrite: issuing a credential is the most
  // consequential mutation in the service, so neither a read-only consumer nor a machine writer may
  // mint itself a wider one. The plaintext key is returned by POST once and is unrecoverable after.
  { method: 'post', path: '/admin/api-keys', guards: [authMiddleware, requireAdmin], load: () => apiKeyController().createApiKey },
  // Admin-gated too, though it only reads: the credential registry is not application data.
  { method: 'get', path: '/admin/api-keys', guards: [authMiddleware, requireAdmin], load: () => apiKeyController().listApiKeys },
  { method: 'delete', path: '/admin/api-keys/:id', guards: [authMiddleware, requireAdmin], load: () => apiKeyController().revokeApiKey },

  // Selected Credentials. Same gate as the classify endpoint and for the same reason: a grant hands
  // a named party sight of records nobody widened, which is access policy rather than data. Reading
  // the registry is gated too — the rows name who may see what.
  { method: 'post', path: '/credentials', guards: [authMiddleware, requireWrite, requireRole('sysadmin')], load: () => credentialController().createCredential },
  { method: 'get', path: '/credentials', guards: [authMiddleware, requireWrite, requireRole('sysadmin')], load: () => credentialController().listCredentials },
  { method: 'post', path: '/credentials/revoke', guards: [authMiddleware, requireWrite, requireRole('sysadmin')], load: () => credentialController().revokeCredentials },

  // /s/:code has no auth: it's a public poster/email link, so anonymous browsing is the only caller.
  // Mutations require requireWrite: they decide where a gov.bc.ca URL sends the public.
  { method: 'get', path: '/links', guards: [authMiddleware], load: () => linkController().listLinks },
  { method: 'post', path: '/links', guards: [authMiddleware, requireWrite], load: () => linkController().createLink },
  { method: 'put', path: '/links/:code', guards: [authMiddleware, requireWrite], load: () => linkController().updateLink },
  { method: 'delete', path: '/links/:code', guards: [authMiddleware, requireWrite], load: () => linkController().deleteLink },
  { method: 'get', path: '/s/:code', guards: [], load: () => linkController().resolveLink },

  // The caller's own data, partitioned by the caller's own token. authMiddleware only, no
  // requireWrite: a read-only staff credential still gets to save its own scratch data.
  { method: 'get', path: '/me/data', guards: [authMiddleware], load: () => userDataController().getMyData },
  { method: 'put', path: '/me/lassos', guards: [authMiddleware], load: () => userDataController().saveLasso },
  { method: 'delete', path: '/me/lassos/:slug', guards: [authMiddleware], load: () => userDataController().deleteLasso },
  { method: 'put', path: '/me/prefs', guards: [authMiddleware], load: () => userDataController().putPrefs }
];

// NOT SERVED IN PROD. The spec names every route, parameter and role in the system, and this route
// is unauthenticated. An allowlist, not `!== 'prod'`: a deployment that forgets ENVIRONMENT must
// 404 the spec, not publish it.
if (['dev', 'test'].includes(config.environmentName)) {
  routes.push({ method: 'get', path: '/api-docs', guards: [], load: () => openApiSpec });
}

module.exports = routes;
