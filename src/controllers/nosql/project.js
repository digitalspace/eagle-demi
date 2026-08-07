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
const { resolveAccess, SECURE_ROLES } = require('../../helpers/access-sql');
const { serverError } = require('../../helpers/response');
const aiSearch = require('../../search/ai-search');

exports.getProjects = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const { regionalDistrict, municipality, electoralDistrict, includeSeeded } = req.query;

    // Provenance filter, orthogonal to visibility. Default is Track-sourced projects only.
    const allowNonTrack = includeSeeded === 'true';

    const { items, continuationToken } = await projects.listVisible(access, {
      trackOnly: !allowNonTrack,
      regionalDistrict,
      municipality,
      electoralDistrict,
      // 1000 is the real ceiling — pageOptions clamps to it, so a larger number here
      // only looked like it did something.
      pageSize: Math.min(parseInt(req.query.pageSize || '1000', 10), 1000),
      continuationToken: req.query.continuationToken
    });

    // Continuation token is returned in a header so the body stays a plain array — the
    // frontend consumes it as one today and paging is opt-in.
    if (continuationToken) res.setHeader('x-continuation-token', continuationToken);
    return res.json(items);
  } catch (err) {
    return serverError(res, err, 'project controller failed');
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
    return serverError(res, err, 'project controller failed');
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
    return serverError(res, err, 'project controller failed');
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
    //
    // `read` is derived from `isPublished` rather than taken verbatim, so the two cannot disagree:
    // read[] is authoritative and isPublished mirrors it. Spreading the body straight in let a
    // writer hand-craft an ACL that no gate had ever seen.
    const {
      id: _ignoredId, trackProjectId: _ignoredTrackId,
      read: _ignoredRead, isPublished,
      ...changes
    } = req.body;

    const acl = isPublished === undefined
      ? { read: existing.read, isPublished: existing.isPublished }
      : {
        isPublished: isPublished === true,
        read: isPublished === true ? ['public', ...SECURE_ROLES] : [...SECURE_ROLES]
      };

    const saved = await projects.upsert({
      ...existing,
      ...changes,
      ...acl,
      id: existing.id,
      trackProjectId: existing.trackProjectId,
      updatedAt: new Date().toISOString()
    });

    return res.json(saved);
  } catch (err) {
    return serverError(res, err, 'project controller failed');
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
    return serverError(res, err, 'project controller failed');
  }
};
