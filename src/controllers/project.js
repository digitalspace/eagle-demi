'use strict';

const Project = require('../models/project');
const Region = require('../models/region');

// Helper to determine if the request is administrative / internal
function isAdmin(req) {
  const apiKey = req.header('X-Api-Key');
  const expectedKey = process.env.DOCLING_API_KEY || 'eagle-demi-api-key';
  return apiKey && apiKey === expectedKey;
}

exports.getProjects = async (req, res) => {
  try {
    const { region: regionName } = req.query;
    const isAuth = isAdmin(req);
    const baseQuery = isAuth ? {} : { isPublished: true };

    if (regionName) {
      const regionDoc = await Region.findOne({ name: regionName });
      if (!regionDoc) {
        return res.status(404).json({ error: 'Region not found' });
      }

      const projects = await Project.find({
        ...baseQuery,
        centroid: {
          $geoWithin: { $geometry: regionDoc.geometry }
        }
      });
      return res.json(projects);
    }

    const projects = await Project.find(baseQuery);
    return res.json(projects);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.createProject = async (req, res) => {
  try {
    const { trackProjectId, name, centroid } = req.body;

    if (!trackProjectId || !name || !centroid || !centroid.coordinates) {
      return res.status(400).json({ error: 'Missing required fields: trackProjectId, name, centroid' });
    }

    const newProject = new Project(req.body);

    const saved = await newProject.save();
    return res.status(201).json(saved);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Project with trackProjectId already exists' });
    }
    return res.status(500).json({ error: err.message });
  }
};

exports.getProject = async (req, res) => {
  try {
    const { id } = req.params;
    const isAuth = isAdmin(req);
    const baseQuery = isAuth ? {} : { isPublished: true };
    const query = { ...baseQuery, ...(isNaN(id) ? { _id: id } : { trackProjectId: Number(id) }) };

    const project = await Project.findOne(query);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    return res.json(project);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.updateProject = async (req, res) => {
  try {
    const { id } = req.params;
    const query = isNaN(id) ? { _id: id } : { trackProjectId: Number(id) };

    const updated = await Project.findOneAndUpdate(query, req.body, { new: true, runValidators: true });
    if (!updated) {
      return res.status(404).json({ error: 'Project not found' });
    }
    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.deleteProject = async (req, res) => {
  try {
    const { id } = req.params;
    const query = isNaN(id) ? { _id: id } : { trackProjectId: Number(id) };

    const deleted = await Project.findOneAndDelete(query);
    if (!deleted) {
      return res.status(404).json({ error: 'Project not found' });
    }
    return res.json({ message: 'Project deleted successfully', deleted });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
