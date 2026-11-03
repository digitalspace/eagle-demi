'use strict';

/**
 * `GET /project-records`: projects and project notifications in one paged list, each row marked
 * with `recordKind`. Each side is parsed, read and redacted on its own kind spec, then merged.
 */

const { resolveAccess } = require('../../helpers/access-sql');
const { assertKindSpec, parseNativeQuery, nativeCriteria } = require('../../helpers/native-query');
const { PROJECT_TYPE_SPELLINGS } = require('../../helpers/spellings');
const { redactForAccess } = require('../../vis/redact');
const { analyticsEvent } = require('../../utils/audit');
const { logger } = require('../../utils/logger');
const { ID_PAGE } = require('../../search/native-index');
const { NO_STORE, listFailure } = require('../nosql/mirror-reads');
const { projectsKind, pcpStatuses, pcpRepository } = require('../nosql/project');
const notifications = require('./notifications');

const RECORD_KINDS = Object.freeze(['project', 'notification']);

const NOTIFICATIONS_KIND = Object.freeze({
  ...notifications.SPEC,
  filters: [...notifications.SPEC.filters, 'proponent', 'subType'],
  multiValueFilters: [...notifications.SPEC.multiValueFilters, 'pcp', 'proponent', 'subType'],
  valueAliases: { type: PROJECT_TYPE_SPELLINGS },
  contains: { nameContains: 'name' }
});
assertKindSpec(NOTIFICATIONS_KIND);

/** Union query name -> notification query name, for every parameter both sides take. */
const NOTIFICATION_PARAMS = Object.freeze({
  q: 'q', nameContains: 'nameContains', projectType: 'type', region: 'region', proponentName: 'proponent',
  sector: 'subType', pcp: 'pcp', decision: 'decision'
});

/** Project fields the notification side also matches; a filter on any other project field drops notifications. */
const SHARED_PROJECT_FIELDS = Object.freeze(['projectType', 'region', 'proponentName', 'sector']);

/** Notification row field -> the project field name it is answered under. */
const NOTIFICATION_SHAPE = Object.freeze({
  id: 'id', eagleId: 'eagleId', name: 'name', type: 'projectType', subType: 'sector', proponent: 'proponentName',
  region: 'region', decision: 'decision', pcp: 'pcp', notificationReceivedDate: 'notificationReceivedDate'
});

// More notifications than this means the unpaged read has outgrown the container it was sized for.
const NOTIFICATIONS_WARN_ROWS = 500;
let warnedOversize = false;

/** Whether the projects parse holds any filter, range or text match the notification side cannot take. */
function projectOnly(parsed) {
  return Object.keys(parsed.filters).some(field => !SHARED_PROJECT_FIELDS.includes(field)) ||
    Object.keys(parsed.anyOf).length > 0 || parsed.ranges.length > 0 ||
    Object.keys(parsed.contains).some(field => field !== 'name') ||
    Object.keys(parsed.presence).length > 0 || Object.keys(parsed.flags).length > 0;
}

/** Cosmos orders null before every string. */
function compareNames(a, b) {
  if (a == null || b == null) return (a == null ? 0 : 1) - (b == null ? 0 : 1);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Stable two-way merge on name; each side keeps its own order, so the first `n` merged rows come from
 * the first `n` of each side. On a tie the project goes first.
 */
function mergeByName(projectRows, notificationRows, desc) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < projectRows.length && j < notificationRows.length) {
    const order = compareNames(projectRows[i].name, notificationRows[j].name);
    out.push((desc ? order >= 0 : order <= 0) ? projectRows[i++] : notificationRows[j++]);
  }
  return out.concat(projectRows.slice(i), notificationRows.slice(j));
}

function shapeNotification(row) {
  const out = { recordKind: 'notification' };
  for (const [from, to] of Object.entries(NOTIFICATION_SHAPE)) {
    if (Object.hasOwn(row, from)) out[to] = row[from];
  }
  return out;
}

/** The projects side: the first `fetch` rows in list order, and the count when asked. */
async function readProjects(access, query, parsed, fetch) {
  let repository = projectsKind.repository;
  if (query.pcp !== undefined) repository = await pcpRepository(access, pcpStatuses(query.pcp).statuses);
  const { criteria, orderBy } = nativeCriteria(projectsKind, parsed, access);
  const [rows, total] = await Promise.all([
    repository.list(access, { criteria, orderBy, pageNum: 0, pageSize: fetch, fetch, parsed }),
    parsed.count ? repository.count(access, { criteria, parsed }) : undefined
  ]);
  return { rows, total };
}

/** The notifications side, whole: about 17 rows, or at most one ranked id page with `q`. */
async function readNotifications(access, parsed) {
  const { criteria, orderBy } = nativeCriteria(NOTIFICATIONS_KIND, parsed, access);
  const repository = NOTIFICATIONS_KIND.repository;
  const rows = parsed.q
    ? await repository.list(access, { criteria, orderBy, pageNum: 0, pageSize: ID_PAGE, parsed })
    : await repository.readAll(access, { criteria, orderBy });
  if (rows.length > NOTIFICATIONS_WARN_ROWS && !warnedOversize) {
    warnedOversize = true;
    logger.warn('[project-records] notification side read more rows than it was sized for', { rows: rows.length });
  }
  return rows;
}

/** The union query as one query per side, or `{ error }`; `null` for a side that does not run. */
function splitQuery(query, access) {
  const { recordKind, decision, pcp, ...rest } = query;
  if (rest.ids !== undefined) return { error: 'unknown parameter: ids' };

  const kinds = recordKind === undefined ? RECORD_KINDS : [...new Set([].concat(recordKind))];
  if (kinds.some(kind => !RECORD_KINDS.includes(kind))) return { error: `recordKind takes ${RECORD_KINDS.join(', ')}` };
  if (pcp !== undefined) {
    const { error } = pcpStatuses(pcp);
    if (error) return { error };
  }

  const project = parseNativeQuery(projectsKind, { ...rest, sort: rest.sort === undefined ? 'name' : rest.sort }, access);
  if (project.error) return project;

  let notification = null;
  if (kinds.includes('notification') && !projectOnly(project)) {
    const sort = project.sort.field === 'name' && project.sort.desc ? '-name' : 'name';
    const mapped = { sort };
    for (const [name, to] of Object.entries(NOTIFICATION_PARAMS)) {
      if (query[name] !== undefined) mapped[to] = query[name];
    }
    notification = parseNativeQuery(NOTIFICATIONS_KIND, mapped, access);
    if (notification.error) return notification;
  } else if (decision !== undefined) {
    const checked = parseNativeQuery(NOTIFICATIONS_KIND, { decision }, access);
    if (checked.error) return checked;
  }
  const runProjects = kinds.includes('project') && decision === undefined;
  return { project, runProjects, notification };
}

exports.getProjectRecords = async (req, res) => {
  try {
    const access = resolveAccess(req);
    if (access.authenticated) res.setHeader('cache-control', NO_STORE);
    const query = req.query || {};

    const split = splitQuery(query, access);
    if (split.error) return res.status(400).json({ error: split.error });
    const { project: parsed, runProjects, notification } = split;

    const start = parsed.pageNum * parsed.pageSize;
    const end = start + parsed.pageSize;
    const [projectSide, notificationRows] = await Promise.all([
      runProjects ? readProjects(access, query, parsed, end) : { rows: [], total: 0 },
      notification ? readNotifications(access, notification) : []
    ]);

    // Merged on stored names, the order Cosmos sorted each side by; redaction may drop a name.
    const projects = projectSide.rows.map(row => ({ name: row.name, row, entity: 'projects' }));
    const notices = notificationRows.map(row => ({ name: row.name, row, entity: 'notifications' }));
    const merged = parsed.sort.field === 'name'
      ? mergeByName(projects, notices, parsed.sort.desc)
      : [...projects, ...notices];
    const body = merged.slice(start, end).map(({ row, entity }) => {
      const out = redactForAccess(entity, row, access);
      return entity === 'projects' ? { ...out, recordKind: 'project' } : shapeNotification(out);
    });
    // The pin labels the project list gives its rows.
    await projectsKind.parentJoin(access, body.filter(row => row.recordKind === 'project'));

    const total = parsed.count ? (projectSide.total || 0) + notificationRows.length : undefined;
    if (total !== undefined) res.setHeader('x-total-count', String(total));

    if (parsed.q) {
      analyticsEvent(req, {
        eventName: 'search',
        searchTerm: parsed.q,
        resultCount: total,
        detail: { kind: 'project-records', pageSize: parsed.pageSize }
      });
    }
    return res.json(body);
  } catch (err) {
    return listFailure(res, err, 'project-records list');
  }
};
