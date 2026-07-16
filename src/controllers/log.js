'use strict';

const mongoose = require('mongoose');
const { logger } = require('../utils/logger');

/**
 * Retrieve application logs from the MongoDB Capped Collection.
 * Accessible only by administrators.
 * 
 * GET /api/admin/logs
 * Query Parameters:
 *   - level: filter by level (error, warn, info, debug)
 *   - requestId: filter by request trace ID
 *   - search: text search query
 *   - limit: number of logs to return (default: 100, max: 1000)
 *   - sort: sort direction (1 for oldest first, -1 for newest first, default: -1)
 */
exports.getLogs = async (req, res) => {
  try {
    const LogModel = mongoose.model('Log');

    const filter = {};

    // 1. Level filter
    if (req.query.level) {
      filter.level = req.query.level.toLowerCase();
    }

    // 2. RequestId filter
    if (req.query.requestId) {
      filter.requestId = req.query.requestId;
    }

    // 3. Text search
    if (req.query.search) {
      filter.message = { $regex: req.query.search, $options: 'i' };
    }

    // 4. Pagination / Limits
    let limit = parseInt(req.query.limit || '100', 10);
    if (isNaN(limit) || limit <= 0) limit = 100;
    if (limit > 1000) limit = 1000;

    // 5. Sorting
    let sortVal = -1;
    if (req.query.sort === '1' || req.query.sort === 'asc') {
      sortVal = 1;
    }

    logger.debug(`Retrieving logs with filter: ${JSON.stringify(filter)} limit: ${limit} sort: ${sortVal}`);

    const logs = await LogModel.find(filter)
      .sort({ timestamp: sortVal })
      .limit(limit)
      .lean();

    return res.status(200).json({
      success: true,
      count: logs.length,
      data: logs
    });
  } catch (err) {
    logger.error(`Error retrieving logs: ${err.message}`, { stack: err.stack });
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve application logs.'
    });
  }
};
