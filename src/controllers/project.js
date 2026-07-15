'use strict';

const Project = require('../models/project');
const Region = require('../models/region');
const Boundary = require('../models/boundary');

async function autoTagProjectBoundaries(project) {
  if (!project.centroid || !project.centroid.coordinates) return;
  try {
    const intersectingBoundaries = await Boundary.find({
      geometry: {
        $geoIntersects: {
          $geometry: {
            type: 'Point',
            coordinates: project.centroid.coordinates
          }
        }
      }
    });
    project.regionalDistrict = intersectingBoundaries.find(b => b.type === 'Regional District')?.name || '';
    project.municipality = intersectingBoundaries.find(b => b.type === 'Municipality')?.name || '';
    project.electoralDistrict = intersectingBoundaries.find(b => b.type === 'Electoral District')?.name || '';
  } catch (err) {
    console.error('Error in autoTagProjectBoundaries:', err);
  }
}

// Helper to determine if the request is administrative / internal
function isAdmin(req) {
  if (req.user) {
    const roles = req.user.realm_access?.roles || [];
    return roles.includes('sysadmin') || roles.includes('staff') || roles.includes('demi-admin');
  }
  const apiKey = req.header('X-Api-Key');
  const expectedKey = process.env.DOCLING_API_KEY;
  if (expectedKey && apiKey && apiKey === expectedKey) return true;
  if (process.env.NODE_ENV !== 'production' && apiKey === 'eagle-demi-api-key') return true;
  return false;
}

exports.getProjects = async (req, res) => {
  try {
    const { region: regionName, regionalDistrict, municipality, electoralDistrict } = req.query;
    const isAuth = isAdmin(req);
    const baseQuery = isAuth ? {} : { isPublished: true };

    if (regionalDistrict) {
      baseQuery.regionalDistrict = regionalDistrict;
    }
    if (municipality) {
      baseQuery.municipality = municipality;
    }
    if (electoralDistrict) {
      baseQuery.electoralDistrict = electoralDistrict;
    }

    if (regionName) {
      const regionDoc = await Region.findOne({ name: regionName });
      if (!regionDoc) {
        return res.status(404).json({ error: 'Region not found' });
      }
      baseQuery.centroid = {
        $geoWithin: { $geometry: regionDoc.geometry }
      };
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
    await autoTagProjectBoundaries(newProject);

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

    if (req.body.centroid && req.body.centroid.coordinates) {
      const intersectingBoundaries = await Boundary.find({
        geometry: {
          $geoIntersects: {
            $geometry: {
              type: 'Point',
              coordinates: req.body.centroid.coordinates
            }
          }
        }
      });
      req.body.regionalDistrict = intersectingBoundaries.find(b => b.type === 'Regional District')?.name || '';
      req.body.municipality = intersectingBoundaries.find(b => b.type === 'Municipality')?.name || '';
      req.body.electoralDistrict = intersectingBoundaries.find(b => b.type === 'Electoral District')?.name || '';
    }

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
