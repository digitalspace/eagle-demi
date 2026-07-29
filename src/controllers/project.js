'use strict';

const Project = require('../models/project');
const { rolesFor, withReadFilter, canRead, SECURE_ROLES } = require('../helpers/access');

exports.getProjects = async (req, res) => {
  try {
    const { regionalDistrict, municipality, electoralDistrict, includeNrpti, includeSeeded } = req.query;
    const roles = rolesFor(req);
    const allowNonTrack = includeNrpti === 'true' || includeSeeded === 'true';

    const criteria = {};
    if (!allowNonTrack) {
      criteria['sources.track'] = { $exists: true, $ne: null };
    }
    if (regionalDistrict) criteria.regionalDistrict = regionalDistrict;
    if (municipality) criteria.municipality = municipality;
    if (electoralDistrict) criteria.electoralDistrict = electoralDistrict;

    // Cap the result set — this endpoint previously had no limit at all.
    const projects = await Project.find(withReadFilter(roles, criteria), {
      maxItemCount: Math.min(parseInt(req.query.pageSize || '1000', 10), 5000),
      sort: { name: 1 }
    });
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

    // Fail closed: a new project is private unless explicitly published.
    const published = isPublished === true || isPublished === 'true';
    const read = published ? ['public', ...SECURE_ROLES] : [...SECURE_ROLES];

    const newProject = {
      read,
      _id: String(trackProjectId),
      trackProjectId: Number(trackProjectId),
      name,
      description: description || '',
      sector: sector || '',
      region: region || '',
      status: status || '',
      centroid,
      isPublished: published,
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
    const roles = rolesFor(req);
    const numId = isNaN(id) ? -1 : Number(id);

    let project = await Project.findById(id);
    if (!project) {
      project = await Project.findOne({
        $or: [
          { _id: String(id) },
          { id: String(id) },
          { trackProjectId: numId },
          { legacyEagleId: String(id) }
        ]
      });
    }
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    // findById is a point read that bypasses the query filter, so gate the result here.
    // getDocument has always done this; project did not.
    if (!canRead(project, roles)) {
      return res.status(403).json({ error: 'Access denied. Project is not published.' });
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
    if (!existing) {
      const numId = isNaN(id) ? -1 : Number(id);
      existing = await Project.findOne({
        $or: [
          { _id: String(id) },
          { id: String(id) },
          { trackProjectId: numId },
          { legacyEagleId: String(id) }
        ]
      });
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
    if (!existing) {
      const numId = isNaN(id) ? -1 : Number(id);
      existing = await Project.findOne({
        $or: [
          { _id: String(id) },
          { id: String(id) },
          { trackProjectId: numId },
          { legacyEagleId: String(id) }
        ]
      });
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
