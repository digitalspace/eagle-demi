'use strict';

/**
 * NRPTI mines and compliance records of one project, read from what `sync-nrpti` stored. Both
 * routes 404 unless `ENRICHMENT_SOURCES` lists `nrpti`, so prod answers as if they did not exist.
 */

const config = require('../config');
const projects = require('../repositories/projects');
const mines = require('../repositories/mines');
const regulatoryRecords = require('../repositories/regulatory-records');
const { resolveAccess, pageSizeFor } = require('../helpers/access-sql');
const { redactAllForAccess } = require('../vis/redact');
const { serverError } = require('../helpers/response');
const { NO_STORE } = require('./nosql/mirror-reads');

function listForProject(entity, repository) {
  return async (req, res) => {
    try {
      if (!config.enrichmentSources.includes('nrpti')) return res.status(404).json({ error: 'Not found' });

      const access = resolveAccess(req);
      if (access.authenticated) res.setHeader('cache-control', NO_STORE);
      const { pageSize, error } = pageSizeFor(access, req.query.pageSize);
      if (error) return res.status(400).json({ error });

      // Same id rule as GET /projects/:id, so a hex Eagle id lists the rows of the project it names.
      const project = projects.EAGLE_OBJECT_ID.test(req.params.id)
        ? await projects.getByEagleId(access, req.params.id)
        : await projects.getById(access, req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const { items, continuationToken } = await repository.listByProject(access, project.id,
        { pageSize, continuationToken: req.query.continuationToken });
      if (continuationToken) res.setHeader('x-continuation-token', continuationToken);
      return res.json(redactAllForAccess(entity, items, access));
    } catch (err) {
      return serverError(res, err, `${entity} list failed`);
    }
  };
}

exports.getMines = listForProject('mines', mines);
exports.getRegulatoryRecords = listForProject('regulatoryRecords', regulatoryRecords);
