'use strict';

/**
 * Per-user data — saved map lassos and interface preferences. There is no account entity: the
 * Keycloak token IS the account, so the partition key is always taken from the verified token and
 * a client-supplied `userId` is never read. Reads are unaudited; every write leaves an audit row.
 */

const userdata = require('../../repositories/userdata');
const { logger } = require('../../utils/logger');
const { serverError } = require('../../helpers/response');
const { auditEvent } = require('../../utils/audit');

const MAX_NAME_LENGTH = 80;
const MAX_LASSOS = 50;
const MIN_RING_POINTS = 3;
const MAX_RING_POINTS = 500;
const MAX_BODY_BYTES = 64 * 1024;
const SLUG = /^[a-z0-9-]{1,80}$/;

const PER_PAGE_OPTIONS = [6, 12, 24];
/** The SCREENS keys in frontend/src/app/shell/screens.ts, plus the `/developers` path that one
 * of them routes to — a landing preference is only ever one of these. */
const LANDING_SCREENS = [
  'map', 'index', 'content', 'summary', 'notify', 'links', 'rbac', 'developers', 'api', 'keys',
  'profile', 'sessions'
];
const DEFAULT_PREFS = { landing: 'map', perPage: 6 };

/** The owner, and the partition key. Lowercased so `createdBy` casing cannot split one user's rows. */
function owner(req) {
  return ((req.user && req.user.preferred_username) || '').toLowerCase();
}

function tooLarge(body) {
  return Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES;
}

function unknownKeys(body, allowed) {
  return Object.keys(body).filter((key) => !allowed.includes(key));
}

/** GeoJSON order, `[longitude, latitude]` — same as everything else stored here. */
function ringError(ring) {
  if (!Array.isArray(ring) || ring.length < MIN_RING_POINTS || ring.length > MAX_RING_POINTS) {
    return `ring must be an array of ${MIN_RING_POINTS}-${MAX_RING_POINTS} [longitude, latitude] pairs`;
  }
  for (const point of ring) {
    if (!Array.isArray(point) || point.length !== 2) return 'ring points must be [longitude, latitude] pairs';
    const [lng, lat] = point;
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) {
      return 'ring coordinates must be finite, longitude -180..180 and latitude -90..90';
    }
  }
  return null;
}

function presentLasso(record) {
  return {
    slug: record.slug,
    name: record.name,
    ring: record.ring,
    updatedAt: record.updatedAt
  };
}

exports.getMyData = async (req, res) => {
  try {
    const rows = await userdata.listAll(owner(req));
    const prefs = rows.find((row) => row.type === 'prefs');
    return res.json({
      prefs: prefs ? { landing: prefs.landing, perPage: prefs.perPage } : { ...DEFAULT_PREFS },
      lassos: rows.filter((row) => row.type === 'lasso').map(presentLasso)
    });
  } catch (err) {
    return serverError(res, err, 'user data read failed');
  }
};

exports.saveLasso = async (req, res) => {
  try {
    const me = owner(req);
    const body = req.body || {};
    if (tooLarge(body)) {
      return res.status(400).json({ error: `body must be at most ${MAX_BODY_BYTES} bytes` });
    }
    const unknown = unknownKeys(body, ['name', 'ring']);
    if (unknown.length > 0) {
      return res.status(400).json({ error: `unknown field(s): ${unknown.join(', ')}` });
    }

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length < 1 || name.length > MAX_NAME_LENGTH) {
      return res.status(400).json({ error: `name must be 1-${MAX_NAME_LENGTH} characters` });
    }
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!SLUG.test(slug)) {
      return res.status(400).json({ error: 'name must contain at least one letter or digit' });
    }
    const badRing = ringError(body.ring);
    if (badRing) {
      return res.status(400).json({ error: badRing });
    }

    const id = `lasso:${slug}`;
    const existing = await userdata.getItem(me, id);
    // Counted only when the id is new, so re-saving an existing area is never refused at the cap.
    if (!existing && await userdata.countByType(me, 'lasso') >= MAX_LASSOS) {
      return res.status(400).json({ error: `at most ${MAX_LASSOS} saved areas per user` });
    }

    const now = new Date().toISOString();
    const saved = await userdata.put(me, {
      id,
      type: 'lasso',
      slug,
      name,
      ring: body.ring,
      createdAt: (existing && existing.createdAt) || now,
      updatedAt: now
    });

    logger.info(`[demi-api] saved area ${slug} stored for ${me}`);
    auditEvent(req, {
      action: 'userdata.lasso.save',
      targetType: 'userdata',
      targetId: id,
      // Vertex count, never the ring: an audit row must not become a copy of the user's data.
      detail: { slug, vertices: body.ring.length, replaced: Boolean(existing) }
    });

    return res.json(presentLasso(saved));
  } catch (err) {
    return serverError(res, err, 'saved area write failed');
  }
};

exports.deleteLasso = async (req, res) => {
  try {
    const me = owner(req);
    const slug = String(req.params.slug).toLowerCase();
    if (!SLUG.test(slug)) {
      return res.status(404).json({ error: 'Saved area not found' });
    }

    const id = `lasso:${slug}`;
    if (!await userdata.remove(me, id)) {
      return res.status(404).json({ error: 'Saved area not found' });
    }

    logger.info(`[demi-api] saved area ${slug} deleted for ${me}`);
    auditEvent(req, {
      action: 'userdata.lasso.delete',
      targetType: 'userdata',
      targetId: id,
      detail: { slug }
    });

    return res.json({ message: 'Saved area deleted' });
  } catch (err) {
    return serverError(res, err, 'saved area delete failed');
  }
};

exports.putPrefs = async (req, res) => {
  try {
    const me = owner(req);
    const body = req.body || {};
    if (tooLarge(body)) {
      return res.status(400).json({ error: `body must be at most ${MAX_BODY_BYTES} bytes` });
    }
    const unknown = unknownKeys(body, ['landing', 'perPage']);
    if (unknown.length > 0) {
      return res.status(400).json({ error: `unknown field(s): ${unknown.join(', ')}` });
    }
    if (!LANDING_SCREENS.includes(body.landing)) {
      return res.status(400).json({ error: `landing must be one of: ${LANDING_SCREENS.join(', ')}` });
    }
    if (!PER_PAGE_OPTIONS.includes(body.perPage)) {
      return res.status(400).json({ error: `perPage must be one of: ${PER_PAGE_OPTIONS.join(', ')}` });
    }

    const prefs = { landing: body.landing, perPage: body.perPage };
    await userdata.put(me, { id: 'prefs', type: 'prefs', ...prefs, updatedAt: new Date().toISOString() });

    logger.info(`[demi-api] preferences stored for ${me}`);
    auditEvent(req, {
      action: 'userdata.prefs.update',
      targetType: 'userdata',
      targetId: 'prefs',
      detail: prefs
    });

    return res.json(prefs);
  } catch (err) {
    return serverError(res, err, 'preferences write failed');
  }
};
