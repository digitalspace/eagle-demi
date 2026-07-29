'use strict';

const express = require('express');
const router = express.Router();

const authMiddleware = require('../middleware/auth');
const passiveAuthMiddleware = require('../middleware/passiveAuth');

// ── Data-layer selection ─────────────────────────────────────────────────────
// The single switch between the MongoDB-API controllers and the Cosmos NoSQL ones. The two
// take fundamentally different inputs (Mongo filter objects vs an access context), so they
// are NOT abstracted behind a common interface — an adapter over both is precisely the shape
// that let a half-working translator disable access control in this codebase.
//
// One conditional at the router keeps dev running on Mongo until COSMOS_ENDPOINT is set.
// At cutover, setting that variable flips every route at once; the legacy controllers and
// this branch are deleted together in the final phase.
const USE_NOSQL = Boolean(process.env.COSMOS_ENDPOINT);

const projectController = USE_NOSQL
  ? require('../controllers/nosql/project')
  : require('../controllers/project');
const documentController = USE_NOSQL
  ? require('../controllers/nosql/document')
  : require('../controllers/document');
const boundaryController = USE_NOSQL
  ? require('../controllers/nosql/boundary')
  : require('../controllers/boundary');
const recordController = USE_NOSQL
  ? require('../controllers/nosql/record')
  : require('../controllers/record');

if (USE_NOSQL) {
  console.log('[routes] Cosmos NoSQL data layer active (COSMOS_ENDPOINT is set).');
}
const wildfireController = require('../controllers/wildfire');
const searchController = require('../controllers/search');
const logController = require('../controllers/log');

// Logs Route (Admin Only)
router.get('/admin/logs', authMiddleware, logController.getLogs);

const dbController = require('../controllers/db');
const configController = require('../controllers/config');

// Config Route
router.get('/config', configController.getConfig);

// Database Management & Seeding Routes
// Removed: /db/import and /db/query (generic bulk-write and arbitrary-query endpoints over
// any collection — nothing called them, and under the NoSQL API they would have to become a
// SQL passthrough). /db/seed-boundaries removed with the dead boundary seeder.
router.get('/db/stats', authMiddleware, dbController.getDbStats);
router.post('/db/seed', authMiddleware, dbController.seedDatabase);
router.post('/sync', authMiddleware, dbController.seedDatabase);
router.post('/admin/sync', authMiddleware, dbController.runNightlySyncHandler);
router.post('/admin/sync/nrpti', authMiddleware, dbController.runNrptiSyncHandler);
router.post('/admin/seed-track', authMiddleware, dbController.seedTrackDatabase);

// Search Route
router.get('/search', passiveAuthMiddleware, searchController.search);

// Compliance Records Routes
router.get('/records', passiveAuthMiddleware, recordController.getRecords);
router.get('/records/:id', passiveAuthMiddleware, recordController.getRecord);

// Wildfire Routes
router.get('/wildfires', passiveAuthMiddleware, wildfireController.getWildfires);
router.post('/admin/sync/wildfires', authMiddleware, wildfireController.syncWildfiresAdmin);

// Projects Routes
router.get('/projects', passiveAuthMiddleware, projectController.getProjects);
router.get('/projects/:id', passiveAuthMiddleware, projectController.getProject);
router.post('/projects', authMiddleware, projectController.createProject);
router.put('/projects/:id', authMiddleware, projectController.updateProject);
router.delete('/projects/:id', authMiddleware, projectController.deleteProject);

// Documents Routes
const multer = require('multer');
const config = require('../config');
const upload = multer({ dest: config.uploadDir });

router.get('/documents', passiveAuthMiddleware, documentController.getDocuments);
router.get('/documents/:id', passiveAuthMiddleware, documentController.getDocument);
// Presigned download link — ACL-gated inside the controller, same as the metadata read.
router.get('/documents/:id/download', passiveAuthMiddleware, documentController.downloadDocument);
router.post('/documents', authMiddleware, documentController.createDocument);
router.post('/documents/extract', authMiddleware, upload.single('upfile'), documentController.extractDocument);
router.put('/documents/:id', authMiddleware, documentController.updateDocument);
router.delete('/documents/:id', authMiddleware, documentController.deleteDocument);

// Regions routes removed — the collection is empty (0 items) and nothing consumed it.
// Administrative geography is served by /boundaries.

// Boundaries (Borders) Routes
router.get('/boundaries', passiveAuthMiddleware, boundaryController.getBoundaries);
router.get('/boundaries/:id', passiveAuthMiddleware, boundaryController.getBoundary);
router.post('/boundaries', authMiddleware, boundaryController.createBoundary);
router.put('/boundaries/:id', authMiddleware, boundaryController.updateBoundary);
router.delete('/boundaries/:id', authMiddleware, boundaryController.deleteBoundary);

module.exports = router;
