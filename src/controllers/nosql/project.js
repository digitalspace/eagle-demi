'use strict';

/**
 * Project controller — Cosmos NoSQL.
 *
 * The only project controller. The Mongo-backed pair in the parent directory went with the
 * data layer in Phase 8; the `nosql/` nesting is now just a path, not a choice.
 *
 * Controllers are thin here: the repository owns the SQL and the visibility predicate, so
 * these functions only translate HTTP to a repository call and back.
 */

const projects = require('../../repositories/projects');
const fragments = require('../../repositories/fragments');
const { resolveAccess, SECURE_ROLES } = require('../../helpers/access-sql');
const aiSearch = require('../../search/ai-search');

exports.getProjects = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const { regionalDistrict, municipality, electoralDistrict, includeNrpti, includeSeeded } = req.query;

    // Provenance filter, orthogonal to visibility. Default is Track-sourced projects only.
    const allowNonTrack = includeNrpti === 'true' || includeSeeded === 'true';

    const { items, continuationToken } = await projects.listVisible(access, {
      trackOnly: !allowNonTrack,
      regionalDistrict,
      municipality,
      electoralDistrict,
      pageSize: Math.min(parseInt(req.query.pageSize || '1000', 10), 5000),
      continuationToken: req.query.continuationToken
    });

    // Continuation token is returned in a header so the body stays a plain array — the
    // frontend consumes it as one today and paging is opt-in.
    if (continuationToken) res.setHeader('x-continuation-token', continuationToken);
    return res.json(items);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.getProject = async (req, res) => {
  try {
    const access = resolveAccess(req);
    // getById gates the point read internally — a point read bypasses the query predicate,
    // so without that gate a by-id fetch would return what a list hides.
    const project = await projects.getById(access, req.params.id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    return res.json(project);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

/**
 * Fragments the caller may see for a project (e.g. the NRPTI aggregate).
 * A caller without the fragment's roles simply gets fewer items — never a stripped object.
 */
exports.getProjectFragments = async (req, res) => {
  try {
    const access = resolveAccess(req);

    const project = await projects.getById(access, req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const { items } = await fragments.listForProject(access, req.params.id);
    return res.json(items);
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

    // Fail closed: private unless explicitly published.
    const published = isPublished === true || isPublished === 'true';
    const read = published ? ['public', ...SECURE_ROLES] : [...SECURE_ROLES];
    const now = new Date().toISOString();

    const saved = await projects.upsert({
      id: String(trackProjectId),
      trackProjectId: Number(trackProjectId),
      eagleId: null,
      sourceSystem: 'track',
      name,
      description: description || '',
      sector: sector || '',
      region: region || '',
      status: status || '',
      centroid,
      read,
      isPublished: published,
      sources: { track: {}, eagle: null },
      createdAt: now,
      updatedAt: now
    });

    return res.status(201).json(saved);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.updateProject = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const existing = await projects.getById(access, req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // The partition key is the id, so it must not be reassigned by a request body — in Cosmos
    // that is a delete-and-reinsert, not an update.
    const { id: _ignoredId, trackProjectId: _ignoredTrackId, ...changes } = req.body;

    const saved = await projects.upsert({
      ...existing,
      ...changes,
      id: existing.id,
      trackProjectId: existing.trackProjectId,
      updatedAt: new Date().toISOString()
    });

    return res.json(saved);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.deleteProject = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const existing = await projects.getById(access, req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Project not found' });
    }

    await projects.deleteById(existing.id);

    // The indexer's high-water mark never sees a delete, so without this the project stays
    // searchable by name after it is gone. Best-effort: the row is already deleted and the
    // caller has already succeeded, so a failure here is reported, not thrown.
    const removedFromSearch =
      await aiSearch.deleteFromIndex(aiSearch.indexes().projects, existing.id);

    return res.json({ message: 'Project deleted successfully', deleted: existing, removedFromSearch });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
