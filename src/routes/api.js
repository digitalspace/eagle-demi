'use strict';

const express = require('express');
const router = express.Router();

const authMiddleware = require('../middleware/auth');
const passiveAuthMiddleware = require('../middleware/passiveAuth');
// Layered on top of authMiddleware for anything that mutates, so a read-only credential
// (demi-service-read) can be issued without also granting the ability to delete.
const { requireWrite } = require('../middleware/require-roles');

// One data layer. The `USE_COSMOS_NOSQL` switch and the MongoDB-API controllers behind it are
// gone — the flag was the rollback path during the Cosmos cutover, and the account it fell back
// to is decommissioned.
//
// The two layers were never abstracted behind a common interface, deliberately: they took
// fundamentally different inputs (Mongo filter objects vs an access context), and an adapter
// over both is precisely the shape that let a half-working translator disable access control in
// this codebase.
const projectController = require('../controllers/nosql/project');
const documentController = require('../controllers/nosql/document');
const boundaryController = require('../controllers/nosql/boundary');
const apiKeyController = require('../controllers/nosql/api-key');

const wildfireController = require('../controllers/wildfire');
const searchController = require('../controllers/search');

// GET /admin/logs removed with the Cosmos log transport — logs are stdout only, read through the
// App Service log stream and Log Analytics.

const dbController = require('../controllers/db');
const configController = require('../controllers/config');

// Config Route
router.get('/config', configController.getConfig);

// Database Management Routes
// Removed: /db/import and /db/query (generic bulk-write and arbitrary-query endpoints over
// any collection — nothing called them, and under the NoSQL API they would have to become a
// SQL passthrough). /db/seed-boundaries removed with the dead boundary seeder.
//
// Also removed: /db/seed, /sync, /admin/sync and /admin/seed-track. They drove the Mongo-era
// scripts; src/scripts/seed-nosql.js replaces them and runs inside the network, not behind a
// request that a 60k-document seed would outlive.
router.get('/db/stats', authMiddleware, dbController.getDbStats);
// Issues no container query at all, so it still answers when the counts behind /db/stats are
// timing out. Ranked queries are only meaningful at progress 100, so this gates any bulk load.
router.get('/admin/index-progress', authMiddleware, dbController.getIndexProgressHandler);

// Search Route
router.get('/search', passiveAuthMiddleware, searchController.search);
// authMiddleware, NOT passiveAuth — the summary is privileged-only in v1 while cost, abuse and the
// wider disclosure surface of a synthesised paraphrase are measured. See wiki ADR-006.
router.get('/search/summary', authMiddleware, searchController.summarize);

// Wildfire Routes
// GET /wildfires removed — no consumer. The frontend reads the DataBC WFS directly, and the
// project-level aggregate this sync writes is served with the project.
router.post('/admin/sync/wildfires', authMiddleware, requireWrite, wildfireController.syncWildfiresAdmin);

// Projects Routes
router.get('/projects', passiveAuthMiddleware, projectController.getProjects);
router.get('/projects/:id', passiveAuthMiddleware, projectController.getProject);
router.post('/projects', authMiddleware, requireWrite, projectController.createProject);
router.put('/projects/:id', authMiddleware, requireWrite, projectController.updateProject);
router.delete('/projects/:id', authMiddleware, requireWrite, projectController.deleteProject);

// Documents Routes
const multer = require('multer');
const config = require('../config');
const upload = multer({ dest: config.uploadDir });

router.get('/documents', passiveAuthMiddleware, documentController.getDocuments);
router.get('/documents/:id', passiveAuthMiddleware, documentController.getDocument);
// Presigned download link — ACL-gated inside the controller, same as the metadata read.
router.get('/documents/:id/download', passiveAuthMiddleware, documentController.downloadDocument);
router.post('/documents', authMiddleware, requireWrite, documentController.createDocument);
router.post('/documents/extract', authMiddleware, requireWrite, upload.single('upfile'), documentController.extractDocument);
router.put('/documents/:id', authMiddleware, requireWrite, documentController.updateDocument);
// Publish / unpublish — the mechanism for hiding a document from public and proponents.
// Deletion is for genuine removal, not for hiding. Unconditional now: the guard existed only
// because the Mongo controller had no equivalent handler to mount.
router.put('/documents/:id/published', authMiddleware, requireWrite, documentController.setDocumentPublished);
// Extracted-text ingest. The body is markdown for a whole document.
//
// No route-level body parser: app.js already applies express.json({limit:'10mb'}) globally and
// body-parser sets req._body, so a second instance here would silently no-op — it never raised the
// limit it appeared to raise. 10mb of markdown is ~10M characters, far past any real document; a
// document that does exceed it gets a 413 the worker records as an extraction error.
//
// The caller supplies text only — never an ACL: read[] is copied from the live document inside
// the controller, so an extraction host cannot widen a document's visibility.
router.post('/documents/:id/chunks', authMiddleware, requireWrite, documentController.ingestChunks);
router.delete('/documents/:id', authMiddleware, requireWrite, documentController.deleteDocument);

// Eagle mirror. eagle-api pushes fire-and-forget on every write it makes, keyed by its own `_id`;
// DEMI holds the merge rules, so the body is the RAW Eagle record rather than a DEMI-shaped one.
// Write-gated like every other mutation — the push authenticates as a registry key.
router.put('/eagle/projects/:eagleId', authMiddleware, requireWrite, projectController.upsertFromEagle);
router.put('/eagle/documents/:eagleId', authMiddleware, requireWrite, documentController.upsertFromEagle);

// Regions routes removed — the collection is empty (0 items) and nothing consumed it.
// Administrative geography is served by /boundaries.

// Boundaries (Borders) Routes
router.get('/boundaries', passiveAuthMiddleware, boundaryController.getBoundaries);
router.get('/boundaries/:id', passiveAuthMiddleware, boundaryController.getBoundary);
router.post('/boundaries', authMiddleware, requireWrite, boundaryController.createBoundary);
router.put('/boundaries/:id', authMiddleware, requireWrite, boundaryController.updateBoundary);
router.delete('/boundaries/:id', authMiddleware, requireWrite, boundaryController.deleteBoundary);

// API key administration. Write-gated because issuing a credential is the most consequential
// mutation in the service — a read-only consumer must never be able to mint itself a writer.
// The plaintext key is returned by POST once and is unrecoverable afterwards.
router.post('/admin/api-keys', authMiddleware, requireWrite, apiKeyController.createApiKey);
// Write-gated too, though it only reads: the credential registry is not application data. A
// read-only consumer holding demi-service-read is privileged enough for authMiddleware, and
// without this it could enumerate every consumer, role set and expiry in the deployment.
router.get('/admin/api-keys', authMiddleware, requireWrite, apiKeyController.listApiKeys);
router.delete('/admin/api-keys/:id', authMiddleware, requireWrite, apiKeyController.revokeApiKey);

module.exports = router;
