'use strict';

/**
 * The harness the Cosmos-backed `/search` suites share.
 *
 * Every one of them drives the DISPATCHER rather than the controller function, because half of what
 * can go wrong on this route lives in the guard chain rather than in the branch: the
 * `canScopeToProject` gate that zeroes a project filter, the `unknownParams` 400, and the
 * `meta[0].searchResultsTotal` the response wrapper attaches and eagle-public pages against.
 *
 * `cosmos.query`/`readItem` are the stub point, one level BELOW the repositories, so the SQL each
 * request emits is real and assertable. That is the only place the caller's ACL can be checked on
 * this path: a branch that read with `systemAccess()` would answer 200 with rows an anonymous
 * visitor may not see, and nothing in the response would say so.
 *
 * The Eagle ids come from `eagle-mirror-fixtures` rather than being restated here — the push suites
 * and the read suites have to agree about which id is which, or a round trip they both pass is
 * still broken.
 */

const cosmos = require('../../src/db/cosmos-nosql');
const apiKeys = require('../../src/repositories/api-keys');
const { generateKey } = require('../../src/helpers/api-key');
const { forgetCachedKey } = require('../../src/helpers/auth');
const { withServer } = require('./with-server');
const {
  PROJECT_EAGLE_ID, PERIOD_EAGLE_ID, COMMENT_EAGLE_ID, ORG_EAGLE_ID, NOTIFICATION_EAGLE_ID,
  // `PUBLIC_ACL` carries `public`, `PRIVATE_ACL` does not — the pair is what an isolation case
  // compares. One definition for the push suites and the read suites, not two that can drift.
  PUBLIC_ACL, PRIVATE_ACL
} = require('./eagle-mirror-fixtures');

/** The DEMI project row every branch that names a project resolves through. */
const PROJECT_ROW = {
  id: '207', eagleId: PROJECT_EAGLE_ID, name: 'Nicomen Wind Energy', read: PUBLIC_ACL
};

/** The Cosmos partition key of each container the branches read. */
const PARTITION_FIELD = {
  projects: 'id',
  lists: 'kind',
  commentPeriods: 'projectId',
  comments: 'periodId',
  notifications: 'id',
  updates: 'id'
};

/**
 * Serve Cosmos by CONTAINER, and record every spec.
 *
 * `rows` is keyed by container name; a `VALUE COUNT(1)` query is answered from `counts`, defaulting
 * to the number of rows served, so a branch that builds its total from a different predicate than
 * its read is still visible in `seen`.
 */
function stubCosmos(t, rows, counts = {}) {
  const seen = [];
  const run = (container, spec, options) => {
    seen.push({ container, spec, options });
    // A partition key is HONOURED, so a read aimed at a partition that does not exist answers
    // nothing — the case an unresolved project id produces, and the one a stub that always serves
    // its fixture would hide.
    const served = (rows[container] || []).filter(row =>
      options.partitionKey === undefined ||
      String(row[PARTITION_FIELD[container]]) === String(options.partitionKey));

    if (/COUNT\(1\)/.test(spec.query)) return { items: [counts[container] ?? served.length] };
    return { items: served.slice() };
  };

  t.mock.method(cosmos, 'query', async (container, spec, options) => run(container, spec, options));
  // A single-row lookup is its OWN entry point, not a `query` with a page size: it holds one
  // iterator and drains it, because the SDK hands no continuation token back on the cross-partition
  // path. Same spec, so the assertions below still read it out of `seen`.
  t.mock.method(cosmos, 'queryFirst', async (container, spec, options = {}) =>
    run(container, spec, options).items[0] ?? null);
  t.mock.method(cosmos, 'readItem', async (container, id) =>
    (rows[container] || []).find(r => String(r.id) === String(id)) || null);
  return seen;
}

/** The specs a container saw, read query first. */
const specsFor = (seen, container) =>
  seen.filter(s => s.container === container).map(s => s.spec);

/** Every parameter value one spec bound, so an ACL token can be looked for by value. */
const boundValues = (spec) => (spec.parameters || []).map(p => String(p.value));

async function get(path) {
  let payload;
  let status;
  await withServer(async (call) => {
    const res = await call(path);
    status = res.status;
    payload = await res.json();
  });
  return { status, body: payload };
}

/** The same call under a staff credential, so the two visibility levels can be compared. */
async function getAsStaff(t, path) {
  const { keyId, plaintext, hash } = generateKey('test');
  forgetCachedKey(keyId);
  t.mock.method(apiKeys, 'getById', async () => ({
    id: keyId, name: 'reader', hash, roles: ['staff'],
    projectScope: null, expiresAt: null, revokedAt: null
  }));
  t.mock.method(apiKeys, 'touchLastUsed', async () => {});

  let payload;
  let status;
  await withServer(async (call) => {
    const res = await call(path, { headers: { 'x-api-key': plaintext } });
    status = res.status;
    payload = await res.json();
  });
  forgetCachedKey(keyId);
  return { status, body: payload };
}

const listRow = (over = {}) => ({
  id: '5cf00c03a266b7e1877504ca',
  eagleId: '5cf00c03a266b7e1877504ca',
  kind: 'List',
  sourceSystem: 'eagle',
  name: 'Amendment Package',
  type: 'doctype',
  item: 'https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/370_2002',
  legislation: '2002',
  listOrder: 12,
  isPublished: true,
  read: PUBLIC_ACL,
  sources: { eagle: { secret: 'raw' } },
  ...over
});

const orgRow = (over = {}) => ({
  id: ORG_EAGLE_ID,
  eagleId: ORG_EAGLE_ID,
  kind: 'Organization',
  sourceSystem: 'eagle',
  name: 'Nicomen Energy Ltd',
  companyType: 'Proponent/Certificate Holder',
  province: 'BC',
  isPublished: true,
  read: PUBLIC_ACL,
  ...over
});

const periodRow = (over = {}) => ({
  id: PERIOD_EAGLE_ID,
  eagleId: PERIOD_EAGLE_ID,
  // The DEMI project id, as the mirror stores it.
  projectId: '207',
  sourceSystem: 'eagle',
  dateStarted: '2026-08-01T00:00:00.000Z',
  dateCompleted: '2026-08-30T00:00:00.000Z',
  instructions: 'Tell us what you think.',
  additionalText: 'Comment on the amendment application.',
  isMet: false,
  metURL: '',
  metBannerImageUrl: 'https://engage.gov.bc.ca/banner.jpg',
  informationLabel: 'Read the application',
  isPublished: true,
  read: PUBLIC_ACL,
  ...over
});

const commentRow = (over = {}) => ({
  id: COMMENT_EAGLE_ID,
  eagleId: COMMENT_EAGLE_ID,
  periodId: PERIOD_EAGLE_ID,
  projectId: '207',
  sourceSystem: 'eagle',
  author: 'Jane Public',
  comment: 'Please consider the wetland.',
  commentId: 41,
  dateAdded: '2026-08-05T00:00:00.000Z',
  dateUpdated: '2026-08-06T00:00:00.000Z',
  location: 'Nicomen Island',
  submittedCAC: true,
  isAnonymous: true,
  documents: [],
  eaoStatus: 'Published',
  isPublished: true,
  read: PUBLIC_ACL,
  ...over
});

const updateRow = (over = {}) => ({
  id: '5f0e4a0c3f4b1a0021a1b2c1',
  eagleId: '5f0e4a0c3f4b1a0021a1b2c1',
  // The EAGLE project id — updates.js SCOPE_FIELD, the opposite of the period row above.
  projectId: PROJECT_EAGLE_ID,
  headline: 'Application accepted',
  content: 'The application has been accepted for review.',
  type: 'project',
  pinned: true,
  dateAdded: '2026-09-01T00:00:00.000Z',
  dateUpdated: '2026-09-01T00:00:00.000Z',
  active: true,
  notificationName: 'Nicomen Wind Energy',
  contentUrl: 'https://projects.eao.gov.bc.ca/p/588511d0aaecd9001b825604/news',
  documentUrl: 'https://projects.eao.gov.bc.ca/api/document/5cf00c03a266b7e187750002/fetch',
  pcp: PERIOD_EAGLE_ID,
  projectNotification: NOTIFICATION_EAGLE_ID,
  isPublished: true,
  read: PUBLIC_ACL,
  notifiedAt: '2026-09-01T01:00:00.000Z',
  ...over
});

const notificationRow = (over = {}) => ({
  id: NOTIFICATION_EAGLE_ID,
  eagleId: NOTIFICATION_EAGLE_ID,
  sourceSystem: 'eagle',
  name: 'Bear Creek Quarry',
  type: 'Project Notification',
  subType: 'New',
  region: 'Cariboo',
  notificationReceivedDate: '2026-05-01T00:00:00.000Z',
  isPublished: true,
  read: PUBLIC_ACL,
  ...over
});

module.exports = {
  PROJECT_EAGLE_ID,
  PERIOD_EAGLE_ID,
  NOTIFICATION_EAGLE_ID,
  PUBLIC_ACL,
  PRIVATE_ACL,
  PROJECT_ROW,
  PARTITION_FIELD,
  stubCosmos,
  specsFor,
  boundValues,
  get,
  getAsStaff,
  listRow,
  orgRow,
  periodRow,
  commentRow,
  updateRow,
  notificationRow
};
