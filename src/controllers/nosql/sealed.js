'use strict';

/**
 * The sealed compartment — level 0 (docs/rbac-architecture.md §1, "Level 0").
 *
 * A sealed record IS a document: same container, same partition, `read: ['compliance']`. There is
 * no second store and no second ACL mechanism — what seals the row is that every caller without
 * that role carries an exclusion, the privileged ones and `systemAccess()` included.
 *
 * READS ARE AUDITED HERE AND NOWHERE ELSE IN DEMI. That asymmetry is the compartment's point.
 *
 * Separate from `controllers/nosql/document.js` on purpose: these four routes run their own guard
 * chain (`sealed-auth` + `requireRole('compliance')`), and nothing on the ladder may reach them.
 */

const crypto = require('crypto');

const documents = require('../../repositories/documents');
const projects = require('../../repositories/projects');
const chunks = require('../../repositories/chunks');
const {
  resolveAccess, systemAccess, pageSizeFor, readForLevel, levelOfRead
} = require('../../helpers/access-sql');
const { serverError } = require('../../helpers/response');
const aiSearch = require('../../search/ai-search');
const { logger } = require('../../utils/logger');
const { auditEvent } = require('../../utils/audit');
const { redactForAccess } = require('../../vis/redact');

/** The level a released record lands on — team only, never back onto the ladder above it. */
const RELEASE_LEVEL = 1;

exports.createSealed = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const { project, displayName, s3Key } = req.body || {};

    if (!project || !displayName || !s3Key) {
      return res.status(400).json({ error: 'Missing required fields: project, displayName, s3Key' });
    }

    // systemAccess for the PARENT EXISTENCE CHECK only, as the Eagle mirror does: a `compliance`
    // holder is not privileged on the ladder, so an ordinary staff-only project would 404 the very
    // seal it is being asked for.
    const parentProject = await projects.getById(systemAccess(), String(project));
    if (!parentProject) {
      return res.status(404).json({ error: `Parent Project with id ${project} not found.` });
    }

    const now = new Date().toISOString();
    // NOT resolveDocumentAcl: level 0 is off the ladder and narrower than any parent, so there is
    // nothing to cap against. The row is written with its real `read[]`, which is also what the
    // documents indexer carries into AI Search — `filterFor` hides it there by the same exclusion.
    const saved = await documents.upsert({
      id: crypto.randomUUID(),
      projectId: String(project),
      sourceSystem: 'demi',
      displayName,
      s3Key,
      read: readForLevel(0),
      isPublished: false,
      isDeleted: false,
      contentExtracted: false,
      sealedAt: now,
      createdAt: now,
      updatedAt: now
    });

    auditEvent(req, {
      action: 'sealed.create',
      targetType: 'document',
      targetId: saved.id,
      projectId: saved.projectId,
      detail: { displayName: saved.displayName }
    });

    return res.status(201).json(redactForAccess('documents', saved, access));
  } catch (err) {
    return serverError(res, err, 'sealed controller failed');
  }
};

exports.listSealed = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const { pageSize, error } = pageSizeFor(access, req.query.pageSize);
    if (error) return res.status(400).json({ error });

    const { items, continuationToken } = await documents.listSealed(access, {
      pageSize,
      continuationToken: req.query.continuationToken
    });

    if (continuationToken) res.setHeader('x-continuation-token', continuationToken);

    auditEvent(req, {
      action: 'sealed.list',
      targetType: 'document',
      detail: { count: items.length }
    });

    // Enough to find a record and ask for it, never enough to read one.
    return res.json(items.map(row => ({
      id: row.id,
      projectId: row.projectId,
      sealedAt: row.sealedAt || null,
      title: row.displayName || null
    })));
  } catch (err) {
    return serverError(res, err, 'sealed controller failed');
  }
};

exports.getSealed = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const doc = await documents.getById(access, req.params.id, req.query.project);

    // A record that is not sealed is not found HERE: this route is the compartment, not a second
    // door onto the ladder.
    if (!doc || levelOfRead(doc.read) !== 0) {
      return res.status(404).json({ error: 'Sealed record not found' });
    }

    auditEvent(req, {
      action: 'sealed.read',
      targetType: 'document',
      targetId: doc.id,
      projectId: doc.projectId
    });

    return res.json(redactForAccess('documents', doc, access));
  } catch (err) {
    return serverError(res, err, 'sealed controller failed');
  }
};

/**
 * The ONLY exit from level 0. `PUT /documents/:id/level` refuses level 0 in both directions, so
 * nothing else moves a record in or out of the compartment.
 *
 * One `compliance` holder is enough; two-person release is a later policy toggle.
 */
exports.releaseSealed = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const { caseNumber, decision } = req.body || {};

    if (!String(caseNumber || '').trim()) {
      return res.status(400).json({ error: 'caseNumber is required to release a sealed record.' });
    }
    if (!String(decision || '').trim()) {
      return res.status(400).json({ error: 'decision is required to release a sealed record.' });
    }

    const existing = await documents.getById(access, req.params.id, req.query.project);
    if (!existing || levelOfRead(existing.read) !== 0) {
      return res.status(404).json({ error: 'Sealed record not found' });
    }

    const updated = await documents.setPublished(existing.id, existing.projectId, RELEASE_LEVEL);

    // Before the cascade below, which can 500: the release has already landed by here, and this row
    // is the record of who took a document out of the compartment and on whose authority.
    auditEvent(req, {
      action: 'sealed.release',
      targetType: 'document',
      targetId: existing.id,
      projectId: existing.projectId,
      detail: { caseNumber, decision }
    });

    // No mailer in this repo; ACS Email is EPIC's send path and wiring it is TBD
    // (docs/rbac-architecture.md §1). The intent is logged so a release is never silent.
    logger.warn(`[sealed] release of ${existing.id} (case ${caseNumber}) — ` +
      'the C&E lead still has to be notified by hand; no mailer is wired.');

    const acl = readForLevel(RELEASE_LEVEL);
    await aiSearch.writeAcls(aiSearch.indexes().documents, [
      { id: existing.id, read: acl, isPublished: false }
    ]);

    // The CALLER's access, not systemAccess(): system holds no `compliance`, so it cannot see the
    // sealed chunks it would have to re-derive and they would stay sealed under a released document.
    const chunkAcl = await chunks.setAclForDocument(access, existing.id, acl);
    if (chunkAcl.failed > 0) {
      logger.error('[sealed] chunk ACL patch partially failed', {
        documentId: existing.id, ...chunkAcl
      });
      return res.status(500).json({
        success: false,
        error: 'Record released, but its extracted text was not fully updated.'
      });
    }

    return res.json(redactForAccess('documents', updated, access));
  } catch (err) {
    return serverError(res, err, 'sealed controller failed');
  }
};
