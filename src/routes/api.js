'use strict';

const express = require('express');
const router = express.Router();

const authMiddleware = require('../middleware/auth');
const projectController = require('../controllers/project');
const documentController = require('../controllers/document');
const regionController = require('../controllers/region');
const boundaryController = require('../controllers/boundary');
const searchController = require('../controllers/search');

// Search Route
router.get('/search', searchController.search);

// Projects Routes
router.get('/projects', projectController.getProjects);
router.get('/projects/:id', projectController.getProject);
router.post('/projects', authMiddleware, projectController.createProject);
router.put('/projects/:id', authMiddleware, projectController.updateProject);
router.delete('/projects/:id', authMiddleware, projectController.deleteProject);

// Documents Routes
const multer = require('multer');
const config = require('../config');
const upload = multer({ dest: config.uploadDir });

router.get('/documents', documentController.getDocuments);
router.get('/documents/:id', documentController.getDocument);
router.post('/documents', authMiddleware, documentController.createDocument);
router.post('/documents/extract', authMiddleware, upload.single('upfile'), documentController.extractDocument);
router.put('/documents/:id', authMiddleware, documentController.updateDocument);
router.delete('/documents/:id', authMiddleware, documentController.deleteDocument);

// Regions Routes
router.get('/regions', regionController.getRegions);
router.get('/regions/:id', regionController.getRegion);
router.post('/regions', authMiddleware, regionController.createRegion);
router.put('/regions/:id', authMiddleware, regionController.updateRegion);
router.delete('/regions/:id', authMiddleware, regionController.deleteRegion);

// Boundaries (Borders) Routes
router.get('/boundaries', boundaryController.getBoundaries);
router.get('/boundaries/:id', boundaryController.getBoundary);
router.post('/boundaries', authMiddleware, boundaryController.createBoundary);
router.put('/boundaries/:id', authMiddleware, boundaryController.updateBoundary);
router.delete('/boundaries/:id', authMiddleware, boundaryController.deleteBoundary);

module.exports = router;
