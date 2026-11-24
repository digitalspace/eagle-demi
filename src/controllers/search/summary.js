'use strict';

const { resolveAccess } = require('../../helpers/access-sql');
const { redactAllForAccess } = require('../../vis/redact');
const { logger } = require('../../utils/logger');
const { filterFor } = require('../../helpers/access-odata');
const aiSearch = require('../../search/ai-search');
const documentsRepo = require('../../repositories/documents');
const projectsRepo = require('../../repositories/projects');
const chunksRepo = require('../../repositories/chunks');
const summarizer = require('../../ai/summarize');
const config = require('../../config');

/**
 * `GET /api/search/summary`, PRIVILEGED ONLY (behind `authMiddleware`). See wiki ADR-006 and
 * Search-Query-Construction#the-summary-endpoints-gates.
 */
exports.summarize = async (req, res) => {
  const keywords = req.query.keywords || req.query.q || '';
  if (!keywords) {
    return res.json({ summary: null, citations: [], reason: 'no_query' });
  }

  try {
    const access = resolveAccess(req);
    // Chunks again, so the same document field as the chunk search in `exports.search` (search.js).
    const { filter, empty } = filterFor(access, 'projectId', 'documentId');

    // Same fail-closed branch as the chunk search, for the same reason: a caller who may see
    // nothing cannot be expressed as a filter, and issuing one without would summarise everything.
    if (empty) {
      return res.json({ summary: null, citations: [], reason: 'no_results' });
    }

    const { items } = await aiSearch.searchChunks({
      filter,
      keywords,
      fuzzy: req.query.fuzzy === 'true',
      top: config.summaryMaxChunks
    });

    if (items.length === 0) {
      // The model is never called. This is the grounding guarantee the nonsense-term probe checks:
      // a build that returns prose here is answering from model knowledge, not from the corpus.
      return res.json({ summary: null, citations: [], reason: 'no_results' });
    }

    // Gates two and three: `getById` re-applies the ACL, and the parent-document read catches a stale
    // chunk `read[]`. See wiki Search-Query-Construction#the-summary-endpoints-gates.
    const [fetched, parentDocs] = await Promise.all([
      Promise.all(items.map(c => chunksRepo.getById(access, String(c.chunkId), String(c.documentId)))),
      documentsRepo.listByIds(access, items.map(c => c.documentId), items.map(c => c.projectId))
    ]);
    // Redacted before `citations` reads a name off it; `id` is 4/4, so this stays the parent gate.
    const docById = new Map(redactAllForAccess('documents', parentDocs, access)
      .map(d => [String(d.id), d]));

    // Response metadata reads off the redacted row. `content` (maxVis 0) is read off the raw
    // `fetched` row: the model call is its only consumer, gated by the parent document above.
    const rows = redactAllForAccess('chunks', fetched, access);

    const chunks = rows
      .map((row, i) => ({ row, text: fetched[i] && fetched[i].content }))
      .filter(({ row, text }) => row && row.documentId && text && docById.has(String(row.documentId)))
      .map(({ row, text }) => ({
        chunkId: String(row.id || ''),
        documentId: String(row.documentId || ''),
        projectId: String(row.projectId || ''),
        pageNumber: row.pageNumber ?? 0,
        content: text
      }));

    // A withheld count is the symptom of a stale chunk ACL, but empty `content` counts too, so it is
    // not proof on its own.
    if (chunks.length !== items.length) {
      logger.warn('[search/summary] withheld chunks whose parent document is not visible or whose text is empty', {
        withheld: items.length - chunks.length, returned: chunks.length
      });
    }

    const { summary, citations, reason, usage, estimatedCostCad } =
      await summarizer.summarize(keywords, chunks);

    // Hydrate ONLY the cited chunks, under the CALLER's access, never systemAccess(). Documents are
    // already in `docById`, so the 'Untitled Document' fallback below cannot fire here.
    const cited = citations.map(i => chunks[i]);
    const citedProjects = cited.length > 0
      ? await projectsRepo.listByIds(access, cited.map(c => c.projectId))
      : [];
    const projById = new Map(redactAllForAccess('projects', citedProjects, access)
      .map(p => [String(p.id), p]));

    return res.json({
      summary,
      // Resolved back to the chunks they point at, so the UI can render a source list rather than
      // a bare number. Indices are into the array actually sent to the model.
      citations: cited.map((c, idx) => {
        const parent = docById.get(c.documentId);
        const project = projById.get(c.projectId);
        return {
          n: citations[idx] + 1,
          chunkId: c.chunkId,
          documentId: c.documentId,
          projectId: c.projectId,
          pageNumber: c.pageNumber,
          documentName:
            (parent && (parent.displayName || parent.documentFileName)) || 'Untitled Document',
          projectName: (project && project.name) || 'Associated Project'
        };
      }),
      // What the answer cost. An ESTIMATE from reported tokens and configured list rates — see
      // estimateCostCad. Null when the model was never called.
      usage: usage || null,
      estimatedCostCad: estimatedCostCad ?? null,
      ...(reason ? { reason } : {})
    });
  } catch (err) {
    // Additive: the panel disappears, the results columns do not. 200 rather than 5xx because the
    // frontend retries 5xx and lands here again regardless.
    logger.error(`[search/summary] failed: ${err.message}`);
    return res.json({ summary: null, citations: [], reason: 'error' });
  }
};
