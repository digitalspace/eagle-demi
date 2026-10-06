'use strict';

/**
 * What `parity-eagle.js` replays: one entry per eagle-api read a consumer makes, the DEMI read that
 * answers it, and the differences already explained. Plan numbers are the read-by-read map in the
 * eagle-reads-in-DEMI plan; the map doubles as the consumer switch checklist.
 *
 * Path and query values `:project`, `:period`, `:document`, `:comment`, `:organization` are filled
 * from `--id <name>=<eagleId>`. Field entries are names both sides share or `[eagleName, demiName]`.
 */

const { EAGLE_STAFF_FIELDS } = require('../merge/project');
const commentMirror = require('../controllers/nosql/comment');
const commentPeriodMirror = require('../controllers/nosql/comment-period');
const organizationMirror = require('../controllers/nosql/organization');

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
  CommentPeriod: promoted(commentPeriodMirror.staffFields),
  Organization: promoted(organizationMirror.staffFields)
};

/** Fields Eagle strips for non-staff callers and DEMI shows: compared for anonymous only. */
const PUBLIC_FIELDS = {
  Project: ['review180Start', 'review45Start', 'reviewSuspensions', 'reviewExtensions'],
  Organization: ['postal']
};

/** Fields with a documented DEMI gap still open, per dataset. */
const OPEN_GAPS = {
  Pin: ['website']
};

const EAGLE_ID = /^[0-9a-f]{24}$/i;

const readOf = (row) => (row && Array.isArray(row.read) ? row.read : null);

/**
 * Every class a difference may be explained by. `ids: true` classes match only ids listed under
 * their name in `--known-ids <file>`; the others match on the rows themselves.
 * kind: missingInDemi (Eagle row, no DEMI row), extraInDemi (DEMI row, no Eagle row), fieldDiff.
 */
const KNOWN_DIFFERENCES = [
  { name: 'L1-no-ladder-token', kind: 'missingInDemi', identities: ['staff'],
    why: 'Eagle row has neither staff nor public in read[]: privileged-only in DEMI until D1',
    match: ({ eagle }) => !!readOf(eagle) && !readOf(eagle).includes('staff') && !readOf(eagle).includes('public') },
  { name: 'L2-never-mirrored', kind: 'missingInDemi', ids: true,
    why: 'Eagle row never reached DEMI; closed by backfill' },
  { name: 'L3-staff-field-not-promoted', kind: 'fieldDiff', identities: STAFF,
    why: 'staff field DEMI does not promote yet',
    match: ({ dataset, field, demiValue }) => (UNPROMOTED_STAFF_FIELDS[dataset] || []).includes(field) && demiValue == null },
  { name: 'L4-soft-deleted', kind: 'missingInDemi',
    why: 'Eagle isDeleted row; not ported',
    match: ({ eagle }) => eagle.isDeleted === true },
  { name: 'L5-demi-takedown', kind: 'missingInDemi', ids: true,
    why: 'DEMI took the row down (record.takedown audit entry)' },
  { name: 'demi-only', kind: 'extraInDemi',
    why: 'Track-only project or row created in DEMI: its id is not an Eagle ObjectId',
    match: ({ id }) => !EAGLE_ID.test(id) },
  { name: 'eagle-hard-deleted', kind: 'extraInDemi', ids: true,
    why: 'Eagle hard delete that sent no delete notice' },
  { name: 'public-field-difference', kind: 'fieldDiff', identities: ANON,
    why: 'Eagle strips the field for non-staff; DEMI shows it',
    match: ({ dataset, field, eagleValue }) => (PUBLIC_FIELDS[dataset] || []).includes(field) && eagleValue == null },
  { name: 'eagle-ungated-featured', kind: 'missingInDemi', identities: ANON, reads: ['featured-public'],
    why: 'Eagle public FeaturedDocuments skips the read[] check; DEMI applies it',
    match: ({ eagle }) => !!readOf(eagle) && !readOf(eagle).includes('public') },
  { name: 'open-gap', kind: 'fieldDiff',
    why: 'documented DEMI gap, plan section 2',
    match: ({ dataset, field }) => (OPEN_GAPS[dataset] || []).includes(field) }
];

const search = (dataset, query = {}) => ({ path: '/search', query: { dataset, ...query }, shape: 'search', paged: true });
const rows = (path, query) => ({ path, query, shape: 'array', paged: false });
const pagedRows = (path, query) => ({ path, query, shape: 'array', paged: true });
const one = (path, at) => ({ path, shape: 'object', at });
const pending = (read, plan, reason) => ({ read, plan, pending: true, skip: reason });
// DEMI sets x-total-count on GET and HEAD of /search; this script sends GET only.
const HEAD_REASON = 'HEAD not sent by this script';

const PROJECT_ONE_FIELDS = ['name', 'sector', 'region', ['type', 'projectType'], ['location', 'address']];
const DOCUMENT_ONE_FIELDS = ['documentFileName', 'displayName', 'datePosted', 'documentSource', ['type', 'typeId']];

const REST_READS = [
  { read: 'project-list-public', plan: '1', identities: ANON, dataset: 'Project',
    eagle: pagedRows('/public/project'), demi: search('Project') },
  { read: 'project-public', plan: '2', identities: ANON, dataset: 'Project', fields: PROJECT_ONE_FIELDS,
    eagle: rows('/public/project/:project'), demi: one('/projects/:project') },
  pending('project-head-public', '3', HEAD_REASON),
  { read: 'project-list', plan: '4', identities: STAFF, dataset: 'Project',
    eagle: pagedRows('/project'), demi: search('Project') },
  { read: 'project', plan: '5', identities: STAFF, dataset: 'Project', fields: PROJECT_ONE_FIELDS,
    eagle: rows('/project/:project'), demi: one('/projects/:project') },
  pending('project-head', '6-7', HEAD_REASON),
  { read: 'pins-public', plan: '8', identities: ANON, dataset: 'Pin',
    eagle: pagedRows('/public/project/:project/pin'), demi: one('/projects/:project', 'pins') },
  { read: 'pins', plan: '9', identities: STAFF, dataset: 'Pin',
    eagle: pagedRows('/project/:project/pin'), demi: one('/projects/:project', 'pins') },
  pending('group-members', '10', 'no DEMI Group kind yet (S5, S3)'),
  { read: 'featured-public', plan: '11', identities: ANON, dataset: 'Document',
    eagle: rows('/Public/project/:project/FeaturedDocuments'),
    demi: search('Document', { 'and[isFeatured]': 'true', project: ':project' }) },
  { read: 'featured', plan: '13', identities: STAFF, dataset: 'Document',
    eagle: rows('/project/:project/FeaturedDocuments'),
    demi: search('Document', { 'and[isFeatured]': 'true', project: ':project' }) },
  pending('featured-head', '12, 14', HEAD_REASON),
  { read: 'document-list-public', plan: '15', identities: ANON, dataset: 'Document',
    eagle: rows('/public/document', { project: ':project' }), demi: search('Document', { project: ':project' }) },
  { read: 'document-public', plan: '16', identities: ANON, dataset: 'Document', fields: DOCUMENT_ONE_FIELDS,
    eagle: rows('/public/document/:document'), demi: one('/documents/:document') },
  { read: 'document-download-public', plan: '17-18',
    skip: 'never called: the public download route increments publicHitCount' },
  { read: 'document-list', plan: '19', identities: STAFF, dataset: 'Document',
    eagle: rows('/document', { isDeleted: 'false', project: ':project' }), demi: search('Document', { project: ':project' }) },
  { read: 'document', plan: '20', identities: STAFF, dataset: 'Document', fields: DOCUMENT_ONE_FIELDS,
    eagle: rows('/document/:document'), demi: one('/documents/:document') },
  // Run by --download-sample over document ids paired by the reads above, not by --id.
  { read: 'document-download', plan: '21-23', identities: STAFF, download: true,
    eagle: { path: '/document/:document/download' }, demi: { path: '/documents/:document/download' } },
  { read: 'commentperiod-list-public', plan: '24', identities: ANON, dataset: 'CommentPeriod',
    eagle: rows('/public/commentperiod', { project: ':project' }),
    demi: search('CommentPeriod', { 'and[project]': ':project' }) },
  { read: 'commentperiod-public', plan: '25', identities: ANON, dataset: 'CommentPeriod',
    eagle: rows('/public/commentperiod/:period'), demi: search('CommentPeriod', { 'and[_id]': ':period' }) },
  { read: 'commentperiod-list', plan: '26', identities: STAFF, dataset: 'CommentPeriod',
    eagle: rows('/commentperiod', { project: ':project' }),
    demi: search('CommentPeriod', { 'and[project]': ':project' }) },
  { read: 'commentperiod', plan: '27', identities: STAFF, dataset: 'CommentPeriod',
    eagle: rows('/commentperiod/:period'), demi: search('CommentPeriod', { 'and[_id]': ':period' }) },
  pending('commentperiod-head', '28', HEAD_REASON),
  pending('commentperiod-summary', '29', 'no summary route; four and[eaoStatus] counts give it (S3)'),
  { read: 'comment-list-public', plan: '30', identities: ANON, dataset: 'Comment',
    eagle: pagedRows('/public/comment', { period: ':period' }), demi: search('Comment', { 'and[period]': ':period' }) },
  { read: 'comment-public', plan: '31', identities: ANON, dataset: 'Comment',
    eagle: rows('/public/comment/:comment'), demi: search('Comment', { 'and[_id]': ':comment' }) },
  pending('comment-head-public', '32', HEAD_REASON),
  { read: 'comment-list', plan: '33', identities: STAFF, dataset: 'Comment',
    eagle: pagedRows('/comment', { period: ':period' }), demi: search('Comment', { 'and[period]': ':period' }) },
  { read: 'comment', plan: '34', identities: STAFF, dataset: 'Comment',
    eagle: rows('/comment/:comment'), demi: search('Comment', { 'and[_id]': ':comment' }) },
  pending('comment-head', '35', HEAD_REASON),
  pending('comment-export', '36', 'no DEMI export route yet (S8, S7)'),
  { read: 'organization-list-public', plan: '37', identities: ANON, dataset: 'Organization',
    eagle: rows('/public/organization'), demi: search('Organization') },
  { read: 'organization-public', plan: '38', identities: ANON, dataset: 'Organization',
    eagle: rows('/public/organization/:organization'), demi: search('Organization', { 'and[_id]': ':organization' }) },
  { read: 'organization-list', plan: '39', identities: STAFF, dataset: 'Organization',
    eagle: rows('/organization'), demi: search('Organization') },
  { read: 'organization', plan: '40', identities: STAFF, dataset: 'Organization',
    eagle: rows('/organization/:organization'), demi: search('Organization', { 'and[_id]': ':organization' }) },
  { read: 'project-notification-list', plan: '41', identities: STAFF, dataset: 'ProjectNotification',
    eagle: pagedRows('/projectNotification'), demi: search('ProjectNotification') },
  { read: 'recent-activity-top', plan: '42', identities: ANON, dataset: 'RecentActivity',
    // Eagle answers its newest 4 whatever `top` says, so DEMI is asked for one page of 4.
    eagle: rows('/public/recentActivity', { top: 'true' }),
    demi: { ...search('HomeFeed', { pageSize: '4' }), paged: false } },
  pending('topic-vc', '43-46', 'no DEMI Topic or Vc kind yet (S9)'),
  pending('inspection-item', '47', 'no DEMI inspection kind yet (S5, S7)'),
  { read: 'config', plan: '48', skip: 'runtime config: the two documents differ by design, compared by hand' },
  pending('report-bcgw', '49', 'no DEMI report route yet (S8)'),
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
  PARITY_MAP, KNOWN_DIFFERENCES, FIELDS, STAFF_FIELDS, PUBLIC_FIELDS, EAGLE_ID
};
