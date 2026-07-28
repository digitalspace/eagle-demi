'use strict';

const Record = require('../models/record');

/**
 * Get compliance and enforcement records
 */
async function getRecords(req, res) {
  try {
    const { project, dataset, agency, page = 1, limit = 50 } = req.query;
    const conditions = ['c.isPublished = true'];
    const parameters = [];

    if (project) {
      parameters.push({ name: '@proj', value: String(project) });
      conditions.push('c.project = @proj');
    }
    if (dataset) {
      parameters.push({ name: '@ds', value: String(dataset) });
      conditions.push('c.nrptiSchemaName = @ds');
    }
    if (agency) {
      parameters.push({ name: '@agency', value: String(agency) });
      conditions.push('c.issuingAgency = @agency');
    }

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 50;
    const whereClause = conditions.join(' AND ');

    const records = await Record.find(whereClause, parameters, { maxItemCount: limitNum });
    const total = await Record.countDocuments(whereClause, parameters);

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
      record = await Record.findOne('c.nrptiId = @id', [{ name: '@id', value: String(id) }]);
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
