'use strict';

/**
 * What `parity-eagle.js` replays: one entry per eagle-api read a consumer makes, the DEMI read that
 * answers it, and the differences already explained. Plan numbers are the read-by-read map in the
 * eagle-reads-in-DEMI plan; the map doubles as the consumer switch checklist.
 *
 * Path and query values `:project`, `:period`, `:document`, `:comment`, `:organization`,
 * `:inspection`, `:element`, `:group` are filled from `--id <name>=<eagleId>`. Field entries are
 * names both sides share or `[eagleName, demiName]`.
 *
 * `format: 'csv'` reads compare the header and then rows paired on the `key` column, every shared
 * column but `ignoreColumns`. `mapEagle` / `mapDemi` reshape one side's rows before pairing.
 */

const { EAGLE_STAFF_FIELDS, TRACK_PRECEDENCE } = require('../merge/project');
const commentMirror = require('../controllers/nosql/comment');
const commentPeriodMirror = require('../controllers/nosql/comment-period');
const organizationMirror = require('../controllers/nosql/organization');
const { LEVEL_TOKENS, levelOfRead } = require('../helpers/access-sql');

const STAFF = ['staff', 'sysadmin'];
const ANON = ['anonymous'];

/** Fields compared on every row of a dataset, for every identity. */
const FIELDS = {
  Project: ['name', 'type', 'sector', 'region', 'location'],
  Document: ['documentFileName', 'displayName', 'datePosted', 'documentSource'],
  CommentPeriod: ['dateStarted', 'dateCompleted', 'instructions'],
  Comment: ['commentId', 'comment', 'dateAdded', 'location', 'isAnonymous'],
  Organization: ['name', 'companyType', 'city', 'province'],
  ProjectNotification: ['name', 'type', 'subType'],
  RecentActivity: ['headline', 'dateAdded'],
  List: ['name', 'type', 'legislation'],
  Pin: ['name', 'province', 'website'],
  User: ['firstName', 'lastName', 'displayName', 'email'],
  Group: ['name'],
  Inspection: ['name', 'case', 'startDate'],
  InspectionElement: ['title', 'requirement']
};

/** Staff fields DEMI does not promote yet: a staff row lacking one in DEMI is class L3. */
const UNPROMOTED_STAFF_FIELDS = {
  Project: ['directoryStructure']
};

const promoted = staffFields => Object.keys(staffFields({}));

/** Staff-only fields: compared for staff and sysadmin only. The promoted ones are never excused. */
const STAFF_FIELDS = {
  Project: [...EAGLE_STAFF_FIELDS, ...UNPROMOTED_STAFF_FIELDS.Project],
  Comment: ['eaoStatus', ...promoted(commentMirror.staffFields)],
  // Eagle computes userCan per caller at read time; DEMI never stores it.
  CommentPeriod: promoted(commentPeriodMirror.staffFields).filter(f => f !== 'userCan'),
  Organization: promoted(organizationMirror.staffFields)
};

/** Fields Eagle strips for non-staff callers and DEMI shows: compared for anonymous only. */
const PUBLIC_FIELDS = {
  Project: ['review180Start', 'review45Start', 'reviewSuspensions', 'reviewExtensions'],
  Organization: ['city', 'province', 'postal']
};

/** Eagle fields the known-difference predicates read: requested from Eagle, never compared. */
const PREDICATE_FIELDS = {
  CommentPeriod: ['project'],
  Document: ['project']
};

/** Eagle project fields DEMI takes from Track when Track has a value (`TRACK_PRECEDENCE`). */
const TRACK_FIELDS = TRACK_PRECEDENCE.map(([, , eagleField]) => eagleField).filter(Boolean);
/** CSV columns DEMI fills from those fields, per read; Eagle writes its own raw project row. */
const TRACK_COLUMNS = {
  // `bcgwRow` in src/controllers/report.js, with the Track-first centroid.
  'report-bcgw': ['Project name', 'Proponent', 'Type', 'Description', 'Latitude', 'Longitude'],
  // Eagle's raw project.name is blank on legislation-keyed projects.
  'comment-export': ['Project']
};

/** Fields where `false` and absent mean the same: a schema default the push copied, or DEMI's '' for false. */
const DEFAULT_FALSE_FIELDS = {
  Project: ['substantially', 'hasMetCommentPeriods'],
  CommentPeriod: ['isVetted']
};

/** Per-field value forms that mean the same on both sides, mapped to one form before comparing. */
const EQUIVALENT_FORMS = {
  CommentPeriod: {
    // Older periods hold the flag as the string 'true' or 'false'.
    isVetted: v => (v === 'true' || v === 'false' ? v === 'true' : v),
    // An unused counter: Eagle leaves it null, DEMI counts from 0.
    commentIdCount: v => v ?? 0
  }
};

/** Fields with a documented DEMI gap still open, per dataset. */
const OPEN_GAPS = {
  Pin: ['website']
};

const EAGLE_ID = /^[0-9a-f]{24}$/i;

const STAFF_LEVEL = levelOfRead([LEVEL_TOKENS[2]]);
/** A child read staff reaches under a parent read staff does not: `capRead` keeps it from DEMI staff. */
const cappedFromStaff = (own, parent) => levelOfRead(own) >= STAFF_LEVEL && levelOfRead(parent) < STAFF_LEVEL;

/**
 * A value both APIs can be compared on: strings trimmed, an empty string, empty list or absent value
 * is null, a populated ref is its id, an ISO date is canonical.
 */
function norm(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.length ? value.map(norm) : null;
  if (typeof value === 'object') return '_id' in value ? String(value._id) : value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return null;
    return /^\d{4}-\d{2}-\d{2}T/.test(text) && !Number.isNaN(Date.parse(text)) ? new Date(text).toISOString() : text;
  }
  return value;
}
const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
/** `same`, after the field's `EQUIVALENT_FORMS` mapping when it has one. */
const sameField = (dataset, field, a, b) => {
  const form = (EQUIVALENT_FORMS[dataset] || {})[field] || (v => v);
  return same(form(a), form(b));
};
const filled = value => norm(value) !== null;

const readOf = (row) => (row && Array.isArray(row.read) ? row.read : null);
const eagleIdsIn = (value) => [...String(value || '').matchAll(/[0-9a-f]{24}/gi)].map(m => m[0].toLowerCase());
const sameIds = (a, b) => JSON.stringify(eagleIdsIn(a).sort()) === JSON.stringify(eagleIdsIn(b).sort());
const pathOf = (value) => {
  try {
    return new URL(value).pathname;
  } catch {
    return null;
  }
};

/**
 * Every class a difference may be explained by. `ids: true` classes match only ids listed under
 * their name in `--known-ids <file>`; the others match on the rows themselves.
 * kind: missingInDemi (Eagle row, no DEMI row), extraInDemi (DEMI row, no Eagle row), fieldDiff;
 * one kind or a list. A missing or extra row's `unpaired` holds the other side's unpaired rows.
 */
const KNOWN_DIFFERENCES = [
  { name: 'L2-never-mirrored', kind: 'missingInDemi', ids: true,
    why: 'Eagle row never reached DEMI; closed by backfill' },
  { name: 'L3-staff-field-not-promoted', kind: 'fieldDiff', identities: STAFF,
    why: 'staff field DEMI does not promote yet',
    match: ({ dataset, field, demiValue }) => (UNPROMOTED_STAFF_FIELDS[dataset] || []).includes(field) && norm(demiValue) === null },
  { name: 'L4-soft-deleted', kind: 'missingInDemi',
    why: 'Eagle isDeleted row; not ported',
    match: ({ eagle }) => eagle.isDeleted === true },
  { name: 'L5-demi-takedown', kind: 'missingInDemi', ids: true,
    why: 'DEMI took the row down (record.takedown audit entry)' },
  { name: 'demi-only', kind: 'extraInDemi',
    why: 'Track-only project or row created in DEMI: its id is not an Eagle ObjectId',
    match: ({ id, byEagleId }) => byEagleId && !EAGLE_ID.test(id) },
  { name: 'eagle-hard-deleted', kind: 'extraInDemi', ids: true,
    why: 'Eagle hard delete that sent no delete notice' },
  { name: 'seeded-from-prod', kind: 'extraInDemi', ids: true,
    why: 'row from the 2026-08-25 prod seed that the Eagle test database does not hold' },
  { name: 'ladder-above-public', kind: 'extraInDemi', identities: ['staff'], ids: true,
    why: "Eagle read[] (or its project's) has public, not staff: Eagle staff routes hide it, DEMI's ladder ranks staff above public" },
  { name: 'capped-under-parent', kind: 'missingInDemi', identities: ['staff'], ids: true,
    why: "Eagle row's own read[] admits staff, its project's does not: DEMI caps a child's read under its parent's" },
  { name: 'display-name-from-file-name', kind: 'fieldDiff',
    why: 'Eagle displayName is empty; the seed falls back to documentFileName (src/seed/transform.js)',
    match: ({ dataset, field, eagleValue, demiValue, eagle }) => dataset === 'Document' && field === 'displayName' &&
      norm(eagleValue) === null && filled(demiValue) && same(demiValue, eagle.documentFileName) },
  { name: 'schema-default-false', kind: 'fieldDiff',
    why: "false on one side, absent on the other: a schema default copied by the push, or DEMI's '' for false",
    match: ({ dataset, field, eagleValue, demiValue }) => (DEFAULT_FALSE_FIELDS[dataset] || []).includes(field) &&
      [eagleValue, demiValue].every(v => v === false || norm(v) === null) },
  { name: 'public-field-difference', kind: 'fieldDiff', identities: ANON,
    why: 'Eagle strips the field for non-staff; DEMI shows it',
    match: ({ dataset, field, eagleValue }) => (PUBLIC_FIELDS[dataset] || []).includes(field) && norm(eagleValue) === null },
  { name: 'eagle-ungated-featured', kind: 'missingInDemi', identities: ANON, reads: ['featured-public'],
    why: 'Eagle public FeaturedDocuments skips the read[] check; DEMI applies it',
    match: ({ eagle }) => !!readOf(eagle) && !readOf(eagle).includes('public') },
  { name: 'open-gap', kind: 'fieldDiff',
    why: 'documented DEMI gap, plan section 2',
    match: ({ dataset, field }) => (OPEN_GAPS[dataset] || []).includes(field) },
  { name: 'export-attachment-route', kind: 'fieldDiff', reads: ['comment-export'],
    why: 'Eagle links /api/document/:id/fetch on its host, DEMI /documents/:id/download on its own; same documents',
    match: ({ field, eagleValue, demiValue }) => field === 'Attachments' &&
      typeof eagleValue === 'string' && typeof demiValue === 'string' && sameIds(eagleValue, demiValue) },
  { name: 'bcgw-link-host', kind: 'fieldDiff', reads: ['report-bcgw'],
    why: 'Eagle writes the prod site host; DEMI writes LINK_BASE_URL, the site of its own environment',
    match: ({ field, eagleValue, demiValue }) => field === 'URL to Epic Project' &&
      pathOf(eagleValue) !== null && pathOf(eagleValue) === pathOf(demiValue) },
  { name: 'track-mastered', kind: 'fieldDiff',
    why: 'DEMI projects take these fields from Track when Track has a value (src/merge/project.js)',
    match: ({ read, dataset, field, demiValue, demi }) => filled(demiValue) &&
      ((dataset === 'Project' && TRACK_FIELDS.includes(field) && demi.trackProjectId != null) ||
        (TRACK_COLUMNS[read] || []).includes(field)) },
  { name: 'list-id-other-env', kind: ['missingInDemi', 'extraInDemi'],
    why: 'the same List row exists on the other side under another id: each environment seeded its own',
    match: ({ dataset, eagle, demi, unpaired }) => dataset === 'List' &&
      unpaired.some(other => ['name', 'type', 'legislation'].every(f => same(other[f], (eagle || demi)[f]))) },
  { name: 'orphan-parent-missing-in-eagle', label: 'orphan: parent missing in Eagle', kind: ['missingInDemi', 'extraInDemi'],
    why: 'the parent ref is empty, malformed, or names a row in neither Eagle, DEMI nor Track',
    match: ({ parentState }) => parentState === 'missing-in-eagle' },
  { name: 'parent-not-public', kind: 'missingInDemi', identities: ANON,
    why: "Eagle's public comment period routes skip the project read[] check; DEMI applies it",
    match: ({ dataset, eagle, eaglePublicProjects, parentState }) => parentState === 'not-public' ||
      (dataset === 'CommentPeriod' && !!eaglePublicProjects &&
        filled(eagle.project) && !eaglePublicProjects.has(norm(eagle.project))) }
];

/**
 * The class that explains one id-level or field-level difference, shared by parity-eagle and
 * reconcile-eagle.
 *
 * @param {object} ctx
 * @param {string} ctx.kind          missingInDemi, extraInDemi or fieldDiff
 * @param {string} ctx.id            the row's Eagle id (or DEMI id when it has none)
 * @param {string} [ctx.identity]    caller the read ran as; classes with `identities` need it
 * @param {string} [ctx.read]        PARITY_MAP read name; classes with `reads` need it
 * @param {string} [ctx.dataset]     Eagle _schemaName
 * @param {object} [ctx.eagle]       Eagle row; `ctx.demi` the DEMI row
 * @param {Array}  [ctx.unpaired]    the other side's unpaired rows (list-id-other-env)
 * @param {boolean} [ctx.byEagleId]  DEMI rows are keyed by Eagle id (demi-only)
 * @param {string} [ctx.field]       fieldDiff only, with ctx.eagleValue and ctx.demiValue
 * @param {Set}    [ctx.eaglePublicProjects] ids Eagle lists publicly
 * @param {Object<string, Set>} [ctx.knownIds] class name -> ids, for `ids: true` classes
 * @param {string|null} [ctx.parentState] in-demi, not-public, missing-in-eagle, missing-in-demi
 *   (parent resolves in Eagle or Track but DEMI holds no row; falls through to push-missed), or
 *   null for a row with no parent. Undefined (field-level parity) leaves an unmatched difference
 *   unexplained.
 * @returns {string|null} class name; null when unexplained
 */
function classify(ctx) {
  const knownIds = ctx.knownIds || {};
  const hit = KNOWN_DIFFERENCES.find(k => [].concat(k.kind).includes(ctx.kind) &&
    (!k.identities || k.identities.includes(ctx.identity)) &&
    (!k.reads || k.reads.includes(ctx.read)) &&
    (k.ids ? !!(knownIds[k.name] && knownIds[k.name].has(ctx.id)) : k.match(ctx)));
  if (hit) return hit.name;
  if (ctx.parentState === undefined) return null;
  // Only a missing child whose parent DEMI holds is worth a re-push: its first push likely beat the parent's.
  return ctx.kind === 'missingInDemi' && ctx.parentState === 'in-demi' ? 'push-missed-parent-in-demi' : 'push-missed';
}

const search = (dataset, query = {}) => ({ path: '/search', query: { dataset, ...query }, shape: 'search', paged: true });
const rows = (path, query, opts) => ({ path, query, shape: 'array', paged: false, ...opts });
const pagedRows = (path, query, opts) => ({ path, query, shape: 'array', paged: true, ...opts });
// eagle-api answers only _id and read[] unless `fields` names the rest.
const FIELDED = { fields: true };
// eagle-api answers these as a count facet, [{ total_items, results }].
const FACET = { facet: true };
const FIELDED_FACET = { ...FIELDED, ...FACET };
// A list: the route answers only these (ALLOWED_FIELDS in eagle-api's controller), so nothing else is compared.
const ORGANIZATION_ROUTE = { fields: ['code', 'description', 'name', 'companyType', 'parentCompany'] };
const COMMENT_PERIOD_ROUTE = { fields: ['_schemaName', 'addedBy', 'additionalText', 'ceaaAdditionalText',
  'ceaaInformationLabel', 'ceaaRelatedDocuments', 'classificationRoles', 'classifiedPercent', 'commenterRoles',
  'dateAdded', 'dateCompleted', 'dateCompletedEst', 'dateStarted', 'dateStartedEst', 'dateUpdated', 'downloadRoles',
  'informationLabel', 'instructions', 'commentTip', 'isClassified', 'isPublished', 'isResolved', 'isVetted', 'isMet',
  'metURL', 'metURLAdmin', 'metBannerImageUrl', 'milestone', 'openHouses', 'periodType', 'phase', 'phaseName',
  'project', 'publishedPercent', 'rangeOption', 'rangeType', 'relatedDocuments', 'resolvedPercent', 'updatedBy',
  'userCan', 'vettedPercent', 'vettingRoles', 'read', 'write', 'delete'] };
const one = (path, at, query) => ({ path, query, shape: 'object', at });
const csv = (path, query) => ({ path, query });
/** Id-only rows, for reads where one side answers a list of refs rather than the rows. */
const idRows = refs => refs.map(ref => ({ _id: String(ref && ref._id ? ref._id : ref) }));
const pending = (read, plan, reason) => ({ read, plan, pending: true, skip: reason });
// DEMI sets x-total-count on GET and HEAD of /search; this script sends GET only.
const HEAD_REASON = 'HEAD not sent by this script';

const PROJECT_ONE_FIELDS = ['name', 'sector', 'region', ['type', 'projectType'], ['location', 'address']];
const DOCUMENT_ONE_FIELDS = ['documentFileName', 'displayName', 'datePosted', 'documentSource', ['type', 'typeId']];

const REST_READS = [
  { read: 'project-list-public', plan: '1', identities: ANON, dataset: 'Project',
    eagle: pagedRows('/public/project', undefined, FIELDED), demi: search('Project') },
  { read: 'project-public', plan: '2', identities: ANON, dataset: 'Project', fields: PROJECT_ONE_FIELDS,
    eagle: rows('/public/project/:project', undefined, FIELDED), demi: one('/projects/:project') },
  pending('project-head-public', '3', HEAD_REASON),
  { read: 'project-list', plan: '4', identities: STAFF, dataset: 'Project',
    eagle: pagedRows('/project', undefined, FIELDED_FACET), demi: search('Project') },
  { read: 'project', plan: '5', identities: STAFF, dataset: 'Project', fields: PROJECT_ONE_FIELDS,
    eagle: rows('/project/:project', undefined, FIELDED), demi: one('/projects/:project') },
  pending('project-head', '6-7', HEAD_REASON),
  { read: 'pins-public', plan: '8', identities: ANON, dataset: 'Pin',
    eagle: pagedRows('/public/project/:project/pin', undefined, FACET), demi: one('/projects/:project', 'pins') },
  { read: 'pins', plan: '9', identities: STAFF, dataset: 'Pin',
    eagle: pagedRows('/project/:project/pin', undefined, FACET), demi: one('/projects/:project', 'pins') },
  // Eagle answers the member User rows in a count facet, DEMI the Group with member ids. DEMI's
  // `project` query is the Track id partition key, not an Eagle id, so the read sends none.
  { read: 'group-members', plan: '10', identities: STAFF, dataset: 'Group', fields: [],
    eagle: rows('/project/:project/group/:group/members', undefined, FACET),
    demi: one('/groups/:group'),
    mapEagle: idRows,
    mapDemi: groups => idRows(groups.flatMap(g => g.members || [])) },
  { read: 'featured-public', plan: '11', identities: ANON, dataset: 'Document',
    eagle: rows('/Public/project/:project/FeaturedDocuments'),
    demi: search('Document', { 'and[isFeatured]': 'true', project: ':project' }) },
  { read: 'featured', plan: '13', identities: STAFF, dataset: 'Document',
    eagle: rows('/project/:project/FeaturedDocuments'),
    demi: search('Document', { 'and[isFeatured]': 'true', project: ':project' }) },
  pending('featured-head', '12, 14', HEAD_REASON),
  { read: 'document-list-public', plan: '15', identities: ANON, dataset: 'Document',
    eagle: rows('/public/document', { project: ':project' }, FIELDED), demi: search('Document', { project: ':project' }) },
  { read: 'document-public', plan: '16', identities: ANON, dataset: 'Document', fields: DOCUMENT_ONE_FIELDS,
    eagle: rows('/public/document/:document', undefined, FIELDED), demi: one('/documents/:document') },
  { read: 'document-download-public', plan: '17-18',
    skip: 'never called: the public download route increments publicHitCount' },
  { read: 'document-list', plan: '19', identities: STAFF, dataset: 'Document',
    eagle: rows('/document', { isDeleted: 'false', project: ':project' }, FIELDED), demi: search('Document', { project: ':project' }) },
  { read: 'document', plan: '20', identities: STAFF, dataset: 'Document', fields: DOCUMENT_ONE_FIELDS,
    eagle: rows('/document/:document', undefined, FIELDED), demi: one('/documents/:document') },
  // Run by --download-sample over document ids paired by the reads above, not by --id.
  { read: 'document-download', plan: '21-23', identities: STAFF, download: true,
    eagle: { path: '/document/:document/download' }, demi: { path: '/documents/:document/download' } },
  { read: 'commentperiod-list-public', plan: '24', identities: ANON, dataset: 'CommentPeriod',
    eagle: rows('/public/commentperiod', { project: ':project' }, COMMENT_PERIOD_ROUTE),
    demi: search('CommentPeriod', { 'and[project]': ':project' }) },
  { read: 'commentperiod-public', plan: '25', identities: ANON, dataset: 'CommentPeriod',
    eagle: rows('/public/commentperiod/:period', undefined, COMMENT_PERIOD_ROUTE), demi: search('CommentPeriod', { 'and[_id]': ':period' }) },
  { read: 'commentperiod-list', plan: '26', identities: STAFF, dataset: 'CommentPeriod',
    eagle: rows('/commentperiod', { project: ':project' }, COMMENT_PERIOD_ROUTE),
    demi: search('CommentPeriod', { 'and[project]': ':project' }) },
  { read: 'commentperiod', plan: '27', identities: STAFF, dataset: 'CommentPeriod',
    eagle: rows('/commentperiod/:period', undefined, COMMENT_PERIOD_ROUTE), demi: search('CommentPeriod', { 'and[_id]': ':period' }) },
  pending('commentperiod-head', '28', HEAD_REASON),
  pending('commentperiod-summary', '29', 'no summary route; four and[eaoStatus] counts give it (S3)'),
  { read: 'comment-list-public', plan: '30', identities: ANON, dataset: 'Comment',
    eagle: pagedRows('/public/comment', { period: ':period' }, FIELDED_FACET), demi: search('Comment', { 'and[period]': ':period' }) },
  { read: 'comment-public', plan: '31', identities: ANON, dataset: 'Comment',
    eagle: rows('/public/comment/:comment', undefined, FIELDED_FACET), demi: search('Comment', { 'and[_id]': ':comment' }) },
  pending('comment-head-public', '32', HEAD_REASON),
  { read: 'comment-list', plan: '33', identities: STAFF, dataset: 'Comment',
    eagle: pagedRows('/comment', { period: ':period' }, FIELDED_FACET), demi: search('Comment', { 'and[period]': ':period' }) },
  { read: 'comment', plan: '34', identities: STAFF, dataset: 'Comment',
    eagle: rows('/comment/:comment', undefined, FIELDED_FACET), demi: search('Comment', { 'and[_id]': ':comment' }) },
  pending('comment-head', '35', HEAD_REASON),
  { read: 'comment-export', plan: '36', identities: STAFF, format: 'csv', key: 'Comment_No',
    ignoreColumns: ['Export_Date'],
    eagle: csv('/comment/export/:period', { format: 'staff' }), demi: csv('/commentperiods/:period/comments/export') },
  { read: 'organization-list-public', plan: '37', identities: ANON, dataset: 'Organization',
    eagle: rows('/public/organization', undefined, ORGANIZATION_ROUTE), demi: search('Organization') },
  { read: 'organization-public', plan: '38', identities: ANON, dataset: 'Organization',
    eagle: rows('/public/organization/:organization', undefined, ORGANIZATION_ROUTE), demi: search('Organization', { 'and[_id]': ':organization' }) },
  { read: 'organization-list', plan: '39', identities: STAFF, dataset: 'Organization',
    eagle: rows('/organization', undefined, ORGANIZATION_ROUTE), demi: search('Organization') },
  { read: 'organization', plan: '40', identities: STAFF, dataset: 'Organization',
    eagle: rows('/organization/:organization', undefined, ORGANIZATION_ROUTE), demi: search('Organization', { 'and[_id]': ':organization' }) },
  { read: 'project-notification-list', plan: '41', identities: STAFF, dataset: 'ProjectNotification',
    eagle: pagedRows('/projectNotification', undefined, FIELDED), demi: search('ProjectNotification') },
  { read: 'recent-activity-top', plan: '42', identities: ANON, dataset: 'RecentActivity',
    // Eagle answers its newest 4 whatever `top` says, so DEMI is asked for one page of 4.
    eagle: rows('/public/recentActivity', { top: 'true' }),
    demi: { ...search('RecentActivity', { top: 'true', pageSize: '4' }), paged: false } },
  pending('topic-vc', '43-46', 'no DEMI Topic or Vc kind yet (S9)'),
  // Item ids of one element. Eagle's item route streams the file and records a download, so the
  // element row's `items` refs stand in for it.
  { read: 'inspection-item', plan: '47', identities: STAFF, dataset: 'InspectionItem', fields: [],
    eagle: rows('/search', { dataset: 'Item', _id: ':element', _schemaName: 'InspectionElement' }),
    demi: rows('/inspection-items', { inspection: ':inspection', element: ':element' }),
    // Each item carries its element's read[], the ceiling DEMI derives the item's read under.
    mapEagle: elements => elements.flatMap(e => idRows(e.items || []).map(item => ({ ...item, read: e.read }))) },
  { read: 'config', plan: '48', skip: 'runtime config: the two documents differ by design, compared by hand' },
  // Anonymous only: both APIs answer every caller the anonymous file.
  { read: 'report-bcgw', plan: '49', identities: ANON, format: 'csv', key: 'Project GUID',
    keyIsEagleId: true, eagle: csv('/reports', { type: 'bcgw' }), demi: csv('/reports', { type: 'bcgw' }) },
  pending('materialized-views', '50-53', 'not ported: internal to Eagle'),
  pending('audit', '54', 'not ported: dead route')
];

const SEARCH_DATASETS = ['Project', 'Document', 'List', 'CommentPeriod', 'Organization', 'RecentActivity',
  'ProjectNotification'];

const SEARCH_READS = [
  ...SEARCH_DATASETS.flatMap(dataset => [
    { read: `search-${dataset}-public`, plan: '56', identities: ANON, dataset,
      eagle: { ...search(dataset), path: '/public/search' }, demi: search(dataset) },
    { read: `search-${dataset}`, plan: '55', identities: STAFF, dataset,
      eagle: search(dataset), demi: search(dataset) }
  ]),
  { read: 'search-Comment', plan: '55-56', skip: "Eagle's Comment search fails; nothing to compare against" },
  ...['User', 'Group', 'Inspection', 'InspectionElement'].map(dataset =>
    ({ read: `search-${dataset}`, plan: '55', identities: STAFF, dataset, eagle: search(dataset), demi: search(dataset) })),
  pending('search-Item', '55-56', 'needs an id per _schemaName; not wired to --id yet'),
  pending('search-CACUser', '55-56', 'no DEMI CACUser dataset yet (S9)')
];

const PARITY_MAP = [...REST_READS, ...SEARCH_READS];

module.exports = {
  PARITY_MAP, KNOWN_DIFFERENCES, classify, FIELDS, STAFF_FIELDS, PUBLIC_FIELDS, PREDICATE_FIELDS, EAGLE_ID, same,
  sameField, search, cappedFromStaff
};
