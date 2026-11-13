'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const projectsRepo = require('../../src/repositories/projects');
const history = require('../../src/repositories/project-staff-history');
const catalog = require('../../src/vis/catalog/projects');
const { mirrorStore } = require('../helpers/mirror-store');

// buildCriteria rejects a field the caller cannot see, so an uncatalogued key would throw for every caller.
test('buildCriteria keys are all catalogued', () => {
  const fields = Object.keys(projectsRepo.CRITERIA_FIELDS);
  assert.deepStrictEqual(fields, ['regionalDistrict', 'municipality', 'electoralDistrict']);

  for (const field of fields) {
    assert.ok(catalog[field], `buildCriteria filters on '${field}', which has no catalog entry`);
  }
});

test('project short-code reads and writes', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('an owner is a project holding the code as current or legacy', async () => {
    let spec;
    t.mock.method(cosmos, 'query', async (_container, s) => { spec = s; return { items: [{ id: 207 }] }; });

    assert.deepStrictEqual(await projectsRepo.listShortCodeOwners('site-c'), ['207']);
    assert.match(spec.query, /c\.shortCode = @code OR ARRAY_CONTAINS\(c\.legacyShortCodes, @code\)/);
    assert.deepStrictEqual(spec.parameters, [{ name: '@code', value: 'site-c' }]);
    assert.doesNotMatch(spec.query, /c\.read/, 'an ownership check applies no visibility clause');
  });

  const stored = [
    { id: '310', read: ['compliance'], shortCode: 'sealed-site', legacyShortCodes: [] },
    { id: '312', shortCode: 'readless-site', legacyShortCodes: [] },
    { id: '311', read: ['public'], shortCode: 'other', legacyShortCodes: [] }
  ];
  /**
   * Cosmos as the ACL predicate would see it: a seal exclusion in the query hides a sealed row, and
   * on a row with no `read[]` the term is undefined, so that row drops out too.
   */
  const storedQuery = async (_container, spec) => {
    const code = spec.parameters.find(p => p.name === '@code').value;
    const sealed = /NOT ARRAY_CONTAINS\(c\.read, '([^']+)'\)/.exec(spec.query);
    const items = stored
      .filter(row => row.shortCode === code || row.legacyShortCodes.includes(code))
      .filter(row => !sealed || (row.read && !row.read.includes(sealed[1])))
      .map(row => ({ id: row.id }));
    return { items };
  };

  await t.test('a sealed project still owns its code', async () => {
    t.mock.method(cosmos, 'query', storedQuery);

    assert.deepStrictEqual(await projectsRepo.listShortCodeOwners('sealed-site'), ['310'],
      'a hidden owner would let PUT or DELETE /links repoint a sealed project\'s code');
  });

  await t.test('a project with no read[] still owns its code', async () => {
    t.mock.method(cosmos, 'query', storedQuery);

    assert.deepStrictEqual(await projectsRepo.listShortCodeOwners('readless-site'), ['312']);
  });

  await t.test('the patch sets only the three short-link fields, guarded on the etag', async () => {
    let call;
    t.mock.method(cosmos, 'patch', async (...args) => { call = args; return {}; });

    await projectsRepo.patchShortLink('eagle-1',
      { shortCode: 'site-c', shortCodeSource: 'name', legacyShortCodes: ['kq7bt2rm'], name: 'x' }, '"0x1"');

    assert.deepStrictEqual(call[3].map(op => op.path),
      ['/shortCode', '/shortCodeSource', '/legacyShortCodes']);
    assert.strictEqual(call[5], '"0x1"');
  });
});

test('upsert writes every sort field, so a Cosmos ORDER BY keeps the row', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  /** The item handed to Cosmos by an etag upsert. */
  async function written(project) {
    let item;
    t.mock.method(cosmos, 'upsert', async (_container, i) => { item = i; return i; });
    await projectsRepo.upsert(project, { etag: '"0x1"' });
    return item;
  }

  await t.test('an absent dateUpdated takes dateAdded as ISO with Z', async () => {
    const row = await written({ id: '207', name: 'Site C', dateAdded: 'Tue Mar 05 2019 10:00:00 GMT-0800 (Pacific Standard Time)' });

    assert.strictEqual(row.dateUpdated, '2019-03-05T18:00:00.000Z');
  });

  await t.test('an unparseable dateAdded gives a null dateUpdated', async () => {
    const row = await written({ id: '207', dateAdded: 'not a date', _ts: 1700000000 });

    assert.strictEqual(row.dateUpdated, null);
  });

  await t.test('no dateAdded gives a null dateUpdated, never one from _ts', async () => {
    const row = await written({ id: '207', _ts: 1700000000 });

    assert.strictEqual(row.dateUpdated, null);
  });

  await t.test('an existing dateUpdated is left alone', async () => {
    const row = await written({ id: '207', dateUpdated: '2026-01-02T03:04:05.000Z', dateAdded: 'Tue Mar 05 2019' });

    assert.strictEqual(row.dateUpdated, '2026-01-02T03:04:05.000Z');
  });

  await t.test('absent proponentName, projectType, sector and region are written as null', async () => {
    const row = await written({ id: '207' });

    assert.deepStrictEqual(
      [row.proponentName, row.projectType, row.sector, row.region], [null, null, null, null]);
  });

  await t.test('existing labels are left alone', async () => {
    const row = await written({ id: '207', proponentName: 'BC Hydro', projectType: 'Energy', sector: 'Dams', region: 'Peace' });

    assert.deepStrictEqual(
      [row.proponentName, row.projectType, row.sector, row.region], ['BC Hydro', 'Energy', 'Dams', 'Peace']);
  });

  await t.test('an absent currentPhaseName is written as an empty ref', async () => {
    const row = await written({ id: '207' });

    assert.deepStrictEqual(row.currentPhaseName, { _id: null, name: null });
  });

  await t.test('an existing currentPhaseName is left alone', async () => {
    const phase = { _id: '5cf00c03a266b7e1877504e9', name: 'Post Decision' };
    const row = await written({ id: '207', currentPhaseName: phase });

    assert.deepStrictEqual(row.currentPhaseName, phase);
  });

  await t.test('a create fills the same fields', async () => {
    let item;
    t.mock.method(cosmos, 'create', async (_container, i) => { item = i; return i; });
    await projectsRepo.upsert({ id: '207' }, { create: true });

    assert.deepStrictEqual(item.currentPhaseName, { _id: null, name: null });
    assert.strictEqual(item.sector, null);
  });

  await t.test('every SORTABLE key but name exists on a filled row', async () => {
    const row = await written({ id: '207' });
    const missing = projectsRepo.SORTABLE
      .filter(key => key !== 'name')
      .filter(key => key.split('.').reduce((v, part) => (v == null ? undefined : v[part]), row) === undefined);

    assert.deepStrictEqual(missing, []);
  });
});

test('patchVis derives activeWork from the works it is handed, else from the row', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const work = (trackWorkId) => ({ trackWorkId, workTypeId: 6, isActive: true, phases: [] });
  const patched = async (opts) => {
    const store = mirrorStore(t, [{ container: 'projects', id: '207', read: ['public'], works: [work(1)] }]);
    await projectsRepo.patchVis('207', { name: 4 }, opts);
    return store.rows('projects')[0].activeWork.trackWorkId;
  };

  await t.test('with inputsFor, from its works', async () => {
    assert.strictEqual(await patched({ inputsFor: async () => ({ worksForDerive: [work(2)] }) }), 2);
  });

  await t.test('without it, from the row works', async () => {
    assert.strictEqual(await patched(), 1);
  });
});

test('patchDerived stores composed works when worksForDerive is non-empty and leaves works alone when it is not', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const work = (trackWorkId) => ({ trackWorkId, workTypeId: 6, isActive: true, phases: [] });
  const storedWorks = async (worksForDerive) => {
    const store = mirrorStore(t, [{ container: 'projects', id: '207', read: ['public'], works: [work(1)] }]);
    await projectsRepo.patchDerived('207', { inputsFor: async () => ({ worksForDerive }) });
    return store.rows('projects')[0].works.map(w => w.trackWorkId);
  };

  assert.deepStrictEqual(await storedWorks([work(2)]), [2]);
  assert.deepStrictEqual(await storedWorks([]), [1]);
  assert.deepStrictEqual(await storedWorks(undefined), [1]);
});

test('project staff history writes', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const ORCS = { system: 'orcs', value: '12345-20/AB' };
  const entry = (id, extra = {}) => ({ id, role: 'epd', name: 'Pat Example', effectiveFrom: null, effectiveTo: null,
    source: 'sheet', sheetKey: 'k1', ...extra });
  const projectWrites = (store) => store.writes.filter(w => w.container === 'projects');

  /** The mirror, plus the holder query evaluated over its rows: case-blind on the value, as StringEquals(…, true). */
  const storeWithHolders = (rows) => {
    const store = mirrorStore(t, rows.map(row => ({ container: 'projects', read: ['public'], ...row })));
    const mirrored = cosmos.query;
    t.mock.method(cosmos, 'query', async (container, spec, opts) => {
      if (!spec.query.includes('StringEquals(x.value, @value, true)')) return mirrored(container, spec, opts);
      const param = (name) => spec.parameters.find(p => p.name === name).value;
      const items = store.rows(container)
        .filter(row => (row.externalIds || []).some(x => x.system === param('@system') &&
          x.value.toLowerCase() === param('@value').toLowerCase()))
        .map(({ id, eagleId, foldedInto }) => ({ id, eagleId, foldedInto }));
      return { items };
    });
    return store;
  };

  await t.test('the uniqueness query uses parameters', async () => {
    let spec;
    t.mock.method(cosmos, 'query', async (_container, s) => { spec = s; return { items: [] }; });

    assert.deepStrictEqual(await history.externalIdHolders(ORCS.system, ORCS.value), []);
    assert.ok(!spec.query.includes(ORCS.value) && !spec.query.includes(`'${ORCS.system}'`), spec.query);
    assert.deepStrictEqual(spec.parameters, [{ name: '@system', value: 'orcs' }, { name: '@value', value: ORCS.value }]);
    for (const [system, value] of [['orcs', ' 12345-20/AB'], ['eao-register', 412], ['orcs', '12345 20'], ['ORCS', ORCS.value], ['constructor', '1']]) {
      await assert.rejects(history.externalIdHolders(system, value), TypeError, `${system} ${value}: a padded, untyped or unknown pair could dodge the match`);
    }
  });

  await t.test('addExternalId refuses a value another project holds', async () => {
    const store = storeWithHolders([{ id: '207', externalIds: [{ ...ORCS, source: 'sheet' }] }, { id: '208' }]);

    for (const value of [ORCS.value, ORCS.value.toLowerCase()]) {
      assert.deepStrictEqual(await history.addExternalId('208', { system: 'orcs', value, source: 'sheet' }), { status: 'conflict' });
    }
    assert.deepStrictEqual(projectWrites(store), []);
    assert.deepStrictEqual(await history.addExternalId('208', { system: 'orcs', value: '12345-20/AC', source: 'sheet' }),
      { status: 'set' });
  });

  await t.test("a folded twin's external id is not a conflict", async () => {
    const [folded, linked, other] = ['a', 'b', 'c'].map(letter => letter.repeat(24));
    const holding = (value) => ({ externalIds: [{ system: 'orcs', value, source: 'sheet' }] });
    const track = (id) => ({ sources: { track: { track_project_id: Number(id) } } });
    storeWithHolders([
      { id: `eagle-${folded}`, eagleId: folded, foldedInto: '207', ...holding('11111-01') },
      { id: '207' },
      { id: '208' },
      { id: `eagle-${linked}`, eagleId: linked, ...holding('22222-02') },
      { id: '209', eagleId: linked, ...track(209) },
      { id: '210', eagleId: other, ...track(210), ...holding('33333-03') },
      { id: '200', eagleId: other, ...track(200) }
    ]);
    const add = (id, value) => history.addExternalId(id, { system: 'orcs', value, source: 'sheet' });

    assert.deepStrictEqual((await add('207', '11111-01')).status, 'set', 'the row a twin folded into');
    assert.deepStrictEqual((await add('209', '22222-02')).status, 'set', 'the row a twin\'s Eagle id names');
    assert.deepStrictEqual((await add('208', '22222-02')).status, 'conflict', 'a twin\'s id is still held');
    assert.deepStrictEqual((await add('200', '33333-03')).status, 'conflict',
      'an Eagle id set on another row must not hide a non-twin holder');
  });

  await t.test('a full list takes no loader append', async () => {
    const notes = Array.from({ length: 200 }, (_, n) => entry(`n${n}`));
    const store = storeWithHolders([{ id: '207', staffNotes: notes, externalIds: notes.map((_, n) => ({ system: 'eao-register', value: String(n + 1) })) }]);

    assert.strictEqual((await history.appendHistory('207', 'staffNotes', entry('n200'))).status, 'full');
    assert.strictEqual((await history.addExternalId('207', { system: 'eao-register', value: '999', source: 'sheet' })).status, 'full');
    assert.deepStrictEqual(projectWrites(store), []);
  });

  await t.test('an unrelated row write between read and patch costs one retry, not a failure', async () => {
    const store = storeWithHolders([{ id: '207', name: 'North Pit', updatedAt: 'u1', staffAssignments: [] }]);
    const mirrored = cosmos.patch;
    let patches = 0;
    t.mock.method(cosmos, 'patch', async (...args) => {
      if (patches++ === 0) await cosmos.upsert('projects', { ...store.rows('projects')[0], name: 'Renamed' });
      return mirrored(...args);
    });

    assert.deepStrictEqual(await history.appendHistory('207', 'staffAssignments', entry('e1')), { status: 'appended' });
    const row = store.rows('projects')[0];
    assert.strictEqual(patches, 2);
    assert.deepStrictEqual([row.name, row.updatedAt, row.staffAssignments.map(e => e.id)], ['Renamed', 'u1', ['e1']]);
  });

  await t.test('appendHistory with a close applies both in one patch; a 412 on every retry leaves the entry open and nothing appended', async () => {
    const amount = (id, extra) => ({ id, amountCad: 10, effectiveFrom: null, effectiveTo: null, source: 'track', ...extra });
    const store = storeWithHolders([{ id: '207', capitalInvestments: [amount('old')] }]);
    const close = { id: 'old', effectiveTo: '2026-11-01' };

    const mirrored = cosmos.patch;
    t.mock.method(cosmos, 'patch', async () => { throw Object.assign(new Error('precondition failed'), { code: 412 }); });
    assert.deepStrictEqual(await history.appendHistory('207', 'capitalInvestments', amount('new'), close), { status: 'conflict' });
    assert.deepStrictEqual(store.rows('projects')[0].capitalInvestments.map(e => [e.id, e.effectiveTo]), [['old', null]]);

    t.mock.method(cosmos, 'patch', mirrored);
    assert.deepStrictEqual(await history.appendHistory('207', 'capitalInvestments', amount('new'), close), { status: 'appended' });
    assert.strictEqual(projectWrites(store).length, 1);
    assert.deepStrictEqual(store.rows('projects')[0].capitalInvestments.map(e => [e.id, e.effectiveTo]),
      [['old', '2026-11-01'], ['new', null]]);
  });

  await t.test('removeHistory leaves an entry staff edited and returns changed', async () => {
    const backup = entry('e1');
    const store = storeWithHolders([{ id: '207', staffNotes: [{ ...backup, name: 'Pat Edited' }, entry('e2')] }]);

    assert.deepStrictEqual(await history.removeHistory('207', 'staffNotes', 'e1', history.historyEntrySha256(backup)),
      { status: 'changed' });
    assert.deepStrictEqual(projectWrites(store), []);
    const e2 = store.rows('projects')[0].staffNotes[1];
    assert.deepStrictEqual(await history.removeHistory('207', 'staffNotes', 'e2', history.historyEntrySha256(e2)),
      { status: 'removed' });
    assert.deepStrictEqual(store.rows('projects')[0].staffNotes.map(e => e.name), ['Pat Edited']);
  });

  await t.test('loader calls never touch an entry with source demi', async () => {
    const staff = entry('s1', { source: 'demi' });
    const store = storeWithHolders([{ id: '207', externalIds: [{ ...ORCS, source: 'demi' }], staffAssignments: [staff] }]);

    const results = [
      await history.removeExternalId('207', ORCS),
      await history.closeHistory('207', 'staffAssignments', 's1', '2026-11-01'),
      await history.removeHistory('207', 'staffAssignments', 's1', history.historyEntrySha256(staff)),
      await history.appendHistory('207', 'staffAssignments', entry('e9'), { id: 's1', effectiveTo: '2026-11-01' })
    ].map(r => r.status);

    assert.deepStrictEqual(results, ['changed', 'changed', 'changed', 'changed']);
    await assert.rejects(history.appendHistory('207', 'staffAssignments', entry('e9', { source: 'demi' })), TypeError);
    assert.deepStrictEqual(projectWrites(store), []);
  });
});
