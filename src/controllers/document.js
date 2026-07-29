'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const extract = require('../extract');

const Document = require('../models/document');
const Project = require('../models/project');

const { rolesFor, withReadFilter, canRead, SECURE_ROLES } = require('../helpers/access');

exports.getDocuments = async (req, res) => {
  try {
    const roles = rolesFor(req);
    const { project } = req.query;
    const criteria = project ? { project: String(project) } : null;

    // Cap the page size — this endpoint previously returned the entire collection
    // (18k+ documents) in a single unpaginated response.
    const pageSize = Math.min(parseInt(req.query.pageSize || '1000', 10), 5000);
    const documents = await Document.find(withReadFilter(roles, criteria), { maxItemCount: pageSize });
    return res.json(documents);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.createDocument = async (req, res) => {
  try {
    const { project, displayName, s3Key, region, edrmsRecordNumber, orcsClassification, isPublished } = req.body;

    if (!project || !displayName || !s3Key) {
      return res.status(400).json({ error: 'Missing required fields: project, displayName, s3Key' });
    }

    const parentProject = await Project.findById(project);
    if (!parentProject) {
      return res.status(404).json({ error: `Parent Project with id ${project} not found.` });
    }

    // Fail closed, and never let a document out-rank its parent project: a doc can only
    // be public if the project is. Mirrors constrainToProject in typesense/transform.js.
    const requestedPublish = isPublished === true || isPublished === 'true';
    const parentIsPublic = Array.isArray(parentProject.read) && parentProject.read.length > 0
      ? parentProject.read.includes('public')
      : parentProject.isPublished === true;
    const published = requestedPublish && parentIsPublic;

    const newDoc = {
      _id: String(Date.now()),
      project: String(project),
      displayName,
      s3Key,
      region: region || parentProject.region || '',
      edrmsRecordNumber: edrmsRecordNumber || '',
      orcsClassification: orcsClassification || '',
      read: published ? ['public', ...SECURE_ROLES] : [...SECURE_ROLES],
      isPublished: published
    };

    const saved = await Document.upsert(newDoc);
    return res.status(201).json(saved);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.getDocument = async (req, res) => {
  try {
    const { id } = req.params;
    const roles = rolesFor(req);

    const doc = await Document.findById(id);
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    if (!canRead(doc, roles)) {
      return res.status(403).json({ error: 'Access denied. Document is not published.' });
    }

    return res.json(doc);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.updateDocument = async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await Document.findById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const updated = { ...existing, ...req.body };
    const saved = await Document.upsert(updated);
    return res.json(saved);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.deleteDocument = async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await Document.findById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Document not found' });
    }

    await Document.deleteById(id);
    return res.json({ message: 'Document deleted successfully', deleted: existing });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.extractDocument = async (req, res) => {
  try {
    const file = req.file;
    const { project, displayName, region, edrmsRecordNumber, orcsClassification, isPublished } = req.body;

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }
    if (!project) {
      if (file.path) fs.promises.unlink(file.path).catch(() => {});
      return res.status(400).json({ error: 'A valid project id is required.' });
    }

    const parentProject = await Project.findById(project);
    if (!parentProject) {
      if (file.path) fs.promises.unlink(file.path).catch(() => {});
      return res.status(404).json({ error: `Parent Project with id ${project} not found.` });
    }

    const fileExtension = file.originalname.match(/\.([0-9a-z]+$)/i)?.[1] || '';
    const randomizedName = crypto.randomBytes(16).toString('hex') + (fileExtension ? '.' + fileExtension : '');
    const objectPath = path.posix.join(project.toString(), randomizedName);

    const minioClient = extract.getMinioClient();
    const exists = await minioClient.bucketExists(config.minioBucket);
    if (!exists) {
      await minioClient.makeBucket(config.minioBucket);
    }

    await minioClient.fPutObject(config.minioBucket, objectPath, file.path);
    fs.promises.unlink(file.path).catch(() => {});

    const newDoc = {
      _id: String(Date.now()),
      project: String(project),
      displayName: displayName || file.originalname,
      s3Key: objectPath,
      region: region || parentProject.region || '',
      edrmsRecordNumber: edrmsRecordNumber || '',
      orcsClassification: orcsClassification || '',
      isPublished: isPublished === 'true' || isPublished === true
    };

    const saved = await Document.upsert(newDoc);

    return res.status(202).json({
      message: 'File stored and extraction queued.',
      docId: String(saved._id)
    });
  } catch (err) {
    if (req.file && req.file.path) fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(500).json({ error: err.message });
  }
};
