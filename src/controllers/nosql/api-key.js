'use strict';

/**
 * API key administration.
 *
 * Every route here is behind `authMiddleware` + `requireWrite`, so reaching this file already
 * means a privileged, write-capable caller. Nothing here re-checks that.
 *
 * There is deliberately no update endpoint. Rotation is issue-new-then-revoke-old, which is what
 * makes it possible to rotate without a window where the consumer has no working credential — and
 * it means a key's roles can never be silently widened after issuance.
 */

const apiKeys = require('../../repositories/api-keys');
const { generateKey, defaultExpiry } = require('../../helpers/api-key');
const { SECURE_ROLES, WRITE_ROLES } = require('../../helpers/access-sql');
const { forgetCachedKey } = require('../../helpers/auth');
const { logger } = require('../../utils/logger');
const config = require('../../config');

/** Roles a key may be granted. A key can never be given a role DEMI does not recognise. */
const GRANTABLE_ROLES = Array.from(new Set([...SECURE_ROLES, 'compliance', 'public']));

exports.createApiKey = async (req, res) => {
  try {
    const { name, roles, projectScope, expiresAt } = req.body || {};

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Missing required field: name' });
    }
    if (!Array.isArray(roles) || roles.length === 0) {
      return res.status(400).json({ error: 'Missing required field: roles (non-empty array)' });
    }

    const unknown = roles.filter(r => !GRANTABLE_ROLES.includes(r));
    if (unknown.length > 0) {
      return res.status(400).json({ error: `Unknown role(s): ${unknown.join(', ')}` });
    }

    // Least privilege is the default posture, so granting write is possible but never accidental.
    const grantsWrite = roles.some(r => WRITE_ROLES.includes(r));
    if (grantsWrite && req.body.allowWrite !== true) {
      return res.status(400).json({
        error: `Roles ${roles.filter(r => WRITE_ROLES.includes(r)).join(', ')} can mutate data. ` +
               'Pass allowWrite: true to confirm, or use demi-service-read for a read-only consumer.'
      });
    }

    const { keyId, plaintext, hash } = generateKey(config.environmentName || 'dev');

    const record = {
      id: keyId,
      name,
      hash,
      roles,
      projectScope: Array.isArray(projectScope) ? projectScope.map(String) : null,
      createdAt: new Date().toISOString(),
      createdBy: (req.user && req.user.preferred_username) || 'unknown',
      expiresAt: expiresAt || defaultExpiry(),
      revokedAt: null,
      lastUsedAt: null
    };

    await apiKeys.upsert(record);
    logger.info(`[demi-api] API key ${keyId} issued to '${name}' by ${record.createdBy}`);

    // The plaintext is returned HERE and nowhere else, ever. It is not stored and cannot be
    // recovered — a lost key is reissued, not looked up.
    return res.status(201).json({ ...apiKeys.redact(record), key: plaintext });
  } catch (err) {
    logger.error(`[demi-api] Failed to issue API key: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
};

exports.listApiKeys = async (_req, res) => {
  try {
    return res.json(await apiKeys.listRedacted());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.revokeApiKey = async (req, res) => {
  try {
    const revoked = await apiKeys.revoke(req.params.id);
    if (!revoked) {
      return res.status(404).json({ error: 'API key not found' });
    }

    // Immediate on this instance; other instances honour it within the lookup cache TTL.
    forgetCachedKey(req.params.id);
    logger.info(`[demi-api] API key ${req.params.id} revoked by ${(req.user && req.user.preferred_username) || 'unknown'}`);

    return res.json({ message: 'API key revoked', key: revoked });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
