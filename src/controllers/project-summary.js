'use strict';

/**
 * The stored per-project AI summary — read for the page, written by the generator.
 *
 * THE PAGE NEVER CALLS A MODEL. The record was generated offline (src/ai/project-summary.js) and
 * stored; this is a point read. That is what makes the page instant and the cost bounded per
 * generation rather than per view.
 *
 * The access gate is the PROJECT, not the record. A summary row carries no ACL of its own, and it
 * does not need one: every source document it was built from is public (`isPublicSource` in
 * src/ai/project-summary.js), which `putProjectSummary` refuses a record that does not assert. So
 * nothing in the record is narrower than the project, and "may this caller see it" is answered by
 * re-reading the project under the caller's access, exactly as `GET /projects/:id` does. A caller
 * who gets 404 there gets 404 here.
 */

const projects = require('../repositories/projects');
const documents = require('../repositories/documents');
const chunks = require('../repositories/chunks');
const projectSummaries = require('../repositories/projectSummaries');
const { resolveAccess, pageSizeFor } = require('../helpers/access-sql');
const { SOURCE_ACCESS } = require('../ai/project-summary');
const { serverError } = require('../helpers/response');
const { logger } = require('../utils/logger');
const config = require('../config');

/**
 * The project this request is about, under the caller's own access, or null.
 *
 * Both id spaces, for the same reason `GET /projects/:id` takes both: eagle-public holds Eagle
 * ObjectIds and DEMI ids are Track integers. `getById` gates the point read internally.
 */
function readProject(access, id) {
  return projects.EAGLE_OBJECT_ID.test(id)
    ? projects.getByEagleId(access, id)
    : projects.getById(access, id);
}

/** `GET /api/projects/:id/summary` */
exports.getProjectSummary = async (req, res) => {
  try {
    // Reported before the project read, so an operator asking "why is the page empty" gets the
    // configuration answer without needing a readable project to ask it about.
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

    // A record stored before the generator filtered its sources may cite a document narrower than
    // the project, and the project gate alone would serve it. Withheld until it is regenerated —
    // the same answer as no record at all, which is what it now is.
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
 * `GET /api/documents/:id/chunks` — one document's extracted text, in page order.
 *
 * Lives here rather than in the document controller because it serves the generator and emits
 * CHUNK rows, not document rows.
 *
 * The only route that returns full chunk `content`. Two gates, the same two the summary endpoint
 * applies: `authMiddleware` so no anonymous caller arrives, and the PARENT DOCUMENT read under the
 * caller's access — a chunk's own `read[]` is an ingest-time snapshot and can outlive its parent's
 * visibility, so the parent is what decides.
 *
 * `content` is deliberately not redacted: it is `maxVis 0` in the chunks catalog, so the redactor
 * would strip the one field this route exists to serve. The projection below is explicit and
 * carries no document field — no `s3Key`, no `read[]` — which is what keeps that safe.
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

    // `count` is the whole document, not the page: the generator walks pages and needs to know
    // when it has the document, and a page-length total would stop it a page early.
    return res.json({ items: projection, count: rows.length, page, pageSize });
  } catch (err) {
    return serverError(res, err, 'project summary controller failed');
  }
};

/**
 * Every `citations` number under `sections`, whatever section shape holds it.
 *
 * The sections do not share a shape — a sentence carries `citations` directly, the conditions list
 * carries one per item, the timeline one per event — so this walks rather than naming paths. A
 * section added later is covered without an edit here, which is the point: the check is worth
 * having only if it cannot be forgotten.
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
 * The shape a stored record must have.
 *
 * Hand-rolled and deliberately shallow: this rejects a body that is not a summary record at all,
 * which is what a write route owes the container. The claim-level gates that need the SOURCES —
 * number and date grounding — live in the generator, where the chunks that would prove them are
 * still in hand; re-checking those here would need every source chunk re-fetched to say anything
 * the generator has not already said.
 *
 * Citation RANGE is the exception, and it is checked here because both sides of it are in the body.
 * A section citing source 9 of a six-entry list renders as a footnote link to nothing, and it is
 * exactly what a record written by a stale or half-finished generator looks like.
 */
function contractError(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be an object';
  if (typeof body.generatedAt !== 'string' || !body.generatedAt) return 'generatedAt is required';
  // The record's own claim that it cites public documents only, which is what lets the read route
  // gate on the project alone. A generator that does not assert it is one that predates the filter.
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
 * `PUT /api/projects/:id/summary` — the generator's write.
 *
 * `requireWrite`, so a read-only credential cannot store prose that renders as EAO's account of a
 * project. The project is read under the caller's access first for the same reason the GET does it:
 * a caller who cannot see the project cannot create a record about it.
 *
 * The stored `id` and `projectId` come from the RESOLVED PROJECT, not from the body — otherwise a
 * body naming another project would write into that project's partition through this project's
 * ACL check.
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
    return res.json(saved);
  } catch (err) {
    return serverError(res, err, 'project summary controller failed');
  }
};
