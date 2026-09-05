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
const {
  resolveAccess, systemAccess, pageSizeFor, readForLevel, levelOfRead
} = require('../../helpers/access-sql');
const { catalogFor } = require('../../vis/catalog');
const { PATCH_MAX_OPERATIONS } = require('../../db/cosmos-nosql');
const { serverError } = require('../../helpers/response');
const aiSearch = require('../../search/ai-search');
const { purgeProject } = require('../../helpers/purge');
const { logger } = require('../../utils/logger');
const { auditEvent } = require('../../utils/audit');
const { mergeTrackProject, mergeEagleOnlyProject } = require('../../merge/project');
const { redactForAccess, refusedWriteKeys } = require('../../vis/redact');
const { shortUrlFor } = require('../../helpers/short-links');

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
    // Both id spaces on one route: eagle-public holds Eagle ObjectIds and DEMI ids are Track
    // integers or `eagle-<ObjectId>`, so a 24-hex `:id` can only be Eagle's.
    //
    // getById gates the point read internally — a point read bypasses the query predicate,
    // so without that gate a by-id fetch would return what a list hides. getByEagleId is a
    // query and carries the same predicate.
    const project = projects.EAGLE_OBJECT_ID.test(req.params.id)
      ? await projects.getByEagleId(access, req.params.id)
      : await projects.getById(access, req.params.id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const body = redactForAccess('projects', project, access);
    // Only the code is stored; the masthead's copy button needs the URL, and the base host is
    // per-environment config, not a stored value that could go stale.
    if (body.shortCode) body.shortUrl = shortUrlFor(body.shortCode);
    return res.json(body);
  } catch (err) {
    return serverError(res, err, 'project controller failed');
  }
};

exports.createProject = async (req, res) => {
  try {
    const access = resolveAccess(req);
    // No `isPublished`: a create body cannot publish. Widening is `PUT /api/projects/:id/level`.
    const {
      trackProjectId, name, description, sector, region, status, projectState, centroid
    } = req.body;

    if (!trackProjectId || !name || !centroid || !centroid.coordinates) {
      return res.status(400).json({ error: 'Missing required fields: trackProjectId, name, centroid' });
    }

    // Admission is level 1 (docs/rbac-architecture.md §1, "Default on admission is level 1"):
    // nothing reaches level 2 or above by being created.
    const read = readForLevel(1);
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
      isPublished: false,
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
    // `read` and its `isPublished` mirror are carried from `existing`, never taken from the body:
    // PUT does not move a level. Widening is an act — `PUT /api/projects/:id/level`.
    //
    // The Cosmos bookkeeping keys are dropped for a different reason: a caller who GETs a project
    // and PUTs the response back sends them, and they are catalogued at maxVis 0 (or 2 for
    // `_etag`), so the guard below would 400 an otherwise ordinary edit. `...existing` supplies
    // the real values.
    const {
      id: _ignoredId, trackProjectId: _ignoredTrackId,
      read: _ignoredRead, isPublished: _ignoredPublished,
      status: wireStatus,
      // The cacPublished predicate reads this, so PUT must not set it (doc §2 item 7).
      projectCACPublished: _ignoredCACPublished,
      _rid: _ignoredRid, _self: _ignoredSelf, _attachments: _ignoredAttachments,
      _ts: _ignoredTs, _etag: _ignoredEtag, sources: _ignoredSources,
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
    const refused = refusedWriteKeys('projects', changes, access, existing);
    if (refused.length) {
      return res.status(400).json({
        error: `Fields not writable by this caller: ${refused.join(', ')}`
      });
    }

    const saved = await projects.upsert({
      ...existing,
      ...changes,
      id: existing.id,
      trackProjectId: existing.trackProjectId,
      updatedAt: new Date().toISOString()
    });

    // Field NAMES, not values: an audit row records who changed what and when, and a full
    // before/after of arbitrary request bodies would put project content into a table kept for
    // seven years. The visibility pair is recorded too, unchanged though PUT now leaves it — a
    // reader of this table should not have to know which route could move it.
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

    // `existing` and `saved` went to upsert whole. Only the copy that leaves over HTTP is
    // narrowed.
    return res.json(redactForAccess('projects', saved, access));
  } catch (err) {
    return serverError(res, err, 'project controller failed');
  }
};

/**
 * Move a project to a ladder level (docs/rbac-architecture.md §1, "Widening is an act").
 *
 * The ONLY route that raises a record's level: no job, no push and no merge widens anything, so
 * every widening has an actor, a time and an audit row behind it.
 */
exports.setLevel = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const { level, confirm, reason } = req.body || {};

    if (!Number.isInteger(level) || level < 1 || level > 4) {
      return res.status(400).json({
        error: 'level must be an integer 1-4. Level 0 is the sealed compartment and is not set here.'
      });
    }
    if (level === 4 && confirm !== true) {
      return res.status(400).json({ error: 'Publishing to level 4 requires "confirm": true.' });
    }
    if (level === 4 && !String(reason || '').trim()) {
      return res.status(400).json({ error: 'Publishing to level 4 requires a non-empty "reason".' });
    }

    const existing = await projects.getById(access, req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const from = levelOfRead(existing.read);
    // Pulling a record back from public is incident response, not a routine correction.
    const takedown = from === 4 && level < 4;
    if (takedown && !access.roles.includes('sysadmin')) {
      return res.status(403).json({
        error: 'Only sysadmin may pull a record back from level 4. See docs/takedown-runbook.md.'
      });
    }

    const acl = { read: readForLevel(level), isPublished: level === 4 };
    const saved = await projects.upsert({
      ...existing,
      ...acl,
      id: existing.id,
      updatedAt: new Date().toISOString()
    });

    // Before the cascade, which can 500: the row someone comes looking for is the visibility
    // change, and it must not be the one path that records nothing.
    auditEvent(req, {
      action: takedown ? 'record.takedown' : (level > from ? 'record.widen' : 'record.narrow'),
      targetType: 'project',
      targetId: existing.id,
      projectId: existing.id,
      detail: { from, to: level, confirmed: confirm === true, reason: reason || '' }
    });

    if (level !== from) {
      const failure = await cascadeProjectVisibility(existing.id, acl);
      if (failure) return res.status(500).json({ success: false, error: failure });
    }

    return res.json(redactForAccess('projects', saved, access));
  } catch (err) {
    return serverError(res, err, 'project controller failed');
  }
};

/**
 * Classify a project's fields: `{ vis: { field: level } }`, `sysadmin` only.
 *
 * A dial is POLICY, not content, which is why `refusedWriteKeys` refuses `vis` on the ordinary PUT
 * and why this gate is narrower than `requireWrite`. Dials are independent of the record's own
 * level (docs/rbac-architecture.md §1) — there is no cap here beyond each field's catalog `maxVis`.
 *
 * A level of `null` REMOVES the dial; a field the body does not name keeps whatever it had.
 */
exports.setVisibility = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const existing = await projects.getById(access, req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const vis = req.body && req.body.vis;
    if (!vis || typeof vis !== 'object' || Array.isArray(vis) || !Object.keys(vis).length) {
      return res.status(400).json({ error: 'Body must carry a non-empty vis object of { field: level }.' });
    }

    const fields = Object.keys(vis);
    // One dial is one Cosmos patch operation, and patch() refuses more than its cap. Refused here
    // so the caller gets a 400 naming the limit rather than a 500 from the data layer.
    if (fields.length > PATCH_MAX_OPERATIONS) {
      return res.status(400).json({
        error: `At most ${PATCH_MAX_OPERATIONS} fields may be classified in one request, got ${fields.length}.`
      });
    }

    const catalog = catalogFor('projects');
    for (const field of fields) {
      // `hasOwn`, not truthiness: `catalog.constructor` and `catalog.__proto__` come off the
      // prototype and would read as catalogued, with an undefined `maxVis` that caps nothing.
      const entry = Object.hasOwn(catalog, field) ? catalog[field] : null;
      // An uncatalogued field has no policy, so a dial on it would be silently unreadable.
      if (!entry) {
        return res.status(400).json({ error: `Not a catalogued projects field: ${field}` });
      }
      const level = vis[field];
      if (level === null) continue;
      if (!Number.isInteger(level) || level < 0 || level > entry.maxVis) {
        return res.status(400).json({
          error: `Level for ${field} must be an integer 0 to ${entry.maxVis}, got ${JSON.stringify(level)}.`
        });
      }
    }

    const saved = await projects.patchVis(existing.id, vis);

    // Field NAMES and LEVELS only, never values — same rule as project.update, and it matters more
    // here: the fields being classified are the ones somebody decided were sensitive.
    const before = existing.vis && typeof existing.vis === 'object' ? existing.vis : {};
    auditEvent(req, {
      action: 'project.reclassify',
      targetType: 'project',
      targetId: existing.id,
      projectId: existing.id,
      detail: {
        fields,
        from: Object.fromEntries(fields.map(field => [field, before[field] ?? null])),
        to: vis
      }
    });

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
    // Same replace-the-whole-item trap as sources: an upsert with no vis wipes classification.
    if (existing && existing.vis) merged.vis = existing.vis;
    // And the same for the code: dropping it would leave a printed link pointing at nothing once
    // the nightly sync minted a second one.
    if (existing && existing.shortCode) merged.shortCode = existing.shortCode;

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
