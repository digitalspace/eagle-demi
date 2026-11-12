'use strict';

const fs = require('fs');
const path = require('path');

const config = require('../config');
const authMiddleware = require('../middleware/auth');
const passiveAuthMiddleware = require('../middleware/passiveAuth');
const {
  requireWrite, requireAdmin, requireRole, requireEagleMirror, requireEngageWriter, requirePdfTitleWorker
} = require('../middleware/require-roles');
const { credentialsMiddleware } = require('../middleware/credentials');
// The sealed compartment's own verifier. NOT authMiddleware — see middleware/sealed-auth.js.
const sealedAuth = require('../middleware/sealed-auth');

// Required lazily: the table loads on every cold start, and /health must not pay for the Cosmos
// client, the search index definitions or pdf-lib.
const healthController = () => require('../controllers/health');
const configController = () => require('../controllers/config');
const gateController = () => require('../controllers/gate');
const meController = () => require('../controllers/me');
const accessSimulateController = () => require('../controllers/access-simulate');
const dbController = () => require('../controllers/db');
const adminReadsController = () => require('../controllers/admin-reads');
const searchController = () => require('../controllers/search');
const searchSchemaController = () => require('../controllers/search-schema');
const searchDefinitionsController = () => require('../controllers/search-definitions');
const wildfireController = () => require('../controllers/wildfire');
const projectController = () => require('../controllers/nosql/project');
const projectSummaryController = () => require('../controllers/project-summary');
const documentController = () => require('../controllers/nosql/document');
const updateController = () => require('../controllers/nosql/update');
const commentPeriodController = () => require('../controllers/nosql/comment-period');
const engageCommentPeriodController = () => require('../controllers/nosql/engage-comment-period');
const commentController = () => require('../controllers/nosql/comment');
const organizationController = () => require('../controllers/nosql/organization');
const notificationController = () => require('../controllers/nosql/notification');
const boundaryController = () => require('../controllers/nosql/boundary');
const bulkDownloadController = () => require('../controllers/nosql/bulk-download');
const apiKeyController = () => require('../controllers/nosql/api-key');
const linkController = () => require('../controllers/nosql/link');
const credentialController = () => require('../controllers/nosql/credentials');
const userDataController = () => require('../controllers/nosql/userdata');
const sealedController = () => require('../controllers/nosql/sealed');
const pdfTitleController = () => require('../controllers/nosql/pdf-title');
const userController = () => require('../controllers/nosql/user');
const groupController = () => require('../controllers/nosql/group');
const inspectionController = () => require('../controllers/nosql/inspection');
const commentExportController = () => require('../controllers/nosql/comment-export');
const reportController = () => require('../controllers/report');

// Liveness only: says nothing about the database, and stays inline so the probe requires nothing.
const liveness = (req, res) => res.json({ status: 'ok' });

/** The spec itself, not a UI: swagger-ui streamed its assets and could not be served here. */
const openApiSpec = (req, res) =>
  res.type('yaml').send(fs.readFileSync(path.join(__dirname, '..', 'swagger', 'swagger.yaml'), 'utf8'));

// Tried in order. One leading `/api` is stripped before matching, so each line serves both the
// `/api`-prefixed and the root form.
const routes = [
  { method: 'get', path: '/health', guards: [], load: () => liveness },
  { method: 'get', path: '/health/db', guards: [], load: () => healthController().db },
  { method: 'get', path: '/health/trust', guards: [], load: () => healthController().trust },
  // Anonymous so a deploy job can probe before it holds a token; POST lets CI send its own selects.
  // APIM cannot throttle anonymous callers, so controllers/search-schema.js caps each request.
  { method: 'get', path: '/health/search-schema', guards: [], load: () => searchSchemaController().searchSchema },
  { method: 'post', path: '/health/search-schema', guards: [], load: () => searchSchemaController().searchSchema },

  // Reads nothing from the request, so anonymous access adds no query load per request.
  { method: 'get', path: '/health/search-data', guards: [], load: () => searchSchemaController().searchData },

  { method: 'get', path: '/config', guards: [], load: () => configController().getConfig },
  // A separate document from /config so neither frontend's keys can widen the other's.
  // A missing document answers 503, never a defaulted payload.
  { method: 'get', path: '/config/public', guards: [], load: () => configController().getPublicConfig },
  // No guards by design: the visitor holds nothing yet and the body's password is the only
  // credential. The gateway cannot throttle it on this tier; see controllers/gate.js.
  { method: 'post', path: '/gate', guards: [], load: () => gateController().postGate },
  // Anonymous gets the public tier. `strict`: a rejected Bearer must 401 so the admin console
  // refreshes instead of reading itself as public.
  { method: 'get', path: '/me', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => meController().getMe },
  // Authenticated though it reads no container: the answer discloses the whole field catalog and
  // what each role may see.
  { method: 'post', path: '/access/simulate', guards: [authMiddleware], load: () => accessSimulateController().simulate },

  { method: 'get', path: '/db/stats', guards: [authMiddleware], load: () => dbController().getDbStats },
  // Issues no container query, so it answers while /db/stats times out. Ranked queries are only
  // meaningful at progress 100, so this gates any bulk load.
  { method: 'get', path: '/admin/index-progress', guards: [authMiddleware], load: () => dbController().getIndexProgressHandler },

  { method: 'get', path: '/search', guards: [passiveAuthMiddleware, credentialsMiddleware], load: () => searchController().search },
  // The counts are ACL-scoped, so credentials must load before the filters are built.
  { method: 'get', path: '/search/counts', guards: [passiveAuthMiddleware, credentialsMiddleware], load: () => searchController().counts },
  // Privileged only while cost, abuse and the disclosure risk of a generated paraphrase are
  // measured. See wiki ADR-006.
  { method: 'get', path: '/search/summary', guards: [authMiddleware, credentialsMiddleware], load: () => searchController().summarize },

  { method: 'post', path: '/admin/sync/wildfires', guards: [authMiddleware, requireAdmin], load: () => wildfireController().syncWildfiresAdmin },

  // Reading Azure back for the admin panel. The panel holds a Keycloak token and Azure wants an
  // Entra one, so the API queries with its own identity — see src/azure/monitor.js.
  { method: 'get', path: '/admin/audit', guards: [authMiddleware, requireAdmin], load: () => adminReadsController().getAudit },
  { method: 'get', path: '/admin/analytics', guards: [authMiddleware, requireAdmin], load: () => adminReadsController().getAnalytics },
  { method: 'get', path: '/admin/cost', guards: [authMiddleware, requireAdmin], load: () => adminReadsController().getCost },
  // Written by the reconcileEagle timer; this only reads the row back.
  { method: 'get', path: '/admin/reconcile', guards: [authMiddleware, requireAdmin], load: () => adminReadsController().getReconcileReport },
  // Written by the reconcileEngage timer.
  { method: 'get', path: '/admin/reconcile-engage', guards: [authMiddleware, requireAdmin], load: () => adminReadsController().getReconcileEngageReport },

  // `strict` answers a rejected Bearer with its 401, not the public view.
  { method: 'get', path: '/projects', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => projectController().getProjects },
  { method: 'get', path: '/project-records', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => require('../controllers/native/project-records').getProjectRecords },
  { method: 'get', path: '/counts', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => require('../controllers/native/counts').counts },
  { method: 'get', path: '/projects/:id', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => projectController().getProject },
  // Every AI surface is privileged-only for now. A point read of a record generated offline;
  // nothing here calls a model.
  { method: 'get', path: '/projects/:id/summary', guards: [authMiddleware, credentialsMiddleware], load: () => projectSummaryController().getProjectSummary },
  // A read-only credential must not store prose that renders as EAO's account of a project.
  { method: 'put', path: '/projects/:id/summary', guards: [authMiddleware, requireWrite], load: () => projectSummaryController().putProjectSummary },
  { method: 'post', path: '/projects', guards: [authMiddleware, requireWrite], load: () => projectController().createProject },
  { method: 'put', path: '/projects/:id', guards: [authMiddleware, requireWrite], load: () => projectController().updateProject },
  // Ladder moves — docs/rbac-architecture.md §1, "Widening is an act". Nothing else raises a level.
  { method: 'put', path: '/projects/:id/level', guards: [authMiddleware, requireWrite], load: () => projectController().setLevel },
  // Staff only: requireAdmin is the existing gate that leaves out the machine writer.
  { method: 'put', path: '/projects/:id/short-code', guards: [authMiddleware, requireAdmin], load: () => projectController().setShortCode },
  { method: 'delete', path: '/projects/:id', guards: [authMiddleware, requireWrite], load: () => projectController().deleteProject },
  { method: 'put', path: '/projects/:id/restore', guards: [authMiddleware, requireWrite], load: () => projectController().restoreProject },
  // Classifying a field is narrower than writing one: only sysadmin may change the policy.
  { method: 'patch', path: '/projects/:id/visibility', guards: [authMiddleware, requireWrite, requireRole('sysadmin')], load: () => projectController().setVisibility },

  { method: 'get', path: '/documents', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => documentController().getDocuments },
  // Literal paths sit before `/documents/:id`, or they would be read as a document id.
  // Credential only, so an anonymous caller cannot scrape past the native list's offset cap.
  { method: 'get', path: '/documents/scan', guards: [authMiddleware, credentialsMiddleware], load: () => documentController().scanDocuments },
  { method: 'get', path: '/documents/passages', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => require('../controllers/native/passages').getPassages },
  { method: 'get', path: '/documents/recent-uploads', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => documentController().getRecentUploads },
  { method: 'get', path: '/documents/pdf-title/pending', guards: [authMiddleware, requireWrite, requirePdfTitleWorker], load: () => pdfTitleController().listPending },
  { method: 'post', path: '/documents/pdf-title/sweep', guards: [authMiddleware, requireWrite, requirePdfTitleWorker], load: () => pdfTitleController().sweep },
  { method: 'get', path: '/documents/:id', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => documentController().getDocument },
  // ACL-gated inside the controller, same as the metadata read.
  { method: 'get', path: '/documents/:id/download', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => documentController().downloadDocument },
  { method: 'post', path: '/documents', guards: [authMiddleware, requireWrite], load: () => documentController().createDocument },
  // The dispatcher writes the file part to os.tmpdir() as `req.file`, deleted when the request ends.
  { method: 'post', path: '/documents/extract', guards: [authMiddleware, requireWrite], multipart: true, load: () => documentController().extractDocument },
  // Answers a write-only link to the scanned intake account; the row stays hidden until clean.
  { method: 'post', path: '/intake/uploads', guards: [authMiddleware, requireWrite], load: () => require('../controllers/native/intake').createUpload },
  { method: 'get', path: '/intake/uploads/:id', guards: [authMiddleware, credentialsMiddleware], load: () => require('../controllers/native/intake').getUpload },
  { method: 'put', path: '/documents/:id', guards: [authMiddleware, requireWrite], load: () => documentController().updateDocument },
  { method: 'put', path: '/documents/:id/level', guards: [authMiddleware, requireWrite], load: () => documentController().setLevel },
  // Deprecated alias for the line above — eagle-admin-console still sends `{ isPublished }`.
  { method: 'put', path: '/documents/:id/published', guards: [authMiddleware, requireWrite], load: () => documentController().setDocumentPublished },
  // The caller sends text only: read[] is copied from the live document, so an extraction host
  // cannot widen visibility.
  { method: 'post', path: '/documents/:id/chunks', guards: [authMiddleware, requireWrite], load: () => documentController().ingestChunks },
  // The only route that returns full chunk text, for the summary generator outside the VNet.
  // The parent-document ACL is re-applied inside the controller.
  { method: 'get', path: '/documents/:id/chunks', guards: [authMiddleware, credentialsMiddleware], load: () => projectSummaryController().getDocumentChunks },
  { method: 'delete', path: '/documents/:id', guards: [authMiddleware, requireWrite], load: () => documentController().deleteDocument },
  // The only routes that sign a write to a stored original.
  { method: 'post', path: '/documents/:id/pdf-title/lease', guards: [authMiddleware, requireWrite, requirePdfTitleWorker], load: () => pdfTitleController().lease },
  { method: 'post', path: '/documents/:id/pdf-title/commit', guards: [authMiddleware, requireWrite, requirePdfTitleWorker], load: () => pdfTitleController().commit },
  { method: 'put', path: '/documents/:id/pdf-title', guards: [authMiddleware, requireWrite, requirePdfTitleWorker], load: () => pdfTitleController().report },

  // The ACL runs in the controller, so anonymous gets the public tier. The job id is the
  // capability for status and cancel: a foreign or unknown id is a 404, never a 403.
  { method: 'post', path: '/bulk-downloads', guards: [passiveAuthMiddleware, credentialsMiddleware], load: () => bulkDownloadController().createBulkDownload },
  { method: 'get', path: '/bulk-downloads/:id', guards: [passiveAuthMiddleware, credentialsMiddleware], load: () => bulkDownloadController().getBulkDownload },
  { method: 'delete', path: '/bulk-downloads/:id', guards: [passiveAuthMiddleware, credentialsMiddleware], load: () => bulkDownloadController().cancelBulkDownload },

  // Sealed compartment, level 0. Not authMiddleware: it 403s `compliance`, the only role that
  // belongs here. Every route audits, reads included.
  { method: 'post', path: '/sealed', guards: [sealedAuth, requireRole('compliance')], load: () => sealedController().createSealed },
  { method: 'get', path: '/sealed', guards: [sealedAuth, requireRole('compliance')], load: () => sealedController().listSealed },
  { method: 'get', path: '/sealed/:id', guards: [sealedAuth, requireRole('compliance')], load: () => sealedController().getSealed },
  { method: 'get', path: '/sealed/:id/download', guards: [sealedAuth, requireRole('compliance')], load: () => sealedController().downloadSealed },
  // The only exit from level 0; PUT /documents/:id/level refuses it in both directions.
  { method: 'post', path: '/sealed/:id/release', guards: [sealedAuth, requireRole('compliance')], load: () => sealedController().releaseSealed },

  // eagle-api pushes the raw Eagle record keyed by its `_id`; DEMI holds the merge rules.
  // Pinned to DEMI_EAGLE_MIRROR_PRINCIPALS because the handlers write any project.
  { method: 'put', path: '/eagle/projects/:eagleId', guards: [authMiddleware, requireWrite, requireEagleMirror], load: () => projectController().upsertFromEagle },
  { method: 'put', path: '/eagle/documents/:eagleId', guards: [authMiddleware, requireWrite, requireEagleMirror], load: () => documentController().upsertFromEagle },
  { method: 'put', path: '/eagle/updates/:eagleId', guards: [authMiddleware, requireWrite, requireEagleMirror], load: () => updateController().upsertFromEagle },
  { method: 'put', path: '/eagle/commentperiods/:eagleId', guards: [authMiddleware, requireWrite, requireEagleMirror], load: () => commentPeriodController().upsertFromEagle },
  { method: 'put', path: '/eagle/comments/:eagleId', guards: [authMiddleware, requireWrite, requireEagleMirror], load: () => commentController().upsertFromEagle },
  { method: 'put', path: '/eagle/organizations/:eagleId', guards: [authMiddleware, requireWrite, requireEagleMirror], load: () => organizationController().upsertFromEagle },
  { method: 'put', path: '/eagle/notifications/:eagleId', guards: [authMiddleware, requireWrite, requireEagleMirror], load: () => notificationController().upsertFromEagle },
  { method: 'put', path: '/eagle/users/:eagleId', guards: [authMiddleware, requireWrite, requireEagleMirror], load: () => userController().upsertFromEagle },
  { method: 'put', path: '/eagle/groups/:eagleId', guards: [authMiddleware, requireWrite, requireEagleMirror], load: () => groupController().upsertFromEagle },
  { method: 'put', path: '/eagle/inspections/:eagleId', guards: [authMiddleware, requireWrite, requireEagleMirror], load: () => inspectionController().upsertInspectionFromEagle },
  { method: 'put', path: '/eagle/inspection-elements/:eagleId', guards: [authMiddleware, requireWrite, requireEagleMirror], load: () => inspectionController().upsertElementFromEagle },
  { method: 'put', path: '/eagle/inspection-items/:eagleId', guards: [authMiddleware, requireWrite, requireEagleMirror], load: () => inspectionController().upsertItemFromEagle },
  // One public config document with no Eagle id: the body is the payload, not `{ doc }`, and only
  // PUBLIC_KEYS are stored.
  { method: 'put', path: '/eagle/config/public', guards: [authMiddleware, requireWrite, requireEagleMirror], load: () => configController().upsertPublicFromEagle },
  // No PUT /eagle/lists: Eagle writes lists only in migrations, so the backfill fills `lists`.

  // ENGAGE owns these comment periods; DEMI writes them on to Eagle (src/sync-out).
  { method: 'put', path: '/engage/engagements/:engagementId', guards: [authMiddleware, requireWrite, requireEngageWriter], load: () => engageCommentPeriodController().upsertFromEngage },

  ...require('./routes-track'),

  // The repository filters rows by access, so anonymous reads the public tier. `strict`: a
  // rejected Bearer is a 401, so a client refreshes instead of reading the public tier.
  { method: 'get', path: '/users', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => userController().getUsers },
  { method: 'get', path: '/users/:id', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => userController().getUser },
  { method: 'get', path: '/groups', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => groupController().getGroups },
  { method: 'get', path: '/groups/:id', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => groupController().getGroup },
  { method: 'get', path: '/inspections', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => inspectionController().getInspections },
  { method: 'get', path: '/inspections/:id', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => inspectionController().getInspection },
  { method: 'get', path: '/inspection-elements', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => inspectionController().getInspectionElements },
  { method: 'get', path: '/inspection-elements/:id', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => inspectionController().getInspectionElement },
  { method: 'get', path: '/inspection-items', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => inspectionController().getInspectionItems },
  { method: 'get', path: '/inspection-items/:id', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => inspectionController().getInspectionItem },

  { method: 'get', path: '/lists', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => require('../controllers/native/lists').getLists },
  { method: 'get', path: '/lists/:id', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => require('../controllers/native/lists').getList },
  { method: 'get', path: '/organizations', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => require('../controllers/native/organizations').getOrganizations },
  { method: 'get', path: '/organizations/:id', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => require('../controllers/native/organizations').getOrganization },

  { method: 'get', path: '/comment-periods', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => require('../controllers/native/comment-periods').getCommentPeriods },
  { method: 'get', path: '/comment-periods/:id', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => require('../controllers/native/comment-periods').getCommentPeriod },
  { method: 'get', path: '/comment-periods/:id/summary', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => require('../controllers/native/comment-periods').getCommentPeriodSummary },
  { method: 'get', path: '/comments', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => require('../controllers/native/comments').getComments },
  { method: 'get', path: '/comments/:id', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => require('../controllers/native/comments').getComment },

  // `/updates/feed` before `/updates/:id`, or `feed` would be read as an id.
  { method: 'get', path: '/updates', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => require('../controllers/native/updates').getUpdates },
  { method: 'get', path: '/updates/feed', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => require('../controllers/native/updates').getFeed },
  { method: 'get', path: '/updates/:id', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => require('../controllers/native/updates').getUpdate },
  { method: 'get', path: '/notifications', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => require('../controllers/native/notifications').getNotifications },
  { method: 'get', path: '/notifications/:id', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => require('../controllers/native/notifications').getNotification },
  { method: 'get', path: '/suggest', guards: [passiveAuthMiddleware.strict, credentialsMiddleware], load: () => require('../controllers/native/suggest').getSuggestions },

  // Comment export is signed in only and the caller's level picks the columns. The BCGW feed
  // reads as anonymous whoever asks.
  { method: 'get', path: '/commentperiods/:periodId/comments/export', guards: [authMiddleware, credentialsMiddleware], load: () => commentExportController().exportComments },
  { method: 'get', path: '/reports', guards: [passiveAuthMiddleware], load: () => reportController().getReport },

  { method: 'get', path: '/boundaries', guards: [passiveAuthMiddleware], load: () => boundaryController().getBoundaries },
  { method: 'get', path: '/boundaries/:id', guards: [passiveAuthMiddleware], load: () => boundaryController().getBoundary },
  { method: 'post', path: '/boundaries', guards: [authMiddleware, requireWrite], load: () => boundaryController().createBoundary },
  { method: 'put', path: '/boundaries/:id', guards: [authMiddleware, requireWrite], load: () => boundaryController().updateBoundary },
  { method: 'delete', path: '/boundaries/:id', guards: [authMiddleware, requireWrite], load: () => boundaryController().deleteBoundary },

  // requireAdmin, not requireWrite: a machine writer must not mint itself a wider key. POST returns
  // the plaintext key once; it cannot be read again.
  { method: 'post', path: '/admin/api-keys', guards: [authMiddleware, requireAdmin], load: () => apiKeyController().createApiKey },
  // Admin-gated too, though it only reads: the credential registry is not application data.
  { method: 'get', path: '/admin/api-keys', guards: [authMiddleware, requireAdmin], load: () => apiKeyController().listApiKeys },
  { method: 'delete', path: '/admin/api-keys/:id', guards: [authMiddleware, requireAdmin], load: () => apiKeyController().revokeApiKey },

  // Narrowest gate: a live run rebuilds an index the app queries. Work runs on a queue because a
  // chunks rebuild outlives the ~230 s request cap by hours.
  { method: 'post', path: '/admin/search-definitions/apply', guards: [authMiddleware, requireAdmin, requireRole('sysadmin')], load: () => searchDefinitionsController().applySearchDefinitions },
  // Same gate on the read: the steps name what was PUT where, which is service configuration.
  { method: 'get', path: '/admin/search-definitions/jobs/:id', guards: [authMiddleware, requireAdmin, requireRole('sysadmin')], load: () => searchDefinitionsController().getSearchDefinitionJob },

  // A grant shows a named party records nobody widened: access policy, so sysadmin only. Reads
  // too, since the rows name who may see what.
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

  // No requireWrite: a read-only staff credential may still save its own scratch data.
  { method: 'get', path: '/me/data', guards: [authMiddleware], load: () => userDataController().getMyData },
  { method: 'put', path: '/me/lassos', guards: [authMiddleware], load: () => userDataController().saveLasso },
  { method: 'delete', path: '/me/lassos/:slug', guards: [authMiddleware], load: () => userDataController().deleteLasso },
  { method: 'put', path: '/me/queries', guards: [authMiddleware], load: () => userDataController().saveQuery },
  { method: 'delete', path: '/me/queries/:slug', guards: [authMiddleware], load: () => userDataController().deleteQuery },
  { method: 'put', path: '/me/prefs', guards: [authMiddleware], load: () => userDataController().putPrefs },

  // Ported routes go under their own `port:` anchor, guarded by requireRole(<x-security-scopes>).

  // port: organizations
  // eagle-api's auth admits sysadmin and staff on every route (api/helpers/auth.js:35-43), so both join the scopes.
  { method: 'post', path: '/organizations', guards: [authMiddleware, requireRole('staff', 'sysadmin')], load: () => require('../controllers/native/organizations').createOrganization },
  { method: 'put', path: '/organizations/:id', guards: [authMiddleware, requireRole('project-system-admin', 'sysadmin', 'staff')], load: () => require('../controllers/native/organizations').updateOrganization },
  { method: 'put', path: '/organizations/:id/publish', guards: [authMiddleware, requireRole('project-system-admin', 'sysadmin', 'staff')], load: () => require('../controllers/native/organizations').publishOrganization },
  { method: 'put', path: '/organizations/:id/unpublish', guards: [authMiddleware, requireRole('project-system-admin', 'sysadmin', 'staff')], load: () => require('../controllers/native/organizations').unpublishOrganization },

  // port: comment-periods
  { method: 'post', path: '/comment-periods', guards: [authMiddleware, requireRole('staff', 'sysadmin')], load: () => require('../controllers/native/comment-periods-write').createCommentPeriod },
  { method: 'put', path: '/comment-periods/:id', guards: [authMiddleware, requireRole('staff', 'sysadmin')], load: () => require('../controllers/native/comment-periods-write').updateCommentPeriod },
  { method: 'delete', path: '/comment-periods/:id', guards: [authMiddleware, requireRole('staff', 'sysadmin')], load: () => require('../controllers/native/comment-periods-write').deleteCommentPeriod },
  { method: 'put', path: '/comment-periods/:id/publish', guards: [authMiddleware, requireRole('staff', 'sysadmin')], load: () => require('../controllers/native/comment-periods-write').publishCommentPeriod },
  { method: 'put', path: '/comment-periods/:id/unpublish', guards: [authMiddleware, requireRole('staff', 'sysadmin')], load: () => require('../controllers/native/comment-periods-write').unpublishCommentPeriod },

  // port: comments
  { method: 'post', path: '/comments', guards: [authMiddleware, requireRole('staff', 'sysadmin')], load: () => require('../controllers/native/comments-write').createComment },
  { method: 'put', path: '/comments/:id', guards: [authMiddleware, requireRole('staff', 'sysadmin')], load: () => require('../controllers/native/comments-write').updateComment },
  { method: 'put', path: '/comments/:id/status', guards: [authMiddleware, requireRole('staff', 'sysadmin')], load: () => require('../controllers/native/comments-write').setCommentStatus },

  // port: groups
  { method: 'get', path: '/groups/:id/members', guards: [authMiddleware, requireRole('project-system-admin', 'sysadmin', 'staff')], load: () => require('../controllers/native/groups').getGroupMembers },
  { method: 'post', path: '/groups', guards: [authMiddleware, requireRole('project-system-admin', 'sysadmin', 'staff')], load: () => require('../controllers/native/groups-write').createGroup },
  { method: 'put', path: '/groups/:id', guards: [authMiddleware, requireRole('project-system-admin', 'sysadmin', 'staff')], load: () => require('../controllers/native/groups-write').updateGroup },
  { method: 'delete', path: '/groups/:id', guards: [authMiddleware, requireRole('project-system-admin', 'sysadmin', 'staff')], load: () => require('../controllers/native/groups-write').deleteGroup },
  { method: 'post', path: '/groups/:id/members', guards: [authMiddleware, requireRole('project-system-admin', 'sysadmin', 'staff')], load: () => require('../controllers/native/groups-write').addGroupMembers },
  { method: 'delete', path: '/groups/:id/members/:userId', guards: [authMiddleware, requireRole('project-system-admin', 'sysadmin', 'staff')], load: () => require('../controllers/native/groups-write').removeGroupMember },

  // port: updates
  { method: 'post', path: '/updates', guards: [authMiddleware, requireRole('project-system-admin', 'sysadmin', 'staff')], load: () => require('../controllers/native/updates-write').createUpdate },
  { method: 'put', path: '/updates/:id', guards: [authMiddleware, requireRole('project-system-admin', 'sysadmin', 'staff')], load: () => require('../controllers/native/updates-write').updateUpdate },
  { method: 'delete', path: '/updates/:id', guards: [authMiddleware, requireRole('project-system-admin', 'sysadmin', 'staff')], load: () => require('../controllers/native/updates-write').archiveUpdate },

  // port: notifications
  { method: 'post', path: '/notifications', guards: [authMiddleware, requireRole('staff', 'sysadmin')], load: () => require('../controllers/native/notifications-write').createNotification },
  { method: 'put', path: '/notifications/:id', guards: [authMiddleware, requireRole('staff', 'sysadmin')], load: () => require('../controllers/native/notifications-write').updateNotification },
  { method: 'put', path: '/notifications/:id/publish', guards: [authMiddleware, requireRole('staff', 'sysadmin')], load: () => require('../controllers/native/notifications-write').publishNotification },
  { method: 'put', path: '/notifications/:id/unpublish', guards: [authMiddleware, requireRole('staff', 'sysadmin')], load: () => require('../controllers/native/notifications-write').unpublishNotification },

  // port: users
  { method: 'post', path: '/users', guards: [authMiddleware, requireRole('project-system-admin', 'sysadmin', 'staff')], load: () => require('../controllers/native/users').createUser },
  { method: 'put', path: '/users/:id', guards: [authMiddleware, requireRole('project-system-admin', 'sysadmin', 'staff')], load: () => require('../controllers/native/users').updateUser },

  // port: extensions
  { method: 'get', path: '/projects/:id/extensions', guards: [authMiddleware, requireRole('staff', 'sysadmin')], load: () => require('../controllers/native/extensions').getExtensions },
  { method: 'post', path: '/projects/:id/extensions', guards: [authMiddleware, requireRole('staff', 'sysadmin')], load: () => require('../controllers/native/extensions').createExtension },
  { method: 'put', path: '/projects/:id/extensions/:extId', guards: [authMiddleware, requireRole('staff', 'sysadmin')], load: () => require('../controllers/native/extensions').updateExtension },
  { method: 'delete', path: '/projects/:id/extensions/:extId', guards: [authMiddleware, requireRole('staff', 'sysadmin')], load: () => require('../controllers/native/extensions').deleteExtension },

  // port: sitemap
  { method: 'get', path: '/sitemap.xml', guards: [], load: () => require('../controllers/sitemap').getSitemap },

  // port: cac
  { method: 'get', path: '/projects/:id/cac', guards: [authMiddleware, requireRole('staff', 'sysadmin')], load: () => require('../controllers/native/cac').getCac },
  { method: 'post', path: '/projects/:id/cac', guards: [authMiddleware, requireRole('staff', 'sysadmin')], load: () => require('../controllers/native/cac').createCac },
  { method: 'delete', path: '/projects/:id/cac', guards: [authMiddleware, requireRole('staff', 'sysadmin')], load: () => require('../controllers/native/cac').deleteCac },
  { method: 'put', path: '/projects/:id/cac/publish', guards: [authMiddleware, requireRole('staff', 'sysadmin')], load: () => require('../controllers/native/cac').publishCac },
  { method: 'put', path: '/projects/:id/cac/unpublish', guards: [authMiddleware, requireRole('staff', 'sysadmin')], load: () => require('../controllers/native/cac').unpublishCac },
  { method: 'post', path: '/projects/:id/cac/members/remove', guards: [authMiddleware, requireRole('staff', 'sysadmin')], load: () => require('../controllers/native/cac').removeCacMember },

  // port: document-feature
];

// Unauthenticated and names every route and role, so an allowlist: a deployment that forgets
// ENVIRONMENT must 404 the spec, not publish it.
if (['dev', 'test'].includes(config.environmentName)) {
  routes.push({ method: 'get', path: '/api-docs', guards: [], load: () => openApiSpec });
}

module.exports = routes;
