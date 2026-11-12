'use strict';

// Staff contacts, external ids, investment and notes on a project row: who reads them, and the
// append-and-close rule the PUT holds them to.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const querystring = require('node:querystring');

const projects = require('../../../src/repositories/projects');
const projectController = require('../../../src/controllers/nosql/project');
const { makeRes } = require('../../../src/http/router');
const { logger } = require('../../../src/utils/logger');
const audit = require('../../../src/utils/audit');
const { carryDemiOnlyFields } = require('../../../src/merge/project');
const { TWIN_CARRY_FIELDS } = require('../../../src/ownership/project');
const { observeInvestment, currentInvestment } = require('../../../src/domain/project-staff-fields');
const { fakeWhereQuery } = require('../../helpers/updates-store');
const { mockRes } = require('../../helpers/mock-res');

audit._setTransport(async () => {});

const CONTACTS = {
  projectLead: 'Robin Example', responsibleEPD: 'Casey Sample', eaoMember: 'Drew Placeholder',
  projectLeadEmail: 'robin.example@example.invalid', responsibleEPDEmail: 'casey.sample@example.invalid',
  projectLeadPhone: '250 555 0199', responsibleEPDPhone: '250 555 0198'
};
const LEVEL_2_FIELDS = ['externalIds', 'capitalInvestments', 'staffNotes'];
const LEVEL_3_FIELDS = [...Object.keys(CONTACTS), 'staffAssignments'];

const ASSIGNMENT = {
  id: 'a1', role: 'epd', name: 'Casey Sample', effectiveFrom: null, effectiveTo: null,
  observedAt: '2026-11-01', source: 'sheet', sheetKey: 'k1', recordedAt: '2026-11-01T00:00:00.000Z'
};
const INVESTMENT = {
  id: 'i1', amountCad: 1000, effectiveFrom: null, effectiveTo: null, observedAt: '2026-11-01',
  workId: null, source: 'sheet', sheetKey: 'k2', recordedAt: '2026-11-01T00:00:00.000Z'
};
const NOTE = {
  id: 'n1', text: 'Waiting on the proponent', workId: null, observedAt: '2026-11-01',
  source: 'sheet', sheetKey: 'k3', recordedAt: '2026-11-01T00:00:00.000Z'
};
const STAFF_HISTORY = {
  externalIds: [{ system: 'eao-register', value: '412', source: 'sheet', recordedAt: '2026-11-01T00:00:00.000Z' }],
  staffAssignments: [ASSIGNMENT],
  capitalInvestments: [INVESTMENT],
  staffNotes: [NOTE]
};

// A dial at 4 on every field: the catalog cap, not the dial, is what keeps them in.
const ROW = {
  id: '412', trackProjectId: 412, name: 'Example Gold Mine', read: ['public', 'staff', 'sysadmin'], isPublished: true,
  ...CONTACTS, ...STAFF_HISTORY,
  legislation_2002: { name: 'Example Gold Mine', ...CONTACTS },
  legislation_2018: { name: 'Example Gold Mine', ...CONTACTS },
  vis: Object.fromEntries([...LEVEL_2_FIELDS, ...LEVEL_3_FIELDS].map(field => [field, 4])),
  _etag: '"0x1"'
};

const ANONYMOUS = undefined;
const IDIR = { identity_provider: 'idir' };
const STAFF = { realm_access: { roles: ['staff'] } };
const SERVICE_WRITE = { realm_access: { roles: ['demi-service-write'] } };

async function getOne(t, user) {
  t.mock.method(projects, 'getById', async () => structuredClone(ROW));
  const res = mockRes();
  await projectController.getProject({ params: { id: ROW.id }, query: {}, user }, res);
  assert.strictEqual(res.statusCode, 200);
  return res.body;
}

async function getList(t, user) {
  fakeWhereQuery(t, [structuredClone(ROW)]);
  const req = { query: querystring.parse(''), params: {}, headers: {}, header: () => undefined, user };
  const res = makeRes('test');
  await projectController.getProjects(req, res);
  assert.strictEqual(res.statusCode, 200);
  const rows = JSON.parse(res.body);
  assert.strictEqual(rows.length, 1);
  return rows[0];
}

/** Every top-level and `legislation_<year>` key of `body` among `fields`. */
const carried = (body, fields) => [
  ...fields.filter(field => Object.hasOwn(body, field)),
  ...Object.keys(body).filter(key => /^legislation_\d{4}$/.test(key))
    .flatMap(key => fields.filter(field => Object.hasOwn(body[key], field)).map(field => `${key}.${field}`))
];

test('staff fields on a project read', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  for (const [label, read] of [['GET', getOne], ['list', getList]]) {
    await t.test(`anonymous project ${label} returns none of the seven contact fields, at top level or in any legislation_<year> block`, async (t) => {
      const body = await read(t, ANONYMOUS);
      assert.strictEqual(body.name, 'Example Gold Mine');
      assert.strictEqual(body.legislation_2002.name, 'Example Gold Mine');
      assert.deepStrictEqual(carried(body, Object.keys(CONTACTS)), []);
    });

    await t.test(`anonymous ${label} has none of the four fields`, async (t) => {
      const body = await read(t, ANONYMOUS);
      assert.deepStrictEqual(carried(body, [...LEVEL_2_FIELDS, 'staffAssignments']), []);
    });
  }

  await t.test('a level 3 (idir) caller receives all seven and staffAssignments', async (t) => {
    const body = await getOne(t, IDIR);
    for (const [field, value] of Object.entries(CONTACTS)) {
      assert.strictEqual(body[field], value, field);
      assert.strictEqual(body.legislation_2018[field], value, `legislation_2018.${field}`);
    }
    assert.deepStrictEqual(body.staffAssignments, [ASSIGNMENT]);
  });

  await t.test('a level 3 caller receives no externalIds, capitalInvestments or staffNotes', async (t) => {
    assert.deepStrictEqual(carried(await getOne(t, IDIR), LEVEL_2_FIELDS), []);
  });

  await t.test('a staff GET has the four fields and the contacts', async (t) => {
    const body = await getOne(t, STAFF);
    for (const [field, value] of Object.entries(STAFF_HISTORY)) assert.deepStrictEqual(body[field], value, field);
    for (const [field, value] of Object.entries(CONTACTS)) assert.strictEqual(body[field], value, field);
  });
});

test('a sysadmin dial cannot raise a staff field above its cap', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const SYSADMIN = { realm_access: { roles: ['sysadmin'] } };
  const classify = async (field, level) => {
    t.mock.restoreAll();
    t.mock.method(projects, 'getById', async () => structuredClone(ROW));
    const patched = [];
    t.mock.method(projects, 'patchVis', async (id, vis) => { patched.push(vis); return ROW; });
    const res = mockRes();
    await projectController.setVisibility({ params: { id: ROW.id }, query: {}, body: { vis: { [field]: level } }, user: SYSADMIN }, res);
    return { status: res.statusCode, patched };
  };

  await t.test('a sysadmin dial cannot raise externalIds, capitalInvestments or staffNotes above 2', async () => {
    for (const field of LEVEL_2_FIELDS) {
      assert.deepStrictEqual(await classify(field, 3), { status: 400, patched: [] }, field);
      assert.strictEqual((await classify(field, 2)).status, 200, `${field} at its cap`);
    }
  });

  await t.test('a sysadmin dial cannot raise any contact field or staffAssignments above 3', async () => {
    for (const field of LEVEL_3_FIELDS) {
      assert.deepStrictEqual(await classify(field, 4), { status: 400, patched: [] }, field);
      assert.strictEqual((await classify(field, 3)).status, 200, `${field} at its cap`);
    }
  });
});

test('twin carry keeps all four', () => {
  const merged = carryDemiOnlyFields({ id: '412', trackProjectId: 412, name: 'Example Gold Mine' },
    { id: 'eagle-5850d1b4652f7e0019b52c0e', ...structuredClone(STAFF_HISTORY) }, TWIN_CARRY_FIELDS);
  for (const [field, value] of Object.entries(STAFF_HISTORY)) assert.deepStrictEqual(merged[field], value, field);
});

/** Stage `stored`, PUT `body`, and return the response plus what reached `upsert`. */
async function put(t, body, { user = STAFF, stored = ROW } = {}) {
  t.mock.method(projects, 'getById', async () => structuredClone(stored));
  let saved;
  t.mock.method(projects, 'upsert', async (doc) => { saved = doc; return doc; });
  const res = mockRes();
  await projectController.updateProject({ params: { id: stored.id }, query: {}, user, body }, res);
  return { res, saved };
}

test('PUT /projects/:id staff history', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('PUT refuses an edit or removal of any entry, and a client-set source or sheetKey', async (t) => {
    const refusals = {
      'an edited name': { staffAssignments: [{ ...ASSIGNMENT, name: 'Someone Else' }] },
      'a moved effectiveFrom': { capitalInvestments: [{ ...INVESTMENT, effectiveFrom: '2020-01-01' }] },
      'an edited note': { staffNotes: [{ ...NOTE, text: 'Rewritten' }] },
      'a removed entry': { staffNotes: [] },
      'a reordered pair': { staffNotes: [{ text: 'Second' }, NOTE] },
      'a client-set source': { staffNotes: [NOTE, { text: 'New', source: 'sheet' }] },
      'a client-set sheetKey': { staffAssignments: [ASSIGNMENT, { role: 'lead', name: 'Robin Example', sheetKey: 'k9' }] },
      'a client-set id': { staffNotes: [NOTE, { text: 'New', id: 'mine' }] },
      'a reopened close': { capitalInvestments: [{ ...INVESTMENT, effectiveTo: null }] },
      'a cleared field': { staffNotes: null }
    };
    const closed = { ...ROW, capitalInvestments: [{ ...INVESTMENT, effectiveTo: '2025-01-01' }] };
    for (const [label, body] of Object.entries(refusals)) {
      t.mock.restoreAll();
      const { res, saved } = await put(t, body, { stored: label === 'a reopened close' ? closed : ROW });
      assert.strictEqual(res.statusCode, 400, label);
      assert.strictEqual(saved, undefined, label);
    }
  });

  await t.test('PUT accepts an appended entry and a close', async (t) => {
    const { res, saved } = await put(t, {
      staffAssignments: [{ ...ASSIGNMENT, effectiveTo: '2026-11-10' }, { role: 'epd', name: 'Drew Placeholder', effectiveFrom: '2026-11-10' }],
      staffNotes: [NOTE, { text: 'Proponent replied' }]
    });
    assert.strictEqual(res.statusCode, 200);
    const [closed, added] = saved.staffAssignments;
    assert.deepStrictEqual(closed, { ...ASSIGNMENT, effectiveTo: '2026-11-10' });
    assert.match(added.id, /^[0-9a-f-]{36}$/);
    assert.deepStrictEqual({ ...added, id: 'x', recordedAt: 'x', observedAt: 'x' }, {
      id: 'x', role: 'epd', name: 'Drew Placeholder', effectiveFrom: '2026-11-10', effectiveTo: null,
      observedAt: 'x', source: 'demi', sheetKey: null, recordedAt: 'x'
    });
    assert.strictEqual(added.observedAt, added.recordedAt.slice(0, 10));
    assert.deepStrictEqual(saved.staffNotes[0], NOTE);
    assert.strictEqual(saved.staffNotes[1].source, 'demi');
    assert.deepStrictEqual(saved.capitalInvestments, [INVESTMENT], 'a field not sent is left as stored');
  });

  await t.test('PUT from a demi-service-write key is refused for the four fields', async (t) => {
    for (const field of Object.keys(STAFF_HISTORY)) {
      t.mock.restoreAll();
      const { res, saved } = await put(t, { [field]: structuredClone(STAFF_HISTORY[field]) }, { user: SERVICE_WRITE });
      assert.strictEqual(res.statusCode, 400, field);
      assert.match(res.body.error, new RegExp(`not writable by this caller: ${field}`), field);
      assert.strictEqual(saved, undefined, field);
    }
  });

  await t.test('PUT refuses a new external id while no cross-project check exists', async (t) => {
    const { res, saved } = await put(t, {
      externalIds: [...STAFF_HISTORY.externalIds, { system: 'eao-register', value: '413' }]
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(saved, undefined);
  });

  await t.test('PUT refuses a 201st entry', async (t) => {
    const notes = Array.from({ length: 200 }, (_, n) => ({ ...NOTE, id: `n${n}` }));
    const stored = { ...ROW, staffNotes: notes };
    const { res, saved } = await put(t, { staffNotes: [...notes, { text: 'One too many' }] }, { stored });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(saved, undefined);
  });

  await t.test('a staff-only change leaves dateUpdated and syncVersion alone', async (t) => {
    const native = {
      id: '0b6c3f1e-8d7a-4c1e-9f2a-3b4c5d6e7f80', name: 'Example Native', sourceSystem: 'demi', syncVersion: 3,
      dateUpdated: '2026-01-01T00:00:00.000Z', read: ['staff', 'sysadmin'], _etag: '"0x1"'
    };
    const { res, saved } = await put(t, { staffNotes: [{ text: 'First note' }] }, { stored: native });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(saved.staffNotes.length, 1);
    assert.strictEqual(saved.dateUpdated, native.dateUpdated);
    assert.strictEqual(saved.syncVersion, 3);
  });

  await t.test('validator errors carry no value', async (t) => {
    const SENTINEL = 'Zq9sentinel';
    const bodies = [
      { staffAssignments: [ASSIGNMENT, { role: 'epd', name: `${SENTINEL}\u0007` }] },
      { staffAssignments: [ASSIGNMENT, { role: SENTINEL, name: 'Robin Example' }] },
      { staffNotes: [NOTE, { text: SENTINEL.repeat(500) }] },
      { capitalInvestments: [INVESTMENT, { amountCad: SENTINEL }] },
      { staffAssignments: [{ ...ASSIGNMENT, name: SENTINEL }] },
      { capitalInvestments: [INVESTMENT, { amountCad: 5, effectiveFrom: '2026-01-02', effectiveTo: '2026-01-01', workId: SENTINEL }] }
    ];
    for (const body of bodies) {
      t.mock.restoreAll();
      const logged = [];
      t.mock.method(logger, 'warn', (...args) => logged.push(args));
      const { res } = await put(t, body);
      assert.strictEqual(res.statusCode, 400);
      assert.match(res.body.error, /^\w+\[\d+\]: /, 'names the field and the index');
      assert.ok(!JSON.stringify(res.body).includes(SENTINEL), res.body.error);
      assert.ok(logged.length > 0, 'the refusal is logged');
      assert.ok(!JSON.stringify(logged).includes(SENTINEL), 'the log carries no value');
    }
  });
});

test('observeInvestment', async (t) => {
  const RUN = '2026-11-12';
  const entry = (source, amountCad, extra = {}) => ({ ...INVESTMENT, id: `${source}-${amountCad}`, source, amountCad, ...extra });

  await t.test('observeInvestment writes nothing for an unchanged, null, 0 or unreadable value', () => {
    const entries = [entry('track', 5000, { effectiveTo: '2026-01-01' })];
    assert.strictEqual(observeInvestment(entries, 'track', 5000, RUN).status, 'unchanged', 'same as a closed latest');
    assert.strictEqual(observeInvestment(entries, 'track', '$5,000', RUN).status, 'unchanged');
    for (const value of [null, undefined, '', 0, '0']) {
      assert.strictEqual(observeInvestment(entries, 'track', value, RUN).status, 'empty', String(value));
    }
    for (const value of ['about 5 million', -5, Number.NaN, {}, '5e9', '$1,000.50']) {
      assert.strictEqual(observeInvestment(entries, 'track', value, RUN).status, 'unreadable', String(value));
    }
  });

  await t.test('observeInvestment gives effectiveFrom null only when the source has no entry, and the run date when all its entries are closed', () => {
    const first = observeInvestment([entry('sheet', 10)], 'track', 900.6, RUN);
    assert.strictEqual(first.append.effectiveFrom, null);
    assert.strictEqual(first.append.amountCad, 901);
    assert.strictEqual(first.close, undefined);
    const again = observeInvestment([entry('track', 10, { effectiveTo: '2026-01-01' })], 'track', 20, RUN);
    assert.strictEqual(again.append.effectiveFrom, RUN);
    assert.strictEqual(again.close, undefined);
  });

  await t.test('observeInvestment closes the open track entry on the run date and appends the new value, leaving eagle, sheet and demi entries alone', () => {
    const entries = [entry('sheet', 1), entry('track', 2), entry('eagle', 3), entry('demi', 4)];
    const result = observeInvestment(entries, 'track', '7,000', RUN);
    assert.strictEqual(result.status, 'append');
    assert.deepStrictEqual(result.close, { index: 1, id: 'track-2', effectiveTo: RUN });
    assert.deepStrictEqual({ ...result.append, id: 'x', recordedAt: 'x' }, {
      id: 'x', amountCad: 7000, effectiveFrom: RUN, effectiveTo: null, observedAt: RUN,
      workId: null, source: 'track', sheetKey: null, recordedAt: 'x'
    });
  });

  await t.test('observeInvestment writes nothing on a full list', () => {
    const full = Array.from({ length: 200 }, (_, n) => entry('sheet', n + 1));
    assert.strictEqual(observeInvestment(full, 'track', 5, RUN).status, 'full');
  });
});

test('currentInvestment takes the open demi entry first, then track, eagle, sheet', () => {
  const sheet = { ...INVESTMENT, source: 'sheet', amountCad: 1 };
  const eagle = { ...INVESTMENT, source: 'eagle', amountCad: 2 };
  const track = { ...INVESTMENT, source: 'track', amountCad: 3 };
  const demi = { ...INVESTMENT, source: 'demi', amountCad: 4 };
  const closedDemi = { ...demi, effectiveTo: '2026-01-01' };
  assert.strictEqual(currentInvestment([sheet, eagle, track, demi]), demi);
  assert.strictEqual(currentInvestment([sheet, eagle, track, closedDemi]), track);
  assert.strictEqual(currentInvestment([sheet, eagle, closedDemi]), eagle);
  assert.strictEqual(currentInvestment([sheet, closedDemi]), sheet);
  assert.strictEqual(currentInvestment([closedDemi]), null);
  assert.strictEqual(currentInvestment(undefined), null);
});
