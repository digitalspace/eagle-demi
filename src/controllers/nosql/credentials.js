'use strict';

/**
 * Selected Credentials administration (docs/rbac-architecture.md §1).
 *
 * Every route here is `authMiddleware, requireWrite, requireRole('sysadmin')`: a grant hands one
 * named party sight of records nobody widened, so it is access policy rather than data, and it is
 * the same gate the classify endpoint carries. Nothing here re-checks that.
 *
 * There is deliberately no update endpoint. A grant is minted and revoked; changing its scope,
 * levels or window means a new row, so what was in force at any past moment stays readable.
 */

const crypto = require('crypto');
const credentials = require('../../repositories/credentials');
const { grantError, defaultEnd } = require('../../helpers/credentials');
const { forgetCachedParty } = require('../../middleware/credentials');
const { serverError } = require('../../helpers/response');
const { logger } = require('../../utils/logger');
const { auditEvent } = require('../../utils/audit');

/** The four ways a revoke names a set, narrowest first. Exactly one per request. */
const SELECTORS = ['id', 'batchId', 'party', 'projectId'];

exports.createCredential = async (req, res) => {
  try {
    const body = req.body || {};
    const refusal = grantError(body);
    if (refusal) return res.status(400).json({ error: refusal });

    const now = new Date().toISOString();
    const record = {
      id: crypto.randomUUID(),
      party: { type: body.party.type, id: String(body.party.id) },
      scope: { type: body.scope.type, ids: body.scope.ids.map(String) },
      levels: body.levels,
      start: body.start || now,
      end: body.end || defaultEnd(),
      grantedBy: (req.user && req.user.preferred_username) || 'unknown',
      grantedAt: now,
      revokedAt: null,
      // Supplied when several grants are minted together, so one revoke can take them all back.
      batchId: body.batchId ? String(body.batchId) : crypto.randomUUID(),
      note: body.note || ''
    };

    const saved = await credentials.insert(record);
    forgetCachedParty(record.party.id);
    logger.info(
      `[demi-api] credential ${record.id} granted to ${record.party.type}:${record.party.id} ` +
      `by ${record.grantedBy}`
    );

    auditEvent(req, {
      action: 'credential.grant',
      targetType: 'credential',
      targetId: record.id,
      // One project-scoped id is the common grant, and it is what makes the row findable by
      // project; a multi-id or document-scoped grant carries its scope in Detail instead.
      projectId: record.scope.type === 'project' && record.scope.ids.length === 1
        ? record.scope.ids[0]
        : '',
      detail: {
        party: record.party,
        scopeType: record.scope.type,
        scopeIds: record.scope.ids.length,
        levels: record.levels,
        start: record.start,
        end: record.end,
        batchId: record.batchId
      }
    });

    return res.status(201).json(saved || record);
  } catch (err) {
    return serverError(res, err, 'credential grant failed');
  }
};

/** Live grants for one party or over one project. One of the two is required. */
exports.listCredentials = async (req, res) => {
  try {
    const { party, projectId } = req.query || {};
    if (!party && !projectId) {
      return res.status(400).json({ error: 'Query party or projectId is required' });
    }

    const items = party
      ? await credentials.listForParty(party)
      : await credentials.listForProject(projectId);

    return res.json(items);
  } catch (err) {
    return serverError(res, err, 'credential list failed');
  }
};

exports.revokeCredentials = async (req, res) => {
  try {
    const body = req.body || {};
    const named = SELECTORS.filter(s => body[s]);
    if (named.length !== 1) {
      return res.status(400).json({ error: `Name exactly one of ${SELECTORS.join(', ')}` });
    }

    const selector = named[0];
    const revoked = await credentials.revokeBy({ [selector]: body[selector] });

    // One row per credential: a revoke is what ends someone's access, so it is recorded per party
    // rather than as a count.
    for (const row of revoked) {
      forgetCachedParty(row.party.id);
      auditEvent(req, {
        action: 'credential.revoke',
        targetType: 'credential',
        targetId: row.id,
        detail: {
          party: row.party,
          levels: row.levels,
          batchId: row.batchId,
          cause: body.cause || `revoked by ${selector}`
        }
      });
    }

    // Plus one summary row when the caller named a SET, so the batch is one line in the trail
    // instead of something a reader has to reconstruct by counting.
    if (selector !== 'id') {
      auditEvent(req, {
        action: 'credential.revoke',
        targetType: 'credential-batch',
        targetId: String(body[selector]),
        detail: { by: selector, revoked: revoked.length, cause: body.cause || '' }
      });
    }

    logger.info(`[demi-api] ${revoked.length} credential(s) revoked by ${selector}`);
    return res.json({ revoked: revoked.length, ids: revoked.map(r => r.id) });
  } catch (err) {
    return serverError(res, err, 'credential revoke failed');
  }
};
