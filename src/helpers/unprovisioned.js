'use strict';

/**
 * Reads against a container infra may not have created yet; a missing one must not fail the
 * project cascade or the reconcile.
 */

const { logger } = require('../utils/logger');

const warned = new Set();

/**
 * Null on a 404: a query never 404s for a missing row, so on these paths the container is absent.
 * Warns once per container per process.
 */
async function unlessUnprovisioned(container, work) {
  try {
    return await work();
  } catch (err) {
    if ((err && (err.code ?? err.statusCode)) !== 404) throw err;
    if (!warned.has(container)) {
      warned.add(container);
      logger.warn(`[cosmos] container ${container} is not provisioned, skipping it`, { container });
    }
    return null;
  }
}

module.exports = { unlessUnprovisioned };
