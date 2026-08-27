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
const { resolveAccess, systemAccess, pageSizeFor, SECURE_ROLES } = require('../../helpers/access-sql');
const { serverError } = require('../../helpers/response');
const aiSearch = require('../../search/ai-search');
const { purgeProject } = require('../../helpers/purge');
const { logger } = require('../../utils/logger');
const { auditEvent } = require('../../utils/audit');
const { mergeTrackProject, mergeEagleOnlyProject } = require('../../merge/project');
const { redactForAccess, visible, effectiveVis } = require('../../vis/redact');
const { catalogFor } = require('../../vis/catalog');

/**
 * A project's visibility change, carried to its index row and re-derived onto its documents.
 * Either transition, `ownRead ∩ projectRead`, systemAccess — wiki `Sync-Architecture`.
 *
 * ponytail: documents only, not chunks — a chunk gates on its parent document at query time.
 *
 * @returns {Promise<string|null>} an error message the caller must 500 with, or null on success.
 */
async function cascadeProjectVisibility(projectId, acl) {
  // The project's own index row FIRST, and outside the try: no project list or search is a live
  // read any more (#148), so an unpublished project stayed findable BY NAME until the indexer's
  // next PT5M pass. It goes before the cascade because the project's Cosmos write has already
  // landed — it must narrow even if the cascade below fails.
  await aiSearch.writeAcls(aiSearch.indexes().projects, [
    { id: projectId, read: acl.read, isPublished: acl.isPublished }
  ]);

  try {
    const cascade = await documents.setAclForProject(systemAccess(), projectId, acl.read);
    if (cascade.failed > 0) {
      // The rows that DID land still go to the index, or the succeeded subset stays listable under
      // its old ACL until the indexer's next PT5M pass. With no per-row verdicts, nothing is
      // written rather than claiming an ACL Cosmos may not hold.
      const failedIds = new Set(cascade.failedIds || (cascade.rows || []).map(r => r.id));
      const landed = (cascade.rows || []).filter(row => !failedIds.has(row.id));
      if (landed.length) await aiSearch.writeAcls(aiSearch.indexes().documents, landed);
      logger.error('[Project Controller] document ACL cascade partially failed', {
        projectId, ...cascade, ids: undefined, rows: undefined
      });
      return 'Project visibility changed, but its documents were not fully updated.';
    }

    // The same derived ACLs the cascade just wrote to Cosmos, into the documents index. One
    // request per 1,000 documents, and it cannot throw.
    await aiSearch.writeAcls(aiSearch.indexes().documents, cascade.rows);
    return null;
  } catch (cascadeErr) {
    logger.error('[Project Controller] document ACL cascade failed', {
      projectId, error: cascadeErr.message
    });
    return 'Project visibility changed, but its documents were not updated.';
  }
}

exports.getProjects = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const { regionalDistrict, municipality, electoralDistrict } = req.query;

    // Anonymous callers cap at ANON_MAX_PAGE_SIZE; authenticated ones keep the full ceiling.
    const { pageSize, error } = pageSizeFor(access, req.query.pageSize);
    if (error) return res.status(400).json({ error });

    const { items, continuationToken } = await projects.listVisible(access, {
      regionalDistrict,
      municipality,
      electoralDistrict,
      pageSize,
      continuationToken: req.query.continuationToken
    });

    // Continuation token is returned in a header so the body stays a plain array — the
    // frontend consumes it as one today and paging is opt-in.
    if (continuationToken) res.setHeader('x-continuation-token', continuationToken);
    return res.json(items.map(p => redactForAccess('projects', p, access)));
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
    return res.json(redactForAccess('projects', project, access));
  } catch (err) {
    return serverError(res, err, 'project controller failed');
  }
};

exports.createProject = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const {
      trackProjectId, name, description, sector, region, status, projectState,
      centroid, isPublished
    } = req.body;

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
      // `status` ON THE WIRE, `projectState` AT REST — one stored name, chosen by the writer that
      // owns the 389 synced rows (`merge/project.js:38` via TRACK_PRECEDENCE). This used to store
      // the wire name verbatim, so an API-created project was the only row in the container whose
      // state lived under a different key, and the projects data source aliases
      // `c.projectState AS status`: the alias resolved to nothing and the row indexed as though it
      // had no state at all. Measured 2026-08-24 before this change: 0 rows carried `status`, 389
      // carried `projectState` — nothing to migrate, because nothing had been created through this
      // route since the drift appeared.
      //
      // BOTH INPUT NAMES, and the same precedence PUT uses. Accepting only the wire name made a
      // GET-then-POST round trip lose the state silently: a GET returns the stored name, so
      // the body a caller sends back carries `projectState`, which this route dropped on the floor
      // while its sibling honoured it.
      projectState: projectState || status || '',
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

    return res.status(201).json(redactForAccess('projects', saved, access));
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
      status: wireStatus,
      ...changes
    } = req.body;

    // Same rename as createProject, and it has to be here too: this route spreads the body in
    // verbatim, so a caller sending `status` wrote a second field beside `projectState` and the
    // two then disagreed on the same row. `projectState` in the body wins if both are sent —
    // the stored name is the specific one, so honour it over the alias.
    if (wireStatus !== undefined && changes.projectState === undefined) {
      changes.projectState = wireStatus;
    }

    // A field the caller cannot SEE is a field they cannot set. The response is redacted, so a
    // level 4 caller never received `complianceLead` — accepting it back would overwrite a value
    // they were never shown, which is the hole the redaction-safe update rule closes
    // (docs/rbac-architecture.md §2 item 1). `vis` is refused at EVERY level: the dial map is
    // policy rather than content, and no route sets it yet.
    const catalog = catalogFor('projects');
    const dials = existing.vis && typeof existing.vis === 'object' ? existing.vis : {};
    const refused = Object.keys(changes).filter(key => key === 'vis' || !catalog[key] ||
      !visible(access.level, effectiveVis(catalog[key], dials[key])));
    if (refused.length) {
      return res.status(400).json({
        error: `Fields not writable by this caller: ${refused.join(', ')}`
      });
    }

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

    // `!==` over the two states, so `isPublished: undefined` — a rename, a description edit — is
    // equal to itself and cascades nothing.
    if (acl.isPublished !== existing.isPublished) {
      const failure = await cascadeProjectVisibility(existing.id, acl);
      if (failure) return res.status(500).json({ success: false, error: failure });
    }

    // `existing` and `saved` went to upsert whole. Only the copy that leaves over HTTP is
    // narrowed.
    return res.json(redactForAccess('projects', saved, access));
  } catch (err) {
    return serverError(res, err, 'project controller failed');
  }
};

/**
 * Receive one project pushed by eagle-api, keyed by its Eagle `_id`.
 *
 * The body carries the RAW Eagle record, so the merge rules stay in `merge/project.js` and this
 * route produces exactly what the seed produces — a push and a re-seed cannot disagree about the
 * same project. Identity comes from the merge too: the Track id when the project is already
 * matched, `eagle-<eagleId>` when it is not.
 */
exports.upsertFromEagle = async (req, res) => {
  try {
    const eagleId = String(req.params.eagleId);
    const doc = req.body && req.body.doc;
    if (!doc || String(doc._id || '') !== eagleId) {
      return res.status(400).json({ error: 'body.doc._id must match the :eagleId in the path' });
    }

    // systemAccess: the push is a mirror, so it must find a project it is about to republish even
    // while that project is currently private.
    const existing = await projects.getByEagleId(systemAccess(), eagleId);

    const merged = existing && existing.sources && existing.sources.track
      ? mergeTrackProject(existing.sources.track, doc)
      : mergeEagleOnlyProject(doc);

    // Every OTHER source block survives the push. A Cosmos upsert replaces the item, and the merge
    // rebuilds only `track`/`eagle` — so without this every push wipes `sources.wildfire`, which
    // nothing upstream can rebuild. The same trap the seed hit.
    merged.sources = { ...(existing && existing.sources), ...merged.sources };

    const saved = await projects.upsert(merged);

    auditEvent(req, {
      action: 'project.push',
      targetType: 'project',
      targetId: saved.id,
      projectId: saved.id,
      detail: {
        eagleId,
        isPublishedFrom: existing ? existing.isPublished : null,
        isPublishedTo: saved.isPublished
      }
    });

    // Only against an existing row: a project DEMI has never seen has no documents to cascade onto
    // and no index row to correct.
    if (existing && saved.isPublished !== existing.isPublished) {
      const failure = await cascadeProjectVisibility(saved.id, {
        read: saved.read, isPublished: saved.isPublished
      });
      if (failure) return res.status(500).json({ success: false, error: failure });
    }

    return res.json({ id: saved.id, action: 'upsert' });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
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

    const { removedFromSearch } = await purgeProject(existing);

    auditEvent(req, {
      action: 'project.delete',
      targetType: 'project',
      targetId: existing.id,
      projectId: existing.id,
      detail: { name: existing.name, removedFromSearch }
    });

    return res.json({
      message: 'Project deleted successfully',
      deleted: redactForAccess('projects', existing, access),
      removedFromSearch
    });
  } catch (err) {
    return serverError(res, err, 'project controller failed');
  }
};
