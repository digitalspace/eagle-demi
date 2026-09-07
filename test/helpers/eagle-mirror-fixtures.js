'use strict';

/**
 * Raw Eagle records for the four public-read mirrors, and the one call that drives a mirror and
 * hands back the row it wrote.
 *
 * Shared by the push suite and the catalog-completeness suite: they assert different things about
 * the SAME emitted row, and two fixtures would let one of them keep passing on a field the other
 * had already outgrown.
 *
 * Hand-written, never derived from the controllers — a fixture built from the thing under test
 * grows a field at the same moment it does and can never fail.
 */

const commentPeriods = require('../../src/repositories/comment-periods');
const comments = require('../../src/repositories/comments');
const notifications = require('../../src/repositories/notifications');
const lists = require('../../src/repositories/lists');
const projects = require('../../src/repositories/projects');

const commentPeriodController = require('../../src/controllers/nosql/comment-period');
const commentController = require('../../src/controllers/nosql/comment');
const organizationController = require('../../src/controllers/nosql/organization');
const notificationController = require('../../src/controllers/nosql/notification');

const PROJECT_EAGLE_ID = '588511d0aaecd9001b825604';
const PERIOD_EAGLE_ID = '5b8bcf0d0f5e9c0019a7a1c1';
const COMMENT_EAGLE_ID = '5b8bcf0d0f5e9c0019a7a1c2';
const ORG_EAGLE_ID = '58850f69aaecd9001b8085cc';
const NOTIFICATION_EAGLE_ID = '5f0e4a0c3f4b1a0021a1b2c3';

/** Published, and taken down: what Eagle leaves on a record staff can still read. */
const PUBLIC_ACL = ['public', 'sysadmin', 'staff'];
const PRIVATE_ACL = ['sysadmin', 'staff'];

/** The DEMI project row the period mirror looks its parent up in. */
function storedProject(read = PUBLIC_ACL) {
  return { id: '207', eagleId: PROJECT_EAGLE_ID, name: 'Nicomen Wind Energy', read };
}

/** The mirrored period a comment push reads its ceiling from — already project-constrained. */
function storedPeriod(read = ['staff', 'idir', 'public']) {
  return { id: PERIOD_EAGLE_ID, projectId: '207', read };
}

function eaglePeriod(overrides = {}) {
  return {
    _id: PERIOD_EAGLE_ID,
    project: PROJECT_EAGLE_ID,
    dateStarted: '2026-08-01T00:00:00.000Z',
    dateCompleted: '2026-08-30T00:00:00.000Z',
    dateAdded: '2026-07-20T00:00:00.000Z',
    isMet: false,
    metURL: '',
    informationLabel: 'Read the application',
    instructions: 'Tell us what you think.',
    openHouses: [{ eventDate: '2026-08-10T00:00:00.000Z', description: 'Community hall' }],
    relatedDocuments: ['5cf00c03a266b7e187750002'],
    commentTip: 'Comments are public.',
    read: PUBLIC_ACL,
    ...overrides
  };
}

function eagleComment(overrides = {}) {
  return {
    _id: COMMENT_EAGLE_ID,
    period: PERIOD_EAGLE_ID,
    author: 'Jane Public',
    comment: 'The turbine setback is too small.',
    dateAdded: '2026-08-05T00:00:00.000Z',
    isAnonymous: false,
    documents: ['5cf00c03a266b7e187750003'],
    commentId: 12,
    eaoStatus: 'Published',
    read: PUBLIC_ACL,
    ...overrides
  };
}

function eagleOrganization(overrides = {}) {
  return {
    _id: ORG_EAGLE_ID,
    name: 'Nicomen Energy Ltd',
    companyType: 'Proponent',
    province: 'BC',
    country: 'Canada',
    address1: '100 Wind Way',
    city: 'Merritt',
    postal: 'V1K 1B8',
    website: 'https://example.invalid',
    read: PUBLIC_ACL,
    ...overrides
  };
}

function eagleNotification(overrides = {}) {
  return {
    _id: NOTIFICATION_EAGLE_ID,
    name: 'Sunny Ridge Quarry',
    type: 'Mines',
    subType: 'Sand and Gravel',
    proponent: 'Nicomen Energy Ltd',
    nature: 'New Construction',
    region: 'Thompson-Nicola',
    location: 'Near Merritt',
    decision: 'In Progress',
    decisionDate: null,
    notificationReceivedDate: '2026-06-01T00:00:00.000Z',
    trigger: 'Threshold',
    description: 'A new quarry was notified to the EAO.',
    centroid: [-120.8, 50.1],
    associatedProjectId: null,
    associatedProjectName: null,
    pcp: 'none',
    isMet: false,
    metURL: '',
    dateStarted: null,
    dateCompleted: null,
    notificationThresholdValue: 250000,
    notificationThresholdUnits: 'tonnes/year',
    read: PUBLIC_ACL,
    ...overrides
  };
}

/** entity name in src/vis/catalog -> everything a test needs to drive that mirror. */
const MIRRORS = {
  commentPeriods: {
    controller: commentPeriodController, repo: commentPeriods,
    eagleId: PERIOD_EAGLE_ID, fixture: eaglePeriod
  },
  comments: {
    controller: commentController, repo: comments,
    eagleId: COMMENT_EAGLE_ID, fixture: eagleComment
  },
  lists: {
    controller: organizationController, repo: lists,
    eagleId: ORG_EAGLE_ID, fixture: eagleOrganization
  },
  notifications: {
    controller: notificationController, repo: notifications,
    eagleId: NOTIFICATION_EAGLE_ID, fixture: eagleNotification
  }
};

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    setHeader() {}
  };
}

const STAFF = { sub: 'kc-sub-1', preferred_username: 'push', realm_access: { roles: ['sysadmin'] } };

/**
 * Drive one mirror and return `{ res, row }` — the row is what the controller handed the
 * repository, so every assertion is about the real emitter rather than a copy of it.
 *
 * The caller's `t` owns the mocks; restore them with `t.mock.restoreAll()`.
 */
async function captureMirror(t, entity, doc, { existing = null, project, period } = {}) {
  const { controller, repo, eagleId } = MIRRORS[entity];

  t.mock.method(projects, 'getByEagleId', async () => (project === undefined ? storedProject() : project));
  t.mock.method(commentPeriods, 'getById', async () => (period === undefined ? storedPeriod() : period));
  // AFTER the parent stubs: on the commentPeriods mirror `repo` IS commentPeriods, and what that
  // mirror reads by id is its own existing row, never a parent.
  t.mock.method(repo, 'getById', async () => existing);

  let row;
  t.mock.method(repo, 'upsert', async (item) => { row = item; return item; });

  const res = mockRes();
  await controller.upsertFromEagle(
    { params: { eagleId }, query: {}, body: { doc: doc || MIRRORS[entity].fixture() }, user: STAFF },
    res
  );
  return { res, row };
}

module.exports = {
  PROJECT_EAGLE_ID,
  PERIOD_EAGLE_ID,
  COMMENT_EAGLE_ID,
  ORG_EAGLE_ID,
  NOTIFICATION_EAGLE_ID,
  PUBLIC_ACL,
  PRIVATE_ACL,
  MIRRORS,
  storedProject,
  storedPeriod,
  eaglePeriod,
  eagleComment,
  eagleOrganization,
  eagleNotification,
  mockRes,
  STAFF,
  captureMirror
};
