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
const documents = require('../../repositories/documents');
const { resolveAccess, systemAccess, SECURE_ROLES } = require('../../helpers/access-sql');
const { serverError } = require('../../helpers/response');
const aiSearch = require('../../search/ai-search');
const { logger } = require('../../utils/logger');
const { auditEvent } = require('../../utils/audit');

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
    return res.json(items.map(projects.publicView));
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
    return res.json(projects.publicView(project));
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
      // Empty, but present: the wildfire sync patches `/sources/wildfire`, and a Cosmos patch
      // cannot create a path recursively — without `/sources` on the document it fails the whole
      // sync run, not just this project (sync-wildfires.js loops unguarded).
      sources: {},
      createdAt: now,
      updatedAt: now
    });

    auditEvent(req, {
      action: 'project.create',
      targetType: 'project',
      targetId: saved.id,
      projectId: saved.id,
      detail: { name: saved.name, isPublished: saved.isPublished }
    });

    return res.status(201).json(projects.publicView(saved));
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

    // Field NAMES, not values: an audit row records who changed what and when, and a full
    // before/after of arbitrary request bodies would put project content into a table kept for
    // seven years. `isPublished` is the exception — a visibility flip is the change most likely
    // to be asked about later, so both sides of it are recorded.
    //
    // Before the cascade below, not after: the project write has already happened by here, and the
    // cascade can return 500. A visibility flip that left documents over-permissive is the row
    // someone will come looking for, so it must not be the one path that records nothing.
    auditEvent(req, {
      action: 'project.update',
      targetType: 'project',
      targetId: existing.id,
      projectId: existing.id,
      detail: {
        fields: Object.keys(changes),
        isPublishedFrom: existing.isPublished,
        isPublishedTo: saved.isPublished
      }
    });

    // A document must never out-rank its project. The 409 on PUT /documents/:id/published enforces
    // that upwards; this is the same invariant downwards, which nothing enforced — unpublishing a
    // project left every document under it carrying `public`, and `listVisible` gates on the
    // document's own ACL, so they stayed listable and searchable under a project nobody could see.
    //
    // Only on the TRANSITION to private, and only downwards: publishing a project must not publish
    // its documents, whose own state is independent and legitimately narrower.
    //
    // systemAccess() deliberately — a document already private must be patched too, and the caller
    // cannot read it. AFTER the project write, matching setDocumentPublished: a failure here leaves
    // the project private and its documents over-permissive, which is the direction the reader
    // gates cover.
    //
    // ponytail: documents only, not their chunks. A chunk is gated on its PARENT DOCUMENT's
    // visibility in the chunk-search join, so a stale chunk ACL cannot leak text on its own, and
    // fanning out one bulk call per document turns this into an unbounded request handler. If
    // chunk ACLs ever have to stand alone, move the whole cascade to a job and patch chunks there.
    if (acl.isPublished === false && existing.isPublished !== false) {
      try {
        const cascade = await documents.setAclForProject(systemAccess(), existing.id, acl.read);
        if (cascade.failed > 0) {
          logger.error('[Project Controller] document ACL cascade partially failed', {
            projectId: existing.id, ...cascade, ids: undefined
          });
          return res.status(500).json({
            success: false,
            error: 'Project was unpublished, but its documents were not fully restricted.'
          });
        }
      } catch (cascadeErr) {
        logger.error('[Project Controller] document ACL cascade failed', {
          projectId: existing.id, error: cascadeErr.message
        });
        return res.status(500).json({
          success: false,
          error: 'Project was unpublished, but its documents were not restricted.'
        });
      }
    }

    // `existing` and `saved` went to upsert whole. Only the copy that leaves over HTTP is
    // narrowed.
    return res.json(projects.publicView(saved));
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

    auditEvent(req, {
      action: 'project.delete',
      targetType: 'project',
      targetId: existing.id,
      projectId: existing.id,
      detail: { name: existing.name, removedFromSearch }
    });

    return res.json({
      message: 'Project deleted successfully',
      deleted: projects.publicView(existing),
      removedFromSearch
    });
  } catch (err) {
    return serverError(res, err, 'project controller failed');
  }
};
