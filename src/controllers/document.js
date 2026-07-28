'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const extract = require('../extract');

const Document = require('../models/document');
const Project = require('../models/project');

function isAdmin(req) {
  if (req.user) {
    const roles = req.user.realm_access?.roles || [];
    return roles.includes('sysadmin') || roles.includes('staff') || roles.includes('demi-admin');
  }
  const apiKey = req.header('X-Api-Key');
  const expectedKey = process.env.DOCLING_API_KEY;
  if (expectedKey && apiKey && apiKey === expectedKey) return true;
  if (process.env.NODE_ENV === 'test' && apiKey === 'eagle-demi-api-key') return true;
  return false;
}

exports.getDocuments = async (req, res) => {
  try {
    const isAuth = isAdmin(req);
    const conditions = [];
    if (!isAuth) {
      conditions.push('c.isPublished = true');
    }
    const whereClause = conditions.length > 0 ? conditions.join(' AND ') : '';
    const documents = await Document.find(whereClause);
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

    const newDoc = {
      _id: String(Date.now()),
      project: String(project),
      displayName,
      s3Key,
      region: region || parentProject.region || '',
      edrmsRecordNumber: edrmsRecordNumber || '',
      orcsClassification: orcsClassification || '',
      isPublished: isPublished !== undefined ? Boolean(isPublished) : false
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
    const isAuth = isAdmin(req);

    const doc = await Document.findById(id);
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    if (!isAuth && !doc.isPublished) {
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
