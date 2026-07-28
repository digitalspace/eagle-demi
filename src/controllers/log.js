'use strict';

const LogModel = require('../models/log');
const { logger } = require('../utils/logger');

exports.getLogs = async (req, res) => {
  try {
    const conditions = [];
    const parameters = [];

    if (req.query.level) {
      parameters.push({ name: '@level', value: req.query.level.toLowerCase() });
      conditions.push('c.level = @level');
    }

    if (req.query.requestId) {
      parameters.push({ name: '@reqId', value: req.query.requestId });
      conditions.push('c.requestId = @reqId');
    }

    let limit = parseInt(req.query.limit || '100', 10);
    if (isNaN(limit) || limit <= 0) limit = 100;
    if (limit > 1000) limit = 1000;

    const sortOrder = (req.query.sort === '1' || req.query.sort === 'asc') ? 'ASC' : 'DESC';
    const whereClause = conditions.length > 0 ? conditions.join(' AND ') : '';

    const logs = await LogModel.find(whereClause, parameters, {
      maxItemCount: limit,
      orderBy: `c.timestamp ${sortOrder}`
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
