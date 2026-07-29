'use strict';

const Record = require('../models/record');
const { rolesFor, withReadFilter } = require('../helpers/access');

// User input reaches $regex below — escape it so a crafted project name can neither
// inject a pattern nor mount a ReDoS.
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Get compliance and enforcement records
 */
async function getRecords(req, res) {
  try {
    const { project, dataset, agency, page = 1, limit = 50 } = req.query;
    const Project = require('../models/project');

    if (project) {
      let matchedProj = await Project.findById(project);
      if (!matchedProj) {
        const numId = isNaN(project) ? -1 : Number(project);
        matchedProj = await Project.findOne({
          $or: [
            { trackProjectId: numId },
            { legacyEagleId: String(project) },
            { name: { $regex: `^${escapeRegex(String(project))}$`, $options: 'i' } }
          ]
        });
      }

      if (matchedProj) {
        const folded = matchedProj.nrptiRecords || matchedProj.sources?.nrpti?.records;
        if (folded && Array.isArray(folded) && folded.length > 0) {
          let filtered = folded;
          if (dataset) filtered = filtered.filter(r => (r.nrptiSchemaName || r.recordType) === dataset);
          if (agency) filtered = filtered.filter(r => r.issuingAgency === agency);
          return res.json({
            success: true,
            data: filtered,
            pagination: {
              total: filtered.length,
              page: 1,
              limit: limit ? parseInt(limit, 10) : 50,
              pages: 1
            }
          });
        }
      }
    }

    const roles = rolesFor(req);
    const criteria = {};

    if (project) {
      criteria.$or = [
        { project: String(project) },
        { projectName: { $regex: escapeRegex(String(project)), $options: 'i' } }
      ];
    }
    if (dataset) criteria.nrptiSchemaName = String(dataset);
    if (agency) criteria.issuingAgency = String(agency);

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 50;
    const filter = withReadFilter(roles, criteria);

    const records = await Record.find(filter, { maxItemCount: limitNum });
    // Count with the SAME filter so the total cannot leak hidden records.
    const total = await Record.countDocuments(filter);

    res.json({
      success: true,
      data: records,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil((total || 1) / limitNum)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Get single compliance record
 */
async function getRecord(req, res) {
  try {
    const { id } = req.params;
    let record = await Record.findById(id);
    if (!record) {
      record = await Record.findOne({ nrptiId: String(id) });
    }

    if (!record) {
      return res.status(404).json({ success: false, error: 'Record not found' });
    }

    res.json({ success: true, data: record });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = {
  getRecords,
  getRecord
};
