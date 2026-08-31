'use strict';

/**
 * API key administration.
 *
 * Every route here is behind `authMiddleware` + `requireAdmin`, so reaching this file already
 * means a privileged caller that may administer the service — NOT merely one that may write data.
 * `demi-service-write` is refused at the route. Nothing here re-checks that.
 *
 * There is deliberately no update endpoint. Rotation is issue-new-then-revoke-old, which is what
 * makes it possible to rotate without a window where the consumer has no working credential — and
 * it means a key's roles can never be silently widened after issuance.
 */

const apiKeys = require('../../repositories/api-keys');
const { generateKey, defaultExpiry } = require('../../helpers/api-key');
const { AUTHENTICATED_ROLES, WRITE_ROLES } = require('../../helpers/access-sql');
const { forgetCachedKey } = require('../../helpers/auth');
const { logger } = require('../../utils/logger');
const { serverError } = require('../../helpers/response');
const { auditEvent } = require('../../utils/audit');
const config = require('../../config');

/**
 * Roles a key may be granted. A key can never be given a role DEMI does not recognise.
 *
 * Derived from AUTHENTICATED_ROLES rather than listed, so a new tier is grantable the moment it
 * exists. SECURE_ROLES alone would drop `staff`, which left it in P3-2, and make staff keys
 * unmintable.
 * Exported for the test that asserts the derivation still reaches `demi-service-write` — a role
 * the mint route rejects as unknown is a role nobody can hold.
 */
const GRANTABLE_ROLES = Array.from(new Set([...AUTHENTICATED_ROLES, 'compliance', 'public']));
exports.GRANTABLE_ROLES = GRANTABLE_ROLES;

/**
 * The only id a caller may choose: an APIM subscription's identity row.
 *
 * These rows carry roles and no secret — APIM has already verified the subscription key, and
 * `helpers/auth.js:resolveGatewaySubscription` looks the row up by exactly this id. Every other id
 * stays a random one, so no caller can squat an id or overwrite a minted key by naming it.
 */
const APIM_ROW_ID = /^apim:[a-z0-9-]+$/;

exports.createApiKey = async (req, res) => {
  try {
    const { name, roles, projectScope, expiresAt, id } = req.body || {};

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

    // A typo here used to mint a key with a junk expiry; verify() now fails closed on one, so
    // without this the caller would get a 201 for a key that never authenticates.
    if (expiresAt && !(new Date(expiresAt).getTime() > Date.now())) {
      return res.status(400).json({ error: 'expiresAt must be a future date' });
    }

    if (id !== undefined && !APIM_ROW_ID.test(String(id))) {
      return res.status(400).json({
        error: 'id may only be an APIM subscription identity: apim:<subscription-name>'
      });
    }
    // Same answer a duplicate short-link code gets. There is no update endpoint, so silently
    // upserting here would be the one way to widen an existing row's roles.
    if (id && await apiKeys.getById(id)) {
      return res.status(409).json({ error: `id ${id} already in use. Revoke it before reissuing.` });
    }

    // Least privilege is the default posture, so granting write is possible but never accidental.
    const grantsWrite = roles.some(r => WRITE_ROLES.includes(r));
    if (grantsWrite && req.body.allowWrite !== true) {
      return res.status(400).json({
        error: `Roles ${roles.filter(r => WRITE_ROLES.includes(r)).join(', ')} can mutate data. ` +
               'Pass allowWrite: true to confirm, or use demi-service-read for a read-only ' +
               'consumer. A machine writer wants demi-service-write, not demi-admin.'
      });
    }

    // No key material for an APIM row: there would be nothing to present it to, and a stored
    // digest nobody can use is a credential to leak for no reason. `verify` fails closed on a
    // record with no `hash`, so such a row can never authenticate through the X-Api-Key path.
    const minted = id ? null : generateKey(config.environmentName || 'dev');
    const keyId = id || minted.keyId;

    const record = {
      id: keyId,
      name,
      hash: minted ? minted.hash : null,
      roles,
      projectScope: Array.isArray(projectScope) ? projectScope.map(String) : null,
      createdAt: new Date().toISOString(),
      createdBy: (req.user && req.user.preferred_username) || 'unknown',
      // APIM owns the subscription's lifecycle, so an identity row does not expire on its own.
      expiresAt: expiresAt || (minted ? defaultExpiry() : null),
      revokedAt: null,
      lastUsedAt: null
    };

    await apiKeys.upsert(record);
    logger.info(`[demi-api] API key ${keyId} issued to '${name}' by ${record.createdBy}`);

    // keyId is the PUBLIC half and is safe to record; `plaintext` and `hash` are not in this
    // object and must never be added to it — an audit table is exactly the wrong place to put a
    // credential that is kept for seven years.
    auditEvent(req, {
      action: 'apikey.create',
      targetType: 'apikey',
      targetId: keyId,
      detail: {
        name,
        roles,
        grantsWrite,
        viaGateway: Boolean(id),
        projectScope: record.projectScope,
        expiresAt: record.expiresAt
      }
    });

    // The plaintext is returned HERE and nowhere else, ever. It is not stored and cannot be
    // recovered — a lost key is reissued, not looked up. An APIM row has none: its caller
    // authenticates at the gateway, and the row only says what that caller may do.
    return res.status(201).json(minted
      ? { ...apiKeys.redact(record), key: minted.plaintext }
      : apiKeys.redact(record));
  } catch (err) {
    return serverError(res, err, 'api key issue failed');
  }
};

exports.listApiKeys = async (_req, res) => {
  try {
    return res.json(await apiKeys.listRedacted());
  } catch (err) {
    return serverError(res, err, 'api key list failed');
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

    auditEvent(req, {
      action: 'apikey.revoke',
      targetType: 'apikey',
      targetId: req.params.id,
      detail: { name: revoked.name, roles: revoked.roles }
    });

    return res.json({ message: 'API key revoked', key: revoked });
  } catch (err) {
    return serverError(res, err, 'api key revoke failed');
  }
};
