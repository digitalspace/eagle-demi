'use strict';

/**
 * Stored AI summary: the page never calls a model, it point-reads what src/ai/project-summary.js wrote.
 * The gate is the PROJECT: the record cites public sources only, so it is never narrower than the project.
 */

const projects = require('../repositories/projects');
const documents = require('../repositories/documents');
const chunks = require('../repositories/chunks');
const projectSummaries = require('../repositories/projectSummaries');
const { resolveAccess, pageSizeFor } = require('../helpers/access-sql');
const { SOURCE_ACCESS } = require('../ai/project-summary');
const { serverError } = require('../helpers/response');
const { logger } = require('../utils/logger');
const { auditEvent } = require('../utils/audit');
const config = require('../config');

/**
 * The project this request is about, under the caller's own access, or null. Takes Eagle ObjectIds
 * and DEMI ids (Track integer or UUID), like `GET /projects/:id`; `getById` gates the read itself.
 */
function readProject(access, id) {
  return projects.EAGLE_OBJECT_ID.test(id)
    ? projects.getByEagleId(access, id)
    : projects.getById(access, id);
}

/** `GET /api/projects/:id/summary` */
exports.getProjectSummary = async (req, res) => {
  try {
    // Before the project read, so "disabled" is answered without a readable project.
    if (!config.summaryEnabled) {
      return res.json({ summary: null, reason: 'disabled' });
    }

    const access = resolveAccess(req);
    const project = await readProject(access, req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Keyed by the DEMI project id, never by the id in the URL: an Eagle ObjectId resolves to a
    // project whose summary is stored under its DEMI id, and looking up the URL id would 404.
    const record = await projectSummaries.getById(project.id);
    if (!record) {
      return res.status(404).json({ error: 'no_summary' });
    }

    // A record not asserting public sources may cite a document narrower than the project: withheld
    // as if absent until regenerated.
    if (record.sourceAccess !== SOURCE_ACCESS) {
      logger.warn('[project-summary] record withheld: it does not assert public sources', {
        projectId: String(project.id), sourceAccess: record.sourceAccess || null
      });
      return res.status(404).json({ error: 'no_summary' });
    }

    return res.json(record);
  } catch (err) {
    return serverError(res, err, 'project summary controller failed');
  }
};

/**
 * `GET /api/documents/:id/chunks`: the only route serving full chunk `content`, gated on the parent
 * document read. Not redacted (`content` is maxVis 0); the explicit projection keeps it safe.
 */
exports.getDocumentChunks = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const doc = await documents.getById(access, req.params.id, req.query.project);
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const { pageSize, error } = pageSizeFor(access, req.query.pageSize);
    if (error) return res.status(400).json({ error });
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

    const rows = await chunks.allForDocument(access, String(doc.id));
    const start = (page - 1) * pageSize;
    const projection = rows.slice(start, start + pageSize).map(row => ({
      chunkId: String(row.id),
      documentId: String(row.documentId),
      projectId: String(row.projectId || ''),
      pageNumber: row.pageNumber ?? 0,
      content: row.content || ''
    }));

    // Whole-document count, not the page: the generator walks pages and would stop a page early.
    return res.json({ items: projection, count: rows.length, page, pageSize });
  } catch (err) {
    return serverError(res, err, 'project summary controller failed');
  }
};

/**
 * Every `citations` number under `sections`. Walks instead of naming paths: sections differ in
 * shape, and a new section must be covered without an edit here.
 */
function citationNumbers(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) citationNumbers(item, found);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'citations' && Array.isArray(child)) found.push(...child);
      else citationNumbers(child, found);
    }
  }
  return found;
}

/**
 * Shallow shape check. Number and date grounding live in the generator, which holds the chunks;
 * citation range is checked here because both sides are in the body.
 */
function contractError(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be an object';
  if (typeof body.generatedAt !== 'string' || !body.generatedAt) return 'generatedAt is required';
  // The record's own claim that it cites public documents only, which lets the read route gate on
  // the project alone.
  if (body.sourceAccess !== SOURCE_ACCESS) return `sourceAccess must be "${SOURCE_ACCESS}"`;
  if (!body.facts || typeof body.facts !== 'object') return 'facts is required';
  if (!body.sections || typeof body.sections !== 'object') return 'sections is required';
  if (!Array.isArray(body.citations)) return 'citations must be an array';

  const cited = citationNumbers(body.sections);
  const bad = cited.findIndex(n => !Number.isInteger(n) || n < 1 || n > body.citations.length);
  if (bad !== -1) {
    return `a section cites source ${JSON.stringify(cited[bad])}, outside 1..${body.citations.length}`;
  }
  return null;
}

/**
 * `PUT /api/projects/:id/summary`. Stored `id` and `projectId` come from the RESOLVED PROJECT, never
 * the body, or a body could write another project's partition through this project's ACL check.
 */
exports.putProjectSummary = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const project = await readProject(access, req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const problem = contractError(req.body);
    if (problem) {
      return res.status(400).json({ error: `Invalid summary record: ${problem}` });
    }

    const record = {
      ...req.body,
      id: String(project.id),
      projectId: String(project.id)
    };

    const saved = await projectSummaries.upsert(record);
    logger.info('[project-summary] stored', {
      projectId: String(project.id),
      model: record.model || null,
      estimatedCostCad: record.estimatedCostCad ?? null
    });
    auditEvent(req, {
      action: 'projectSummary.save',
      targetType: 'projectSummary',
      targetId: record.id,
      projectId: record.projectId,
      detail: { generatedAt: record.generatedAt, model: record.model || null, citations: record.citations.length }
    });
    return res.json(saved);
  } catch (err) {
    return serverError(res, err, 'project summary controller failed');
  }
};
