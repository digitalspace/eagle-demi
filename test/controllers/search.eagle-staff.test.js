'use strict';

// `GET /search` as eagle-api serves staff: staff project fields, `eaoStatus`, the measured total.
// The `strict` stub applies the read's role arm, so a read without the caller's ACL fails here.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const aiSearch = require('../../src/search/ai-search');
const {
  PERIOD_EAGLE_ID, PUBLIC_ACL, PRIVATE_ACL, PROJECT_ROW,
  stubCosmos, specsFor, get, getAsStaff, commentRow, notificationRow
} = require('../helpers/search-reads');

const stub = (t, rows) => stubCosmos(t, rows, {}, { strict: true });

const resultsOf = (res) => res.body[0].searchResults;
const idsOf = (res) => resultsOf(res).map(row => row._id);

/** The eighteen level-2 project fields from catalog/projects.js, as stored. */
const STAFF_FIELDS = {
  CELead: 'Lee Officer', CELeadEmail: 'lee@example.invalid', CELeadPhone: '250-555-0101',
  projectLeadId: 'u-lead', responsibleEPDId: 'u-epd', projLead: 'Pat Lead', addedBy: 'u-added',
  intake: { investment: '1M' }, dateCommentsOpen: '2026-01-01', dateCommentsClosed: '2026-02-01',
  duration: '30 days', isTermsAgreed: true, primaryContact: 'Sam Contact', proMember: 'Member',
  eaStatusDate: '2026-03-01', projectStatusDate: '2026-03-02', activeDate: '2026-03-03',
  hasMetCommentPeriods: true
};
// eagle-api's public project read returns these two, so DEMI does too.
const SUBSTANTIAL_START = { substantially: true, substantiallyDate: '2026-03-04' };
const STAFF_PROJECT = { ...PROJECT_ROW, ...STAFF_FIELDS, ...SUBSTANTIAL_START };

test('dataset=Project: a staff caller gets all eighteen staff project fields', async (t) => {
  stub(t, { projects: [STAFF_PROJECT] });
  const row = resultsOf(await getAsStaff(t, '/api/search?dataset=Project'))[0];
  assert.deepStrictEqual(
    Object.fromEntries(Object.keys(STAFF_FIELDS).map(key => [key, row[key]])), STAFF_FIELDS);
});

test('dataset=Project: an anonymous caller (level 4) gets none of them', async (t) => {
  stub(t, { projects: [STAFF_PROJECT] });
  const row = resultsOf(await get('/api/search?dataset=Project'))[0];
  assert.deepStrictEqual(Object.keys(STAFF_FIELDS).filter(key => key in row), []);
});

test('dataset=Project: an anonymous caller gets the substantial start fields', async (t) => {
  stub(t, { projects: [STAFF_PROJECT] });
  const row = resultsOf(await get('/api/search?dataset=Project'))[0];
  assert.strictEqual(row.substantially, true);
  assert.strictEqual(row.substantiallyDate, '2026-03-04');
});

test('dataset=Project keyword search: a staff caller gets the staff fields the index lacks', async (t) => {
  stub(t, { projects: [STAFF_PROJECT] });
  t.mock.method(aiSearch, 'searchProjects', async () => ({
    count: 1, items: [{ id: '207', name: 'Nicomen Wind Energy', read: ['public'] }]
  }));
  const row = resultsOf(await getAsStaff(t, '/api/search?dataset=Project&keywords=wind'))[0];
  assert.strictEqual(row.CELead, 'Lee Officer');
});

test('dataset=Project keyword search: an anonymous caller gets no staff field and no extra read', async (t) => {
  const seen = stub(t, { projects: [STAFF_PROJECT] });
  t.mock.method(aiSearch, 'searchProjects', async () => ({
    count: 1, items: [{ id: '207', name: 'Nicomen Wind Energy', read: ['public'] }]
  }));
  const row = resultsOf(await get('/api/search?dataset=Project&keywords=wind'))[0];
  assert.strictEqual(row.CELead, undefined);
  // The dial-hidden id read is the only projects read; no row is fetched for staff fields.
  assert.deepStrictEqual(specsFor(seen, 'projects').filter(s => !s.query.startsWith('SELECT VALUE c.id FROM c ')), []);
});

/** One published notification and one staff-only one. */
const NOTIFICATIONS = {
  notifications: [
    notificationRow({ read: PUBLIC_ACL }),
    notificationRow({ id: 'n-staff', eagleId: 'n-staff', read: PRIVATE_ACL })
  ]
};

test('x-total-count carries the measured total, not the page length', async (t) => {
  stubCosmos(t, NOTIFICATIONS, { notifications: 7 }, { strict: true });
  const res = await getAsStaff(t, '/api/search?dataset=ProjectNotification');
  assert.strictEqual(resultsOf(res).length, 2);
  assert.strictEqual(res.headers.get('x-total-count'), '7');
});

test('x-total-count on an anonymous read counts only the rows that caller may see', async (t) => {
  stub(t, NOTIFICATIONS);
  const res = await get('/api/search?dataset=ProjectNotification');
  assert.strictEqual(res.headers.get('x-total-count'), '1');
});

test('HEAD answers the same x-total-count with no body', async (t) => {
  stub(t, NOTIFICATIONS);
  const res = await getAsStaff(t, '/api/search?dataset=ProjectNotification', ['staff'], { method: 'HEAD' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('x-total-count'), '2');
  assert.strictEqual(res.body, '');
});

const PUBLISHED = commentRow();
const PENDING = commentRow({
  id: 'c-pending', eagleId: 'c-pending', commentId: 42, eaoStatus: 'Pending', isPublished: false, read: PRIVATE_ACL
});
const COMMENTS = { projects: [PROJECT_ROW], comments: [PUBLISHED, PENDING] };
const COMMENT_URL = `/api/search?dataset=Comment&and[period]=${PERIOD_EAGLE_ID}`;

test('dataset=Comment and[eaoStatus]=Pending: staff gets the pending comment and its count', async (t) => {
  stub(t, COMMENTS);
  const res = await getAsStaff(t, `${COMMENT_URL}&and[eaoStatus]=Pending`);
  assert.deepStrictEqual(idsOf(res), ['c-pending']);
  assert.strictEqual(res.headers.get('x-total-count'), '1');
});

test('dataset=Comment and[eaoStatus]=Pending: an anonymous caller gets nothing', async (t) => {
  stub(t, COMMENTS);
  const res = await get(`${COMMENT_URL}&and[eaoStatus]=Pending`);
  assert.deepStrictEqual(idsOf(res), []);
});

test('dataset=Comment: an unknown eaoStatus is a 400, never every comment', async (t) => {
  stub(t, COMMENTS);
  const res = await getAsStaff(t, `${COMMENT_URL}&and[eaoStatus]=Approved`);
  assert.strictEqual(res.status, 400);
});
