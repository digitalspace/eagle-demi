'use strict';

const Document = require('../models/document');
const Project = require('../models/project');
const Region = require('../models/region');

exports.getDocuments = async (req, res) => {
  try {
    const { region: regionName } = req.query;

    if (regionName) {
      const regionDoc = await Region.findOne({ name: regionName });
      if (!regionDoc) {
        return res.status(404).json({ error: 'Region not found' });
      }

      // Find projects whose centroid point falls inside the region's boundary
      const projects = await Project.find({
        centroid: { $geoWithin: { $geometry: regionDoc.geometry } }
      }).select('_id');

      const projectIds = projects.map(p => p._id);
      const documents = await Document.find({ project: { $in: projectIds } }).populate('project');
      return res.json(documents);
    }

    const documents = await Document.find({}).populate('project');
    return res.json(documents);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.createDocument = async (req, res) => {
  try {
    const { project, displayName, s3Key, region, edrmsRecordNumber, orcsClassification } = req.body;

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
      orcsClassification
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
    const doc = await Document.findById(id).populate('project');
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
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
