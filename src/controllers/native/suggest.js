'use strict';

// `GET /suggest`: a kind's own list read, redaction included, cut to a few fields per row.

const { resolveAccess, isAnonymous } = require('../../helpers/access-sql');
const { parseNativeQuery, nativeCriteria } = require('../../helpers/native-query');
const { redactAllForAccess } = require('../../vis/redact');
const { serverError, searchServiceError } = require('../../helpers/response');
const { NO_STORE } = require('../nosql/mirror-reads');
const { projectsKind } = require('../nosql/project');
const { documentsKind } = require('../nosql/document');
const updates = require('./updates');
const notifications = require('./notifications');

const KINDS = Object.freeze({
  projects: { spec: projectsKind, label: 'name', fields: ['id', 'eagleId', 'name'] },
  documents: {
    spec: documentsKind,
    label: 'displayName',
    fields: ['id', 'displayName', 'projectId', 'projectEagleId', 'projectName']
  },
  updates: {
    spec: updates.SPEC,
    label: 'headline',
    fields: ['id', 'headline', 'projectId', 'projectEagleId', 'projectName', 'notificationName']
  },
  notifications: { spec: notifications.SPEC, label: 'name', fields: ['id', 'name', 'associatedProjectId'] }
});

const PARAMS = ['kind', 'q', 'limit'];
const DEFAULT_LIMIT = 8;
// Plain digits only, so one answer has one cache key (no `08`, `+3` or `1e0`).
const LIMIT_PATTERN = /^[1-8]$/;
const Q_MIN = 2;
const Q_MAX = 100;
// Rows read per suggestion: room for rows the dials or redaction drop, without the list's full
// id page. Anonymous reads stay far under their page cap (8 * 3 of 100).
const ID_PAGE_FACTOR = 3;
const MAX_AGE = 60;

/** `{ kind, q, limit }` from the query, or `{ error }`. */
function parseSuggestQuery(query) {
  for (const [key, value] of Object.entries(query || {})) {
    if (!PARAMS.includes(key)) return { error: `unknown parameter: ${key}` };
    if (typeof value !== 'string') return { error: `parameter given more than once: ${key}` };
  }
  const { kind, q: rawQ, limit: rawLimit } = query || {};

  if (kind === 'comment-periods') return { error: 'q is not supported on this list' };
  if (!Object.hasOwn(KINDS, kind)) return { error: `kind must be one of ${Object.keys(KINDS).join(', ')}` };

  const q = (rawQ || '').trim().normalize('NFC');
  const length = [...q].length;
  if (length < Q_MIN || length > Q_MAX) return { error: `q takes ${Q_MIN} to ${Q_MAX} characters` };

  if (rawLimit !== undefined && !LIMIT_PATTERN.test(rawLimit)) {
    return { error: 'limit must be a whole number from 1 to 8' };
  }
  const limit = rawLimit === undefined ? DEFAULT_LIMIT : Number(rawLimit);
  return { kind, q, limit };
}

/** True when a redacted row still holds its label: not withheld, not blank. */
const hasLabel = (row, { label }) => Boolean(row) && row[label] !== undefined && row[label] !== null && row[label] !== '';

/** The suggestion fields a redacted row still holds. */
function slim(row, { fields }) {
  return Object.fromEntries(fields.filter(field => row[field] !== undefined).map(field => [field, row[field]]));
}

exports.getSuggestions = async (req, res) => {
  // applyCors set `Vary: Origin` and this replaces it, so Origin is named again.
  res.setHeader('Vary', 'Origin, Authorization, X-Api-Key');
  res.setHeader('Cache-Control', NO_STORE);
  try {
    const access = resolveAccess(req);
    const asked = parseSuggestQuery(req.query);
    if (asked.error) return res.status(400).json({ error: asked.error });

    const kind = KINDS[asked.kind];
    const { spec } = kind;
    const page = asked.limit * ID_PAGE_FACTOR;
    const parsed = parseNativeQuery(spec, { q: asked.q, pageSize: String(page) }, access);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const { criteria, orderBy } = nativeCriteria(spec, parsed, access);
    const rows = await spec.repository.list(access, {
      criteria, orderBy, pageNum: 0, pageSize: page, parsed: { ...parsed, idPage: page }
    });

    // Cut to limit before the join so it looks up parents for the rows answered, not the whole page.
    let kept = redactAllForAccess(spec.entity, rows, access).filter(row => hasLabel(row, kind)).slice(0, asked.limit);
    if (spec.parentJoin) kept = await spec.parentJoin(access, kept);
    const items = kept.map(row => slim(row, kind));

    if (isAnonymous(access)) res.setHeader('Cache-Control', `public, max-age=${MAX_AGE}`);
    return res.json({ items });
  } catch (err) {
    const searchFailed = searchServiceError(res, err, 'suggest');
    if (searchFailed) return searchFailed;
    if (err && err.status === 400) return res.status(400).json({ error: err.message });
    return serverError(res, err, 'suggest failed');
  }
};
