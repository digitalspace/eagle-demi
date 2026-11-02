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
const commentPeriods = require('./comment-periods');
const commentPeriodRows = require('../../repositories/comment-periods');

const PROJECTS = { spec: projectsKind, label: 'name', fields: ['id', 'eagleId', 'name'] };
const NOTIFICATIONS = { spec: notifications.SPEC, label: 'name', fields: ['id', 'name', 'associatedProjectId'] };

const KINDS = Object.freeze({
  projects: PROJECTS,
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
  notifications: NOTIFICATIONS,
  'comment-periods': {
    spec: commentPeriods.SPEC,
    // q also matches the parent project name, so the repository applies it, as on the native list.
    repositoryFor: (q) => {
      const keywords = commentPeriodRows.keywordsOf(q);
      return keywords ? commentPeriodRows.nativeRepository({ keywords }) : null;
    },
    label: 'informationLabel',
    // parentJoin fills it from projectId; a period matched on its project name may have no label.
    fallback: 'projectName',
    fields: ['id', 'informationLabel', 'projectId', 'projectEagleId', 'projectName']
  },
  // The GET /project-records list: each side read in its own rank, then taken in turn.
  'project-records': {
    sides: {
      project: PROJECTS,
      notification: { ...NOTIFICATIONS, fields: ['id', 'eagleId', 'name'] }
    }
  }
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

/** True when a redacted row still holds `field`: not withheld, not blank. */
const hasLabel = (row, field) => Boolean(row) && row[field] !== undefined && row[field] !== null && row[field] !== '';

/** The suggestion fields a redacted row still holds. */
function slim(row, { fields }) {
  return Object.fromEntries(fields.filter(field => row[field] !== undefined).map(field => [field, row[field]]));
}

/** One kind's suggestions for `{ q, limit }`: `{ items }`, or `{ error }` for a 400. */
async function suggestKind(kind, { q, limit }, access) {
  const repository = kind.repositoryFor && kind.repositoryFor(q);
  if (repository === null) return { error: 'q needs more than quotes' };
  const spec = repository ? { ...kind.spec, repository } : kind.spec;
  const page = limit * ID_PAGE_FACTOR;
  const listQuery = repository ? { pageSize: String(page) } : { q, pageSize: String(page) };
  const parsed = parseNativeQuery(spec, listQuery, access);
  if (parsed.error) return { error: parsed.error };

  const { criteria, orderBy } = nativeCriteria(spec, parsed, access);
  const rows = await spec.repository.list(access, {
    criteria, orderBy, pageNum: 0, pageSize: page, parsed: { ...parsed, idPage: page }
  });

  // Cut to limit before the join so it looks up parents for the rows answered, not the whole page.
  let kept = redactAllForAccess(spec.entity, rows, access)
    .filter(row => hasLabel(row, kind.label) || (kind.fallback && hasLabel(row, 'projectId')))
    .slice(0, limit);
  if (spec.parentJoin) kept = await spec.parentJoin(access, kept);
  if (kind.fallback) kept = kept.filter(row => hasLabel(row, kind.label) || hasLabel(row, kind.fallback));
  return { items: kept.map(row => slim(row, kind)) };
}

/** First of each list, then second of each, and so on, up to `limit`; a short list lets the rest fill. */
function takeInTurn(lists, limit) {
  const taken = [];
  for (let i = 0; taken.length < limit && lists.some(list => i < list.length); i++) {
    for (const list of lists) if (i < list.length && taken.length < limit) taken.push(list[i]);
  }
  return taken;
}

/** Each side in its own rank, taken in turn, each item tagged with its side's record kind. */
async function suggestSides(kind, asked, access) {
  const sides = Object.entries(kind.sides);
  const answers = await Promise.all(sides.map(([, side]) => suggestKind(side, asked, access)));
  const refused = answers.find(answer => answer.error);
  if (refused) return refused;
  const tagged = answers.map(({ items }, i) => items.map(item => ({ ...item, recordKind: sides[i][0] })));
  return { items: takeInTurn(tagged, asked.limit) };
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
    const answer = await (kind.sides ? suggestSides : suggestKind)(kind, asked, access);
    if (answer.error) return res.status(400).json({ error: answer.error });

    if (isAnonymous(access)) res.setHeader('Cache-Control', `public, max-age=${MAX_AGE}`);
    return res.json({ items: answer.items });
  } catch (err) {
    const searchFailed = searchServiceError(res, err, 'suggest');
    if (searchFailed) return searchFailed;
    if (err && err.status === 400) return res.status(400).json({ error: err.message });
    return serverError(res, err, 'suggest failed');
  }
};
