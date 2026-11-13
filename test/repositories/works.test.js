'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const cosmos = require('../../src/db/cosmos-nosql');
const config = require('../../src/config');
const projects = require('../../src/repositories/projects');
const works = require('../../src/repositories/works');
const { syncWorkDocs } = require('../../src/scripts/sync-works');
const { writeTrackRecord } = require('../../src/scripts/track-record-write');
const { mirrorStore } = require('../helpers/mirror-store');

const ROOT = path.join(__dirname, '..', '..');
const WORKS_MODULE = path.join(ROOT, 'src', 'repositories', 'works');

/** Works have no read[], so every file that loads them is a gate decision, named here. */
const MAY_REQUIRE = new Set([
  'src/controllers/nosql/works-staff.js',
  'src/domain/works-derive.js',
  'src/scripts/check-business-works-parity.js',
  'src/scripts/check-works-parity.js',
  'src/scripts/date-assessment-phases.js',
  'src/scripts/load-business-works.js',
  'src/scripts/rollback-business-works.js',
  'src/scripts/sync-works.js',
  'src/scripts/track-record-write.js'
].map(file => path.join(ROOT, ...file.split('/'))));

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

const requiresWorks = (file) => [...fs.readFileSync(file, 'utf8').matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)]
  .some(([, spec]) => path.resolve(path.dirname(file), spec).replace(/\.js$/, '') === WORKS_MODULE);

test('works.js is required only by the project read and the works writers', () => {
  const callers = [...sourceFiles(path.join(ROOT, 'src')), ...sourceFiles(path.join(ROOT, 'api'))]
    .filter(requiresWorks)
    .filter(file => !MAY_REQUIRE.has(file))
    .map(file => path.relative(ROOT, file));

  assert.deepStrictEqual(callers, []);
});

/** The works container of a mirror store over {rows}; `queries` holds the ids each query returned. */
function store(t, rows) {
  const mirror = mirrorStore(t, rows.map(row => ({ container: 'works', ...row })));
  const query = cosmos.query;
  const queries = [];
  t.mock.method(cosmos, 'query', async (...args) => {
    const page = await query(...args);
    queries.push(page.items.map(row => row.id));
    return page;
  });
  const read = (id) => structuredClone(mirror.rows('works').find(row => row.id === id));
  return { queries, read, rows: () => mirror.rows('works') };
}

const TRACK = { id: 'track-1', projectId: 'p1', source: 'track', owner: 'track', simpleTitle: 'North Pit', phases: [] };
const LEGACY_TRACK = { id: 'track-2', projectId: 'p1', simpleTitle: 'Older', phases: [] };
const SHEET = { id: 'sheet-a', projectId: 'p1', source: 'sheet', owner: 'sheet', sourceKey: '8:assessment:x',
  phases: [{ id: 'pre-ea', trackPhaseId: 3001, milestones: [] }] };
const ADOPTED = { ...TRACK, id: 'track-3', owner: 'demi', provenance: { adoptedBy: 'staff', adoptedAt: '2026-01-01' } };
const TOMBSTONE = { id: 'track-4', projectId: 'p1', deleted: true, pushStamps: { work: 5 } };
const MARKER = { id: 'sheet-override', projectId: 'p1', kind: 'override', source: 'sheet', owner: 'sheet', active: true };

const ids = (rows) => rows.map(row => row.id);

test('works repository', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('listByProject and listForRead queries exclude deleted documents', async (t) => {
    store(t, [TRACK, TOMBSTONE]);

    const live = await works.listByProject('p1');
    const read = await works.listForRead('p1');
    const all = await works.listByProject('p1', { includeDeleted: true });

    assert.deepStrictEqual([ids(live), ids(read), ids(all)], [['track-1'], ['track-1'], ['track-1', 'track-4']]);
  });

  await t.test('listByProject and listForRead leave out the override marker; get returns it', async (t) => {
    store(t, [TRACK, MARKER]);

    const listed = [await works.listByProject('p1', { includeDeleted: true }), await works.listForRead('p1')];

    assert.deepStrictEqual(listed.map(ids), [['track-1'], ['track-1']]);
    assert.strictEqual((await works.get('p1', 'sheet-override')).active, true);
  });

  await t.test('a Track document with no owner field is found by the owner track filter', async (t) => {
    store(t, [TRACK, LEGACY_TRACK, SHEET, ADOPTED, { id: 'sheet-b', projectId: 'p1', source: 'sheet' }]);

    assert.deepStrictEqual(ids(await works.listByProject('p1', { owner: 'track' })), ['track-1', 'track-2']);
    assert.deepStrictEqual(ids(await works.listByProject('p1', { owner: 'sheet' })), ['sheet-a', 'sheet-b']);
  });

  await t.test('the nightly and workIdOf queries return no sheet document', async (t) => {
    const held = config.worksWrite;
    config.worksWrite = true;
    t.after(() => { config.worksWrite = held; });
    t.mock.method(projects, 'readForWrite', async () => ({ id: 'p1', sources: { track: {} } }));
    const cosmosStore = store(t, [TRACK, SHEET]);

    await syncWorkDocs('p1', [], { live: false });
    await writeTrackRecord('phase', 'DELETE', 'p1', { pushedAt: 1, id: 3001 });

    assert.deepStrictEqual(cosmosStore.queries, [['track-1'], ['track-1']]);
  });

  await t.test('listForRead returns no sourceKey, sourceRef (any depth) or provenance key and keeps simpleTitle and eaActId',
    async (t) => {
      const sourceRef = { sheet: { file: '01', sheet: 'Projects', row: 12, slot: 1 } };
      store(t, [{ ...SHEET, simpleTitle: 'Mine', eaActId: 3, sourceRef, provenance: { batchId: 'b1' },
        phases: [{ id: 'pre-ea', sourceRef, milestones: [{ id: 'start', sourceRef }],
          interruptions: [{ id: 'extension', sourceRef }] }] }]);

      const [doc] = await works.listForRead('p1');

      assert.doesNotMatch(JSON.stringify(doc), /sourceKey|sourceRef|provenance/);
      assert.deepStrictEqual([doc.simpleTitle, doc.eaActId, doc.phases[0].milestones[0].id], ['Mine', 3, 'start']);
    });

  await t.test('save refuses a document another owner holds', async (t) => {
    const cosmosStore = store(t, [ADOPTED, SHEET]);
    const adopted = cosmosStore.read('track-3');
    const sheet = cosmosStore.read('sheet-a');

    // The Track-owned revision a writer read before the work was adopted, paired with the adopted revision's etag.
    const readBefore = { ...adopted, owner: 'track', _etag: '"older"' };

    const answers = [
      await works.save({ ...adopted, simpleTitle: 'Track' }, { owner: 'track', etag: adopted._etag, existing: adopted }),
      await works.save({ ...sheet, title: 'Track' }, { owner: 'track', etag: sheet._etag, existing: sheet }),
      await works.tombstone(sheet, { owner: 'track', etag: sheet._etag }),
      await works.save({ ...adopted, simpleTitle: 'Track' }, { owner: 'track', etag: adopted._etag, existing: readBefore })
    ];

    assert.deepStrictEqual(answers.map(a => a.status), ['foreign', 'foreign', 'foreign', 'foreign']);
    assert.deepStrictEqual([cosmosStore.read('track-3').simpleTitle, cosmosStore.read('sheet-a').deleted],
      ['North Pit', undefined]);
  });

  await t.test('save refuses a document whose id or project differs from the one it read', async (t) => {
    const cosmosStore = store(t, [TRACK]);
    const current = cosmosStore.read('track-1');
    const guard = { owner: 'track', etag: current._etag, existing: current };

    const answers = [
      await works.save({ ...current, id: 'track-9' }, guard),
      await works.save({ ...current, projectId: 'p2' }, guard)
    ];

    assert.deepStrictEqual(answers.map(a => a.status), ['foreign', 'foreign']);
    assert.deepStrictEqual(cosmosStore.rows().map(row => [row.id, row.projectId]), [['track-1', 'p1']]);
    await assert.rejects(works.save(current, { owner: 'track', etag: current._etag }), /needs the existing document/);
  });

  await t.test('sheet owner cannot create track-1', async (t) => {
    const cosmosStore = store(t, []);

    const answers = [
      await works.save({ ...TRACK, source: 'sheet', owner: 'sheet' }, { owner: 'sheet' }),
      await works.save({ ...TRACK }, { owner: 'sheet' }),
      await works.save({ ...SHEET, owner: 'track' }, { owner: 'track' }),
      await works.save({ ...TRACK, id: 'track' }, { owner: 'track' })
    ];

    assert.deepStrictEqual(answers.map(a => a.status), ['foreign', 'foreign', 'foreign', 'foreign']);
    assert.deepStrictEqual(cosmosStore.rows(), []);
  });

  await t.test('save answers a create and an update with the stored etag', async (t) => {
    const cosmosStore = store(t, [TRACK]);
    const current = cosmosStore.read('track-1');
    const updated = await works.save({ ...current, simpleTitle: 'Renamed' }, { owner: 'track', etag: current._etag, existing: current });
    assert.deepStrictEqual(updated, { status: 'written', etag: cosmosStore.read('track-1')._etag });
    const created = await works.save({ ...SHEET }, { owner: 'sheet' });
    assert.deepStrictEqual(created, { status: 'written', etag: cosmosStore.read(SHEET.id)._etag });
  });

  await t.test('update cannot change source or owner', async (t) => {
    const cosmosStore = store(t, [LEGACY_TRACK, ADOPTED]);
    const legacy = cosmosStore.read('track-2');
    const adopted = cosmosStore.read('track-3');

    await works.save({ ...legacy, source: 'sheet', owner: 'sheet', provenance: { adoptedBy: 'x' } },
      { owner: 'track', etag: legacy._etag, existing: legacy });
    await works.save({ ...adopted, source: 'demi', owner: 'track', provenance: { batchId: 'b2' } },
      { owner: 'demi', etag: adopted._etag, existing: adopted });

    const { source, owner, provenance } = cosmosStore.read('track-2');
    assert.deepStrictEqual({ source, owner, provenance }, { source: 'track', owner: 'track', provenance: {} });
    const kept = cosmosStore.read('track-3');
    assert.deepStrictEqual([kept.source, kept.owner, kept.provenance],
      ['track', 'demi', { batchId: 'b2', adoptedBy: 'staff', adoptedAt: '2026-01-01' }]);
  });

  await t.test('ownerOf returns null for an unknown id and every write refuses', async (t) => {
    const unknown = { id: 'eagle-9', projectId: 'p1', title: 'Unowned' };
    const cosmosStore = store(t, [unknown]);
    const current = cosmosStore.read('eagle-9');

    assert.strictEqual(works.ownerOf(current), null);
    for (const owner of ['track', 'sheet', 'demi', null, undefined]) {
      const answers = [
        await works.save({ ...current, title: 'Changed' }, { owner, etag: current._etag, existing: current }),
        await works.tombstone(current, { owner, etag: current._etag }),
        await works.remove(current, { owner, etag: current._etag })
      ];
      assert.deepStrictEqual(answers.map(a => a.status), ['foreign', 'foreign', 'foreign'], `owner ${owner}`);
    }
    assert.strictEqual(cosmosStore.read('eagle-9').title, 'Unowned');
  });

  await t.test('tombstone keeps source and owner', async (t) => {
    const cosmosStore = store(t, [{ ...SHEET, pushStamps: { work: 1 }, provenance: { batchId: 'b1' } }, LEGACY_TRACK]);
    const sheet = cosmosStore.read('sheet-a');
    const legacy = cosmosStore.read('track-2');

    await works.tombstone(sheet, { owner: 'sheet', etag: sheet._etag });
    await works.tombstone(legacy, { owner: 'track', etag: legacy._etag });

    const { _etag: _sheetEtag, ...sheetTomb } = cosmosStore.read('sheet-a');
    assert.deepStrictEqual(sheetTomb, { id: 'sheet-a', projectId: 'p1', deleted: true, pushStamps: { work: 1 },
      source: 'sheet', owner: 'sheet', sourceKey: '8:assessment:x', provenance: { batchId: 'b1' } });
    const { _etag: _legacyEtag, ...legacyTomb } = cosmosStore.read('track-2');
    assert.deepStrictEqual(legacyTomb, { id: 'track-2', projectId: 'p1', deleted: true, source: 'track', owner: 'track' });
  });

  await t.test('remove refuses a foreign or stale document', async (t) => {
    const cosmosStore = store(t, [SHEET]);
    const sheet = cosmosStore.read('sheet-a');

    assert.deepStrictEqual(await works.remove(sheet, { owner: 'track', etag: sheet._etag }), { status: 'foreign' });
    await assert.rejects(works.remove(sheet, { owner: 'sheet', etag: '"older"' }), { code: 412 });
    assert.ok(cosmosStore.read('sheet-a'));
    assert.deepStrictEqual(await works.remove(sheet, { owner: 'sheet', etag: sheet._etag }), { status: 'removed' });
    assert.strictEqual(cosmosStore.read('sheet-a'), undefined);
  });

  await t.test('findBySourceKey finds a tombstone and refuses a missing key or one held twice', async (t) => {
    store(t, [{ ...SHEET, deleted: true }, TRACK]);

    assert.strictEqual((await works.findBySourceKey('p1', '8:assessment:x')).id, 'sheet-a');
    assert.strictEqual(await works.findBySourceKey('p1', 'none'), null);
    for (const missing of [undefined, null, '']) await assert.rejects(works.findBySourceKey('p1', missing), TypeError);
    await cosmos.create('works', { ...SHEET, id: 'sheet-b' });
    await assert.rejects(works.findBySourceKey('p1', '8:assessment:x'), { code: 'DUPLICATE_SOURCE_KEY' });
  });

  await t.test('a save on a stale etag is a 412 and leaves the stored work alone', async (t) => {
    const cosmosStore = store(t, [TRACK]);
    const older = { ...cosmosStore.read('track-1'), _etag: '"older"' };

    await assert.rejects(
      works.save({ ...older, simpleTitle: 'Older' }, { owner: 'track', etag: older._etag, existing: older }),
      { code: 412 }
    );
    assert.strictEqual(cosmosStore.read('track-1').simpleTitle, 'North Pit');
  });

  await t.test('liveProjectIds reads only projectId of live works, marker left out, owner filter kept', async (t) => {
    mirrorStore(t, [TRACK, { ...LEGACY_TRACK, projectId: 'p2' }, { ...TOMBSTONE, projectId: 'p3' }, MARKER,
      { ...SHEET, projectId: 'p4' }].map(row => ({ container: 'works', ...row })));
    const query = cosmos.query;
    const projections = [];
    // The fake runs the WHERE clause on whole rows; the projection is checked here and applied after it.
    t.mock.method(cosmos, 'query', async (container, spec, opts) => {
      const [projection] = spec.query.match(/^SELECT VALUE c\.projectId FROM c WHERE /) || [];
      projections.push(projection);
      const page = await query(container, { ...spec, query: spec.query.replace(projection, 'SELECT * FROM c WHERE ') }, opts);
      return { ...page, items: page.items.map(row => row.projectId) };
    });

    const all = await works.liveProjectIds();
    const track = await works.liveProjectIds({ owner: 'track' });

    assert.deepStrictEqual([all.sort(), track.sort()], [['p1', 'p2', 'p4'], ['p1', 'p2']]);
    assert.ok(projections.every(Boolean), 'SELECT VALUE c.projectId only');
    await assert.rejects(works.liveProjectIds({ owner: '' }), TypeError);
  });
});
