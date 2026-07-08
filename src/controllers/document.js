'use strict';

const Document = require('../models/document');
const Project = require('../models/project');
const Region = require('../models/region');

// Helper to determine if the request is administrative / internal
function isAdmin(req) {
  const apiKey = req.header('X-Api-Key');
  const expectedKey = process.env.DOCLING_API_KEY || 'eagle-demi-api-key';
  return apiKey && apiKey === expectedKey;
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
    const updated = await Document.findByIdAndUpdate(id, req.body, { new: true, runValidators: true }).populate('project');
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
