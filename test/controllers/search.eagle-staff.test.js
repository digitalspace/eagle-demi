'use strict';

/**
 * `GET /search` for what eagle-api's search serves a staff or sysadmin caller: the User, Group and
 * inspection datasets, `dataset=Item`, the staff project fields, `x-total-count` and Eagle's
 * comment `eaoStatus` filter.
 *
 * The stub runs in `strict` mode: it applies the role arm of the read predicate the request
 * emitted, so a dataset that reads without the caller's ACL serves a sysadmin-only row to an
 * anonymous caller and fails here. Harness: `test/helpers/search-reads.js`.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const aiSearch = require('../../src/search/ai-search');
const {
  PROJECT_EAGLE_ID, PERIOD_EAGLE_ID, PUBLIC_ACL, PRIVATE_ACL, PROJECT_ROW,
  stubCosmos, specsFor, get, getAsStaff, commentRow
} = require('../helpers/search-reads');
const {
  USER_EAGLE_ID, GROUP_EAGLE_ID, INSPECTION_EAGLE_ID, ELEMENT_EAGLE_ID, ITEM_EAGLE_ID,
  storedInspection, storedElement
} = require('../helpers/eagle-mirror-fixtures');

/** Eagle's default `['sysadmin']` as the mirrors store it: `seedAcl` adds the staff token. */
const STAFF_ONLY = PRIVATE_ACL;

const PRIVATE_USER = {
  id: USER_EAGLE_ID, eagleId: USER_EAGLE_ID, sourceSystem: 'eagle',
  firstName: 'Pat', lastName: 'Inspector', email: 'pat@example.invalid', phoneNumber: '250-555-0100',
  read: STAFF_ONLY
};
/** A user Eagle published: the name card reaches the public, the contact fields never do. */
const PUBLIC_USER = {
  id: 'u-public', eagleId: 'u-public', sourceSystem: 'eagle',
  displayName: 'Open Contact', email: 'open@example.invalid', read: PUBLIC_ACL
};
const GROUP = {
  id: GROUP_EAGLE_ID, eagleId: GROUP_EAGLE_ID, projectId: '207', name: 'Working group',
  members: ['m1'], read: STAFF_ONLY
};
const INSPECTION = {
  ...storedInspection(STAFF_ONLY), eagleId: INSPECTION_EAGLE_ID, name: 'Site visit', email: 'officer@example.invalid'
};
const ELEMENT = { ...storedElement(STAFF_ONLY), eagleId: ELEMENT_EAGLE_ID, title: 'Culvert' };
const ITEM = {
  id: ITEM_EAGLE_ID, eagleId: ITEM_EAGLE_ID, kind: 'InspectionItem', inspection: INSPECTION_EAGLE_ID,
  element: ELEMENT_EAGLE_ID, projectId: '207', caption: 'Outflow', internalURL: 'blob/outflow.jpg',
  read: STAFF_ONLY
};

const CORPUS = {
  projects: [PROJECT_ROW],
  users: [PRIVATE_USER, PUBLIC_USER],
  groups: [GROUP],
  inspections: [INSPECTION, ELEMENT, ITEM]
};

const stub = (t, rows = CORPUS) => stubCosmos(t, rows, {}, { strict: true });

const resultsOf = (res) => res.body[0].searchResults;
const idsOf = (res) => resultsOf(res).map(row => row._id);

/** One dataset over a staff-only row: what each caller gets back. */
const STAFF_ONLY_DATASETS = [
  { dataset: 'User', id: USER_EAGLE_ID },
  { dataset: 'Group', id: GROUP_EAGLE_ID },
  { dataset: 'Inspection', id: INSPECTION_EAGLE_ID },
  { dataset: 'InspectionElement', id: ELEMENT_EAGLE_ID },
  { dataset: 'InspectionItem', id: ITEM_EAGLE_ID }
];

for (const { dataset, id } of STAFF_ONLY_DATASETS) {
  test(`dataset=${dataset}: an anonymous caller gets no staff-only row`, async (t) => {
    stub(t);
    const res = await get(`/api/search?dataset=${dataset}`);
    assert.strictEqual(res.status, 200);
    assert.ok(!idsOf(res).includes(id), `anonymous read ${dataset} ${id}`);
  });

  test(`dataset=${dataset}: a staff caller gets the row, under its Eagle schema name`, async (t) => {
    stub(t);
    const res = await getAsStaff(t, `/api/search?dataset=${dataset}`);
    assert.strictEqual(res.status, 200);
    const row = resultsOf(res).find(r => r._id === id);
    assert.strictEqual(row && row._schemaName, dataset);
  });

  test(`dataset=${dataset}: a sysadmin caller gets the row`, async (t) => {
    stub(t);
    const res = await getAsStaff(t, `/api/search?dataset=${dataset}`, ['sysadmin']);
    assert.ok(idsOf(res).includes(id));
  });
}

test('dataset=User: an anonymous caller gets a published user without its email', async (t) => {
  stub(t);
  const row = resultsOf(await get('/api/search?dataset=User')).find(r => r._id === 'u-public');
  assert.strictEqual(row.displayName, 'Open Contact');
  assert.strictEqual(row.email, undefined);
});

test('dataset=User: a staff caller gets the email', async (t) => {
  stub(t);
  const row = resultsOf(await getAsStaff(t, '/api/search?dataset=User')).find(r => r._id === USER_EAGLE_ID);
  assert.strictEqual(row.email, 'pat@example.invalid');
});

test('dataset=User: a project filter answers nothing, since a user has no project', async (t) => {
  stub(t);
  const res = await getAsStaff(t, `/api/search?dataset=User&and[project]=${PROJECT_EAGLE_ID}`);
  assert.deepStrictEqual(idsOf(res), []);
});

test('dataset=Group: the row carries the Eagle project id and the members reach staff', async (t) => {
  stub(t);
  const row = resultsOf(await getAsStaff(t, `/api/search?dataset=Group&and[project]=${PROJECT_EAGLE_ID}`))[0];
  assert.strictEqual(row.project, PROJECT_EAGLE_ID);
  assert.deepStrictEqual(row.members, ['m1']);
});

test('dataset=Inspection: a published inspection reaches an anonymous caller without the inspector email', async (t) => {
  stub(t, { ...CORPUS, inspections: [{ ...INSPECTION, read: PUBLIC_ACL }] });
  const row = resultsOf(await get('/api/search?dataset=Inspection'))[0];
  assert.strictEqual(row.name, 'Site visit');
  assert.strictEqual(row.email, undefined);
});

test('dataset=Inspection: a staff caller gets the inspector email', async (t) => {
  stub(t);
  const row = resultsOf(await getAsStaff(t, '/api/search?dataset=Inspection'))[0];
  assert.strictEqual(row.email, 'officer@example.invalid');
});

test('dataset=InspectionItem: and[element] reads the items of that element only', async (t) => {
  const other = { ...ITEM, id: 'item-2', eagleId: 'item-2', element: 'element-2' };
  stub(t, { ...CORPUS, inspections: [INSPECTION, ELEMENT, ITEM, other] });
  const res = await getAsStaff(t,
    `/api/search?dataset=InspectionItem&and[inspection]=${INSPECTION_EAGLE_ID}&and[element]=${ELEMENT_EAGLE_ID}`);
  assert.deepStrictEqual(idsOf(res), [ITEM_EAGLE_ID]);
});

test('dataset=Item: a staff caller gets the bare array eagle-admin reads, with the stored-file fields', async (t) => {
  stub(t);
  const res = await getAsStaff(t, `/api/search?dataset=Item&_id=${ITEM_EAGLE_ID}&_schemaName=InspectionItem`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.length, 1);
  assert.strictEqual(res.body[0]._schemaName, 'InspectionItem');
  assert.strictEqual(res.body[0].internalURL, 'blob/outflow.jpg');
});

test('dataset=Item: an anonymous caller gets an empty array for a staff-only item', async (t) => {
  stub(t);
  const res = await get(`/api/search?dataset=Item&_id=${ITEM_EAGLE_ID}&_schemaName=InspectionItem`);
  assert.deepStrictEqual(res.body, []);
});

test('dataset=Item: a sysadmin caller reads a user by id', async (t) => {
  stub(t);
  const res = await getAsStaff(t, `/api/search?dataset=Item&_id=${USER_EAGLE_ID}&_schemaName=User`, ['sysadmin']);
  assert.strictEqual(res.body[0]._id, USER_EAGLE_ID);
});

test('dataset=Item: a model DEMI does not serve is a 400', async (t) => {
  stub(t);
  const res = await getAsStaff(t, `/api/search?dataset=Item&_id=${USER_EAGLE_ID}&_schemaName=Audit`);
  assert.strictEqual(res.status, 400);
});

test('_schemaName on any dataset but Item is a 400', async (t) => {
  stub(t);
  const res = await getAsStaff(t, '/api/search?dataset=User&_schemaName=User');
  assert.strictEqual(res.status, 400);
});

test('dataset=User: keywords are a 400, not every user', async (t) => {
  stub(t);
  const res = await getAsStaff(t, '/api/search?dataset=User&keywords=pat');
  assert.strictEqual(res.status, 400);
});

test('a parameter the endpoint does not read is still a 400', async (t) => {
  stub(t);
  const res = await getAsStaff(t, '/api/search?dataset=User&inspection=x');
  assert.strictEqual(res.status, 400);
});

/** The twenty level-2 project fields from catalog/projects.js, as stored. */
const STAFF_FIELDS = {
  CELead: 'Lee Officer', CELeadEmail: 'lee@example.invalid', CELeadPhone: '250-555-0101',
  projectLeadId: 'u-lead', responsibleEPDId: 'u-epd', projLead: 'Pat Lead', addedBy: 'u-added',
  intake: { investment: '1M' }, dateCommentsOpen: '2026-01-01', dateCommentsClosed: '2026-02-01',
  duration: '30 days', isTermsAgreed: true, primaryContact: 'Sam Contact', proMember: 'Member',
  eaStatusDate: '2026-03-01', projectStatusDate: '2026-03-02', activeDate: '2026-03-03',
  substantially: false, substantiallyDate: '2026-03-04', hasMetCommentPeriods: true
};
const STAFF_PROJECT = { ...PROJECT_ROW, ...STAFF_FIELDS };

test('dataset=Project: a staff caller gets all twenty staff project fields', async (t) => {
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
  assert.deepStrictEqual(specsFor(seen, 'projects'), []);
});

test('x-total-count carries the measured total, not the page length', async (t) => {
  stubCosmos(t, CORPUS, { users: 7 }, { strict: true });
  const res = await getAsStaff(t, '/api/search?dataset=User');
  assert.strictEqual(resultsOf(res).length, 2);
  assert.strictEqual(res.headers.get('x-total-count'), '7');
});

test('x-total-count on an anonymous read counts only the rows that caller may see', async (t) => {
  stub(t);
  const res = await get('/api/search?dataset=User');
  assert.strictEqual(res.headers.get('x-total-count'), '1');
});

test('HEAD answers the same x-total-count with no body', async (t) => {
  stub(t);
  const res = await getAsStaff(t, '/api/search?dataset=User', ['staff'], { method: 'HEAD' });
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
