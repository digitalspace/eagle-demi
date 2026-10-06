'use strict';

/**
 * Reads against a container the infrastructure may not have created yet. The user, group and
 * inspection containers ship in a separate infra change, and code that reaches them must not fail
 * the project cascade or the reconcile until they exist.
 */

const { logger } = require('../utils/logger');

const warned = new Set();

/**
 * `work()`'s result, or null when Cosmos answers 404 for the container itself. A query never
 * 404s for a missing row, so on these read paths a 404 means the container is not there. Any
 * other error is thrown as it was. Warns once per container per process.
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
