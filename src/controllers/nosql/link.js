'use strict';

/**
 * Short links — `/s/<code>` to a destination URL. resolveLink is the only uncredentialed handler;
 * deletion is hard, so auditEvent rows are the only record that a link ever existed.
 */

const links = require('../../repositories/links');
const projects = require('../../repositories/projects');
const { validateDestination } = require('../../helpers/link-url');
const { resolveAccess } = require('../../helpers/access-sql');
const {
  CUSTOM_CODE, generateCode, shortUrlFor, isConflict, isPreconditionFailed
} = require('../../helpers/short-links');
const { logger } = require('../../utils/logger');
const { serverError } = require('../../helpers/response');
const { auditEvent } = require('../../utils/audit');
const config = require('../../config');

const MAX_NOTE_LENGTH = 200;
/** Project codes are printed, current and legacy alike, so this route never moves or drops one. */
const PROJECT_CODE_ERROR = 'This code belongs to a project. Edit it on the project instead.';
const RACED_ERROR = 'This short link changed while saving. Reload and try again.';

/**
 * A 409 when any project holds `code`, else null. Ownership is judged on every project; the
 * `projectId` that lets the admin UI send the edit to the project route names the best holder
 * (`links.ownerRank`) the caller may read, so never a hidden one.
 */
async function projectCodeConflict(req, res, code) {
  const owners = await projects.listShortCodeOwners(code);
  if (!owners.length) return null;
  const access = resolveAccess(req);
  const [owner] = (await Promise.all(owners.map(id => projects.getById(access, id))))
    .filter(Boolean)
    .sort((a, b) => links.ownerRank(a, code) - links.ownerRank(b, code));
  return res.status(409).json(owner ? { error: PROJECT_CODE_ERROR, projectId: String(owner.id) } : { error: PROJECT_CODE_ERROR });
}

/** A write guarded on the record's etag lost: a project may have adopted the code since the read. */
async function racedConflict(req, res, code) {
  return (await projectCodeConflict(req, res, code)) || res.status(409).json({ error: RACED_ERROR });
}

/**
 * Fixed at module load, never composed per request: helmet runs with `contentSecurityPolicy:
 * false`, so echoing `req.params.code` here would be reflected XSS on a gov.bc.ca origin.
 */
const NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link not found</title></head>
<body>
<h1>Link not found</h1>
<p>This short link does not exist, or it has been removed.</p>
<p><a href="${config.linkBaseUrl}">Go to the EPIC website</a></p>
</body>
</html>
`;

/** The wire shape. Cosmos internals and anything added to the row later stay out of it. */
function present(record) {
  return {
    id: record.id,
    url: record.url,
    note: record.note ?? null,
    shortUrl: shortUrlFor(record.id),
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    updatedAt: record.updatedAt ?? null,
    // Absent on every row minted before the flag, and those are shared.
    personal: record.personal === true
  };
}

exports.listLinks = async (req, res) => {
  try {
    // Personal links are hidden from everyone but their creator — the `/s/:code` redirect stays
    // public, so this narrows the list, not access.
    const [rows, held] = await Promise.all([
      links.list((req.user && req.user.preferred_username) || ''),
      links.listProjectCodes(resolveAccess(req)).catch((err) => {
        logger.warn('[demi-api] project code lookup failed, links listed untagged',
          { error: err.message, stack: err.stack });
        return new Map();
      })
    ]);
    // A project's code is edited on the project, so its row says which one and in what role, when
    // the caller may read that project.
    return res.json(rows.map(row => ({ ...present(row), ...held.get(row.id) })));
  } catch (err) {
    return serverError(res, err, 'short link list failed');
  }
};

exports.createLink = async (req, res) => {
  try {
    const { url, note, code, personal } = req.body || {};

    const destination = validateDestination(url, config.linkAllowedHosts);
    if (!destination.ok) {
      return res.status(400).json({ error: destination.reason });
    }
    if (note !== undefined && note !== null &&
        (typeof note !== 'string' || note.length > MAX_NOTE_LENGTH)) {
      return res.status(400).json({ error: `note must be a string of at most ${MAX_NOTE_LENGTH} characters` });
    }
    const custom = code !== undefined && code !== null && code !== '';
    const customCode = custom ? String(code).toLowerCase() : null;
    if (custom && !CUSTOM_CODE.test(customCode)) {
      return res.status(400).json({ error: 'code must be 3-64 characters of a-z 0-9 _ - (case-insensitive)' });
    }
    if (personal !== undefined && personal !== null && typeof personal !== 'boolean') {
      return res.status(400).json({ error: 'personal must be a boolean' });
    }
    const held = custom ? await projectCodeConflict(req, res, customCode) : null;
    if (held) return held;

    const record = {
      id: custom ? customCode : generateCode(),
      url: destination.url,
      note: note || null,
      personal: personal === true,
      createdAt: new Date().toISOString(),
      createdBy: (req.user && req.user.preferred_username) || 'unknown',
      updatedAt: null
    };

    try {
      await links.create(record);
    } catch (err) {
      if (!isConflict(err)) throw err;
      // Uniqueness comes from Cosmos rejecting a duplicate id, not from a read-then-write. A
      // generated code that collides is retried once; a custom one is the caller's to change.
      if (custom) return res.status(409).json({ error: 'Code already in use' });
      record.id = generateCode();
      await links.create(record);
    }

    logger.info(`[demi-api] short link ${record.id} created by ${record.createdBy}`);
    auditEvent(req, {
      action: 'link.create',
      targetType: 'link',
      targetId: record.id,
      detail: { url: record.url, note: record.note, custom, personal: record.personal }
    });

    return res.status(201).json({ code: record.id, shortUrl: shortUrlFor(record.id), url: record.url });
  } catch (err) {
    return serverError(res, err, 'short link create failed');
  }
};

exports.updateLink = async (req, res) => {
  try {
    const code = String(req.params.code).toLowerCase();
    if (!CUSTOM_CODE.test(code)) {
      return res.status(404).json({ error: 'Short link not found' });
    }
    const held = await projectCodeConflict(req, res, code);
    if (held) return held;
    const destination = validateDestination((req.body || {}).url, config.linkAllowedHosts);
    if (!destination.ok) {
      return res.status(400).json({ error: destination.reason });
    }

    // Read first for the old url: the audit row is what makes a repoint reconstructable, and
    // `patch` hands back only the new state.
    const before = await links.getById(code);
    let updated = null;
    try {
      updated = before ? await links.repoint(code, destination.url, { etag: before._etag }) : null;
    } catch (err) {
      if (!isPreconditionFailed(err)) throw err;
      return racedConflict(req, res, code);
    }
    if (!updated) {
      return res.status(404).json({ error: 'Short link not found' });
    }

    logger.info(`[demi-api] short link ${code} repointed by ${(req.user && req.user.preferred_username) || 'unknown'}`);
    auditEvent(req, {
      action: 'link.update',
      targetType: 'link',
      targetId: code,
      detail: { from: before.url, to: destination.url, personal: before.personal === true }
    });

    return res.json(present(updated));
  } catch (err) {
    return serverError(res, err, 'short link update failed');
  }
};

exports.deleteLink = async (req, res) => {
  try {
    const code = String(req.params.code).toLowerCase();
    if (!CUSTOM_CODE.test(code)) {
      return res.status(404).json({ error: 'Short link not found' });
    }

    const held = await projectCodeConflict(req, res, code);
    if (held) return held;
    const existing = await links.getById(code);
    let removed = false;
    try {
      removed = existing ? await links.remove(code, { etag: existing._etag }) : false;
    } catch (err) {
      if (!isPreconditionFailed(err)) throw err;
      return racedConflict(req, res, code);
    }
    if (!removed) {
      return res.status(404).json({ error: 'Short link not found' });
    }

    logger.info(`[demi-api] short link ${code} deleted by ${(req.user && req.user.preferred_username) || 'unknown'}`);
    auditEvent(req, {
      action: 'link.delete',
      targetType: 'link',
      targetId: code,
      detail: { url: existing.url, note: existing.note ?? null, personal: existing.personal === true }
    });

    return res.json({ message: 'Short link deleted' });
  } catch (err) {
    return serverError(res, err, 'short link delete failed');
  }
};

/**
 * The public redirect. 302 and `no-store`, never 301 — a cached permanent redirect on a printed
 * poster can never be corrected.
 */
exports.resolveLink = async (req, res) => {
  const code = String(req.params.code).toLowerCase();
  try {
    const record = CUSTOM_CODE.test(code) ? await links.getById(code) : null;
    logger.info(`[demi-api] short link ${code} hit=${Boolean(record)}`);

    if (!record) {
      return res.set('Cache-Control', 'no-store').status(404).type('html').send(NOT_FOUND_HTML);
    }
    return res.set('Cache-Control', 'no-store').redirect(302, record.url);
  } catch (err) {
    return serverError(res, err, 'short link resolve failed');
  }
};

