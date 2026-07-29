'use strict';

const LogModel = require('../models/log');
const { logger } = require('../utils/logger');

exports.getLogs = async (req, res) => {
  try {
    // Admin-only route (authMiddleware), so no read ACL applies here.
    const filter = {};
    if (req.query.level) filter.level = String(req.query.level).toLowerCase();
    if (req.query.requestId) filter.requestId = String(req.query.requestId);

    let limit = parseInt(req.query.limit || '100', 10);
    if (isNaN(limit) || limit <= 0) limit = 100;
    if (limit > 1000) limit = 1000;

    const sortOrder = (req.query.sort === '1' || req.query.sort === 'asc') ? 1 : -1;

    const logs = await LogModel.find(filter, {
      maxItemCount: limit,
      sort: { timestamp: sortOrder }
    });

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
