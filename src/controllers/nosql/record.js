'use strict';

/**
 * NRPTI compliance records — Cosmos NoSQL.
 *
 * The Mongo version first resolved the project and read a folded copy of the records embedded
 * in the project document, falling back to the collection. That embedding is what pushed
 * projects toward the 2 MB item cap, so it is gone: records are always read from their own
 * container, partitioned by project.
 */

const records = require('../../repositories/records');
const { resolveAccess } = require('../../helpers/access-sql');

async function getRecords(req, res) {
  try {
    const access = resolveAccess(req);
    const { project, dataset, agency, limit = 50, continuationToken } = req.query;

    const criteria = {
      projectId: project,
      dataset,
      agency,
      pageSize: Math.min(parseInt(limit, 10) || 50, 1000),
      continuationToken
    };

    const [page, total] = await Promise.all([
      records.listVisible(access, criteria),
      // Same predicate as the read — a count from a different filter would leak the size of
      // a set the caller cannot see.
      records.countVisible(access, criteria)
    ]);

    return res.json({
      success: true,
      data: page.items,
      pagination: {
        total,
        limit: criteria.pageSize,
        continuationToken: page.continuationToken || null
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

async function getRecord(req, res) {
  try {
    const access = resolveAccess(req);
    const record = await records.getById(access, req.params.id, req.query.project);

    if (!record) {
      return res.status(404).json({ success: false, error: 'Record not found' });
    }
    return res.json({ success: true, data: record });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { getRecords, getRecord };
