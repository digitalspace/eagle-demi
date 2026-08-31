'use strict';

const cosmos = require('../db/cosmos-nosql');
const { logger } = require('../utils/logger');

/**
 * Readiness — actually reaches the database. ping() returns FALSE rather than throwing when the
 * account is unconfigured, so a truthy check is required; `try/catch` alone is not enough.
 */
exports.db = async (req, res) => {
  try {
    const ok = await cosmos.ping();
    if (!ok) {
      return res.status(503).json({ ok: false, error: 'Database client is not configured.' });
    }
    return res.json({ ok: true, driver: 'cosmos-db-nosql' });
  } catch (err) {
    // Unauthenticated route: a Cosmos SDK failure message carries the account endpoint and the
    // database and container names. The detail goes to the log, not to the caller.
    logger.error('Health check failed', { error: err.message, stack: err.stack });
    return res.status(503).json({ ok: false, error: 'Database unavailable.' });
  }
};
