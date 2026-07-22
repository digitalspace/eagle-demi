'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const config = require('../config');
const extract = require('../extract');

const Document = require('../models/document');
const Project = require('../models/project');
const Region = require('../models/region');

// Helper to determine if the request is administrative / internal
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
    const { region: regionName } = req.query;
    const isAuth = isAdmin(req);

    // Build the query object based on auth and region
    let query = {};
    if (!isAuth) {
      // Find all published project IDs
      const publishedProjects = await Project.find({ isPublished: true }).select('_id');
      const publishedProjIds = publishedProjects.map(p => p._id);

      query.isPublished = true;
      query.project = { $in: publishedProjIds };
    }

    if (regionName) {
      const regionDoc = await Region.findOne({ name: regionName });
      if (!regionDoc) {
        return res.status(404).json({ error: 'Region not found' });
      }

      // Find projects whose centroid point falls inside the region's boundary
      const projectQuery = {
        centroid: { $geoWithin: { $geometry: regionDoc.geometry } }
      };
      if (!isAuth) {
        projectQuery.isPublished = true;
      }

      const projects = await Project.find(projectQuery).select('_id');
      const projectIds = projects.map(p => p._id);

      // Intersect project IDs
      if (query.project) {
        query.project = { $in: projectIds.filter(id => query.project.$in.some(pid => pid.toString() === id.toString())) };
      } else {
        query.project = { $in: projectIds };
      }

      const documents = await Document.find(query).populate('project');
      return res.json(documents);
    }

    const documents = await Document.find(query).populate('project');
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

    // Verify parent project exists
    const parentProject = await Project.findById(project);
    if (!parentProject) {
      return res.status(404).json({ error: `Parent Project with id ${project} not found. Documents must always belong to an existing project.` });
    }

    const newDoc = new Document({
      project,
      displayName,
      s3Key,
      region: region || parentProject.region,
      edrmsRecordNumber,
      orcsClassification,
      isPublished: isPublished !== undefined ? isPublished : false
    });

    const saved = await newDoc.save();
    return res.status(201).json(saved);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Document with s3Key or edrmsRecordNumber already exists' });
    }
    return res.status(500).json({ error: err.message });
  }
};

exports.getDocument = async (req, res) => {
  try {
    const { id } = req.params;
    const isAuth = isAdmin(req);

    const doc = await Document.findById(id).populate('project');
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Enforce publication checks for public users
    if (!isAuth) {
      if (!doc.isPublished || !doc.project || !doc.project.isPublished) {
        return res.status(403).json({ error: 'Access denied. This document or its project is not published.' });
      }
    }

    return res.json(doc);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.updateDocument = async (req, res) => {
  try {
    const { id } = req.params;
    const { displayName, region, edrmsRecordNumber, orcsClassification, isPublished } = req.body;
    const updateData = {};
    if (displayName !== undefined) updateData.displayName = displayName;
    if (region !== undefined) updateData.region = region;
    if (edrmsRecordNumber !== undefined) updateData.edrmsRecordNumber = edrmsRecordNumber;
    if (orcsClassification !== undefined) updateData.orcsClassification = orcsClassification;
    if (isPublished !== undefined) updateData.isPublished = isPublished;

    const updated = await Document.findByIdAndUpdate(id, updateData, { new: true, runValidators: true }).populate('project');
    if (!updated) {
      return res.status(404).json({ error: 'Document not found' });
    }
    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.deleteDocument = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await Document.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({ error: 'Document not found' });
    }
    return res.json({ message: 'Document deleted successfully', deleted });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

async function triggerEagleSync(doc) {
  const eagleApiUrl = process.env.EAGLE_API_URL || 'http://localhost:3000';
  const apiKey = process.env.DOCLING_API_KEY;

  try {
    const res = await fetch(`${eagleApiUrl}/api/document/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey
      },
      body: JSON.stringify(doc)
    });
    if (!res.ok) {
      console.error(`[demi-api] Webhook sync returned HTTP ${res.status}`);
    } else {
      console.log(`[demi-api] Document cache synchronized to eagle-api for ${doc._id}`);
    }
  } catch (err) {
    console.error(`[demi-api] Failed to trigger webhook sync to eagle-api:`, err.message);
  }
}

exports.extractDocument = async (req, res) => {
  try {
    const file = req.file;
    const { project, displayName, region, edrmsRecordNumber, orcsClassification, isPublished } = req.body;

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }
    if (!project || !mongoose.Types.ObjectId.isValid(project)) {
      if (file.path) fs.promises.unlink(file.path).catch(() => {});
      return res.status(400).json({ error: 'A valid project id is required.' });
    }

    // Verify parent project exists
    const parentProject = await Project.findById(project);
    if (!parentProject) {
      if (file.path) fs.promises.unlink(file.path).catch(() => {});
      return res.status(404).json({ error: `Parent Project with id ${project} not found.` });
    }

    // Upload to MinIO
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

    const newDoc = new Document({
      project,
      displayName: displayName || file.originalname,
      s3Key: objectPath,
      region: region || parentProject.region,
      edrmsRecordNumber,
      orcsClassification,
      isPublished: isPublished === 'true' || isPublished === true
    });

    const saved = await newDoc.save();

    // Trigger background extraction asynchronously
    setImmediate(async () => {
      try {
        const db = mongoose.connection.db;
        const minio = extract.getMinioClient();

        console.log(`[demi-api] Starting async extraction for document: ${saved._id}`);
        const buffer = await extract.downloadFromMinio(minio, objectPath);
        const filename = saved.displayName || file.originalname;
        const markdown = await extract.splitAndExtract(buffer, filename);

        const { chunkMarkdown } = require('../chunker');
        const chunks = chunkMarkdown(markdown);

        // Fetch lookups
        const projectLookup = await extract.buildProjectLookup(db);
        const listLookup = await extract.buildListLookup(db);
        const projectName = projectLookup.get(project.toString());

        const count = await extract.replaceChunks(db, saved._id.toString(), saved, chunks, projectName, listLookup);
        await extract.markDocument(db, saved._id.toString(), count, null);

        console.log(`[demi-api] Extracted ${count} chunks for document: ${saved._id}`);

        // Trigger cache sync
        await triggerEagleSync(saved);
      } catch (err) {
        console.error(`[demi-api] Background extraction failed for document ${saved._id}:`, err.message);
        const db = mongoose.connection.db;
        await extract.markDocument(db, saved._id.toString(), 0, err.message);
      }
    });

    return res.status(202).json({
      message: 'File stored and extraction queued.',
      docId: String(saved._id)
    });
  } catch (err) {
    if (req.file && req.file.path) fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(500).json({ error: err.message });
  }
};
