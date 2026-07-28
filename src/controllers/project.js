'use strict';

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

exports.getProjects = async (req, res) => {
  try {
    const { regionalDistrict, municipality, electoralDistrict } = req.query;
    const isAuth = isAdmin(req);
    const conditions = [];
    const parameters = [];

    if (!isAuth) {
      conditions.push('c.isPublished = true');
    }
    if (regionalDistrict) {
      parameters.push({ name: '@rd', value: regionalDistrict });
      conditions.push('c.regionalDistrict = @rd');
    }
    if (municipality) {
      parameters.push({ name: '@muni', value: municipality });
      conditions.push('c.municipality = @muni');
    }
    if (electoralDistrict) {
      parameters.push({ name: '@ed', value: electoralDistrict });
      conditions.push('c.electoralDistrict = @ed');
    }

    const whereClause = conditions.length > 0 ? conditions.join(' AND ') : '';
    const projects = await Project.find(whereClause, parameters, { orderBy: 'c.name ASC' });
    return res.json(projects);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.createProject = async (req, res) => {
  try {
    const { trackProjectId, name, description, sector, region, status, centroid, isPublished } = req.body;

    if (!trackProjectId || !name || !centroid || !centroid.coordinates) {
      return res.status(400).json({ error: 'Missing required fields: trackProjectId, name, centroid' });
    }

    const newProject = {
      _id: String(trackProjectId),
      trackProjectId: Number(trackProjectId),
      name,
      description: description || '',
      sector: sector || '',
      region: region || '',
      status: status || '',
      centroid,
      isPublished: isPublished !== undefined ? Boolean(isPublished) : false,
      sources: {
        track: {},
        eagle: null,
        nrpti: { recordCount: 0, orderCount: 0, inspectionCount: 0, ticketCount: 0, lastRecordDate: null },
        wildfire: { activeCountWithin50km: 0, nearestDistanceKm: null, firesOfNoteNearby: 0, lastCalculatedAt: null }
      }
    };

    const saved = await Project.upsert(newProject);
    return res.status(201).json(saved);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.getProject = async (req, res) => {
  try {
    const { id } = req.params;
    let project = await Project.findById(id);
    if (!project && !isNaN(id)) {
      project = await Project.findOne('c.trackProjectId = @tpid', [{ name: '@tpid', value: Number(id) }]);
    }
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
    let existing = await Project.findById(id);
    if (!existing && !isNaN(id)) {
      existing = await Project.findOne('c.trackProjectId = @tpid', [{ name: '@tpid', value: Number(id) }]);
    }
    if (!existing) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const updated = { ...existing, ...req.body };
    const saved = await Project.upsert(updated);
    return res.json(saved);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.deleteProject = async (req, res) => {
  try {
    const { id } = req.params;
    let existing = await Project.findById(id);
    if (!existing && !isNaN(id)) {
      existing = await Project.findOne('c.trackProjectId = @tpid', [{ name: '@tpid', value: Number(id) }]);
    }
    if (!existing) {
      return res.status(404).json({ error: 'Project not found' });
    }

    await Project.deleteById(existing._id);
    return res.json({ message: 'Project deleted successfully', deleted: existing });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
