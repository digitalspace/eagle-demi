'use strict';

/**
 * `tags` on a project row: former and alternate names DEMI owns. Only `PUT /projects/:id` writes
 * them, so the PUT validates them and every rebuild of the row from a feed (the Eagle push) has to
 * carry them across, or the next push quietly erases what staff typed.
 */

process.env.NODE_ENV = 'test';
// Before src/config is first required: the audit writer is inert without them. A batch of 1 makes
// enqueue flush through the stub transport synchronously, so the row is there when the PUT returns.
process.env.AUDIT_DCR_ENDPOINT = 'https://dcr-test.canadacentral-1.ingest.monitor.azure.com';
process.env.AUDIT_DCR_IMMUTABLE_ID = 'dcr-testimmutableid';
process.env.AUDIT_MAX_BATCH = '1';

const test = require('node:test');
const assert = require('node:assert');

const audit = require('../../../src/utils/audit');
const { logger } = require('../../../src/utils/logger');
const projects = require('../../../src/repositories/projects');
const projectController = require('../../../src/controllers/nosql/project');
const {
  mockRes, STAFF, PROJECT_EAGLE_ID, eagleProject, storedEagleProject, projectReadForWriteFromGet
} = require('../../helpers/eagle-mirror-fixtures');

// Audit rows go nowhere unless a test asks for them; never to the network.
audit._setTransport(async () => {});

// Level 2, the tier every write role maps to: the caller `requireWrite` actually admits.
const WRITER = { realm_access: { roles: ['demi-service-write'] } };

/** Stage the stored row and capture what the PUT writes. `saved()` is undefined when nothing was. */
function stage(t, stored) {
  t.mock.method(projects, 'getById', async () => structuredClone(stored));
  let saved;
  t.mock.method(projects, 'upsert', async (doc) => { saved = doc; return doc; });
  return { saved: () => saved };
}

const put = async (body, user = WRITER, id = '207') => {
  const res = mockRes();
  await projectController.updateProject({ params: { id }, query: {}, user, body }, res);
  return res;
};

const STORED = { id: '207', trackProjectId: 207, name: 'Site C Clean Energy', _etag: '"0x1"' };

// Built from code points so the characters under test are visible in this file.
const ZWSP = String.fromCharCode(0x200B);
const ZWJ = String.fromCharCode(0x200D);
const WORD_JOINER = String.fromCharCode(0x2060);
const COMBINING_ACUTE = String.fromCharCode(0x0301);
const E_ACUTE = String.fromCharCode(0x00E9);

test('PUT /projects/:id tags', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a string instead of a list is a 400 and no write', async () => {
    const store = stage(t, STORED);

    const res = await put({ tags: 'Peace River Site C' });

    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /tags/);
    assert.strictEqual(store.saved(), undefined);
  });

  await t.test('null is a 400, not a clear', async () => {
    const store = stage(t, { ...STORED, tags: ['Peace River Site C'] });

    const res = await put({ tags: null });

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(store.saved(), undefined);
  });

  await t.test('a non-string element is a 400 and no write', async () => {
    const store = stage(t, STORED);

    const res = await put({ tags: ['Peace River Site C', 7] });

    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /tags/);
    assert.strictEqual(store.saved(), undefined);
  });

  await t.test('21 distinct tags is a 400 and no write', async () => {
    const store = stage(t, STORED);
    const tags = Array.from({ length: 21 }, (_, i) => `Name ${i + 1}`);

    const res = await put({ tags });

    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /20/);
    assert.strictEqual(store.saved(), undefined);
  });

  await t.test('the limit counts what is left after dedupe, so 21 with one repeat is 20 and fine', async () => {
    const store = stage(t, STORED);
    const tags = [...Array.from({ length: 20 }, (_, i) => `Name ${i + 1}`), 'NAME 1'];

    const res = await put({ tags });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(store.saved().tags.length, 20);
    assert.strictEqual(store.saved().tags[0], 'Name 1');
    assert.strictEqual(store.saved().tags[19], 'Name 20');
  });

  await t.test('a tag of 101 characters is a 400 and no write', async () => {
    const store = stage(t, STORED);

    const res = await put({ tags: ['x'.repeat(101)] });

    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /100/);
    assert.strictEqual(store.saved(), undefined);
  });

  await t.test('the length limit applies after the trim', async () => {
    const store = stage(t, STORED);

    const res = await put({ tags: [`  ${'x'.repeat(100)}  `] });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(store.saved().tags, ['x'.repeat(100)]);
  });

  await t.test('tags are trimmed, blanks dropped, and a case-insensitive repeat keeps the first spelling',
    async () => {
      const store = stage(t, STORED);

      const res = await put({
        tags: ['  Site C ', '', '   ', 'site c', 'Peace River Site C', 'SITE C']
      });

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(store.saved().tags, ['Site C', 'Peace River Site C']);
      assert.deepStrictEqual(res.body.tags, ['Site C', 'Peace River Site C'],
        'the caller is handed back what was stored, not what was sent');
    });

  await t.test('an empty list clears the stored tags', async () => {
    const store = stage(t, { ...STORED, tags: ['Peace River Site C'] });

    const res = await put({ tags: [] });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(store.saved().tags, []);
  });

  await t.test('an edit that does not mention tags leaves them alone', async () => {
    const store = stage(t, { ...STORED, tags: ['Peace River Site C'] });

    const res = await put({ description: 'A dam on the Peace River' });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(store.saved().tags, ['Peace River Site C']);
  });

  await t.test('a decomposed accent is stored composed (NFC)', async () => {
    const store = stage(t, STORED);

    const res = await put({ tags: [`Cafe${COMBINING_ACUTE} Creek`] });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(store.saved().tags, [`Caf${E_ACUTE} Creek`]);
  });

  await t.test('zero-width characters are removed', async () => {
    const store = stage(t, STORED);

    const res = await put({ tags: [`Site${ZWSP} C`, `${WORD_JOINER}Peace${ZWJ} River`] });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(store.saved().tags, ['Site C', 'Peace River']);
  });

  await t.test('a run of inner whitespace becomes one space', async () => {
    const store = stage(t, STORED);

    const res = await put({ tags: ['Peace   River\t\nSite C'] });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(store.saved().tags, ['Peace River Site C']);
  });

  await t.test('spellings that differ only by NFC, zero-width or spacing collapse to the first', async () => {
    const store = stage(t, STORED);

    const res = await put({ tags: [
      `Caf${E_ACUTE} Creek`, `Cafe${COMBINING_ACUTE} Creek`, `Caf${E_ACUTE}${ZWSP} Creek`, ` caf${E_ACUTE}   creek `
    ] });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(store.saved().tags, [`Caf${E_ACUTE} Creek`]);
  });

  await t.test('the 100-character limit counts the cleaned tag', async () => {
    const store = stage(t, STORED);
    // 106 characters as sent: 100 after the zero-width characters go and the run of spaces collapses.
    const sent = `${'x'.repeat(50)}${ZWSP}${ZWSP}${ZWSP}   ${'y'.repeat(49)}`;

    const res = await put({ tags: [sent] });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(store.saved().tags, [`${'x'.repeat(50)} ${'y'.repeat(49)}`]);
  });

  await t.test('the 20-tag limit counts after cleaning, so 21 that clean to 20 are fine', async () => {
    const store = stage(t, STORED);
    const tags = [...Array.from({ length: 20 }, (_, i) => `Name ${i + 1}`), `Name${ZWSP}   1`];

    const res = await put({ tags });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(store.saved().tags.length, 20);
  });

  await t.test('a caller below the dialled level of tags is refused', async () => {
    // The per-record dial puts tags at level 1, so the level-2 writer cannot see them, and a field
    // a caller cannot see is a field they cannot set.
    const store = stage(t, { ...STORED, tags: ['Peace River Site C'], vis: { tags: 1 } });

    const res = await put({ tags: ['Something else'] });

    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /tags/);
    assert.strictEqual(store.saved(), undefined);
  });
});

test('PUT /eagle/projects/:eagleId keeps the stored tags', async (t) => {
  t.beforeEach(() => projectReadForWriteFromGet(t));
  t.afterEach(() => t.mock.restoreAll());

  /** Push a renamed Eagle record over `existing` and return the row the push wrote. */
  async function pushOver(existing) {
    t.mock.method(projects, 'getByEagleId', async () => structuredClone(existing));
    let written;
    t.mock.method(projects, 'upsert', async (item) => { written = item; return item; });

    const res = mockRes();
    await projectController.upsertFromEagle({
      params: { eagleId: PROJECT_EAGLE_ID }, query: {}, user: STAFF,
      body: { doc: eagleProject({ name: 'Nicomen Wind Energy Project' }) }
    }, res);
    return { res, written };
  }

  await t.test('on a Track-matched row', async () => {
    const { res, written } = await pushOver(storedEagleProject({ tags: ['Nicomen Wind'] }));

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(written.id, '207', 'the premise: the Track-matched merge ran');
    assert.deepStrictEqual(written.tags, ['Nicomen Wind']);
  });

  await t.test('on an Eagle-only row', async () => {
    const { res, written } = await pushOver({
      id: `eagle-${PROJECT_EAGLE_ID}`,
      eagleId: PROJECT_EAGLE_ID,
      sourceSystem: 'eagle',
      isPublished: true,
      read: ['public', 'sysadmin', 'staff'],
      sources: { eagle: { _id: PROJECT_EAGLE_ID, name: 'Nicomen Wind Energy' } },
      tags: ['Nicomen Wind']
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(written.id, `eagle-${PROJECT_EAGLE_ID}`, 'the premise: the Eagle-only merge ran');
    assert.strictEqual(written.name, 'Nicomen Wind Energy Project', 'the premise: the row was rebuilt');
    assert.deepStrictEqual(written.tags, ['Nicomen Wind']);
  });
});

test('the audit row of a PUT names tags only when they changed', async (t) => {
  t.afterEach(() => {
    t.mock.restoreAll();
    audit._setTransport(async () => {});
  });

  /** The `Detail.fields` of the one audit row a PUT over `stored` records. */
  async function auditedFields(stored, body) {
    const rows = [];
    audit._setTransport(async (_stream, batch) => { rows.push(...batch); });
    stage(t, stored);

    const res = await put(body);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(rows.length, 1, 'the premise: one audit row per PUT');
    return rows[0].Detail.fields;
  }

  await t.test('tags that clean to what is stored are left out', async () => {
    const fields = await auditedFields({ ...STORED, tags: ['Site C'] },
      { tags: [`  Site${ZWSP} C `], description: 'A dam' });

    assert.deepStrictEqual(fields, ['description']);
  });

  await t.test('tags that differ from what is stored are named', async () => {
    const fields = await auditedFields({ ...STORED, tags: ['Site C'] }, { tags: ['Site C', 'Peace River'] });

    assert.deepStrictEqual(fields, ['tags']);
  });
});

// A Track project and the `eagle-<id>` row the Track relink keeps beside it are one project to a
// reader, so a name set on either has to find both.
test('PUT /projects/:id tags reach the other row of a Track/Eagle pair', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const TWIN_ID = `eagle-${PROJECT_EAGLE_ID}`;
  const TRACK_ROW = { id: '207', trackProjectId: 207, eagleId: PROJECT_EAGLE_ID, name: 'Nicomen Wind', _etag: '"t1"' };
  const TWIN_ROW = { id: TWIN_ID, eagleId: PROJECT_EAGLE_ID, sourceSystem: 'eagle', name: 'Nicomen Wind', _etag: '"e1"' };

  /**
   * A projects container in memory. `refuse` names a row whose every write fails with `refuseCode`
   * (default 412, a lost etag race). `afterWrite` is awaited after each write, to interleave PUTs.
   * `written` lists the ids written, in order.
   */
  function pairStore(rows, { refuse, refuseCode = 412, afterWrite = async () => {} } = {}) {
    const byId = new Map(rows.map(row => [row.id, structuredClone(row)]));
    const written = [];
    const read = (id) => structuredClone(byId.get(String(id)) ?? null);
    t.mock.method(projects, 'getById', async (_access, id) => read(id));
    t.mock.method(projects, 'readForWrite', async (id) => read(id));
    // The repository's rule: of a Track row and its twin, the Track row answers for the Eagle id.
    t.mock.method(projects, 'readForWriteByEagleId', async (eagleId) => {
      const matches = [...byId.values()].filter(row => row.eagleId === eagleId);
      return structuredClone(matches.find(row => row.id !== `eagle-${eagleId}`) || matches[0] || null);
    });
    t.mock.method(projects, 'upsert', async (doc) => {
      if (doc.id === refuse) throw Object.assign(new Error(`HTTP ${refuseCode}`), { code: refuseCode });
      written.push(doc.id);
      byId.set(doc.id, structuredClone(doc));
      await afterWrite(doc);
      return doc;
    });
    return { tagsOf: (id) => byId.get(id).tags, written };
  }

  await t.test('tags sent on the Track row are written to its twin', async () => {
    const store = pairStore([TRACK_ROW, TWIN_ROW]);

    const res = await put({ tags: ['Site C'] });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(store.tagsOf(TWIN_ID), ['Site C']);
  });

  await t.test('tags sent on the twin are written to the Track row', async () => {
    const store = pairStore([TRACK_ROW, TWIN_ROW]);

    const res = await put({ tags: ['Site C'] }, WRITER, TWIN_ID);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(store.tagsOf('207'), ['Site C']);
  });

  await t.test('an empty list clears both rows', async () => {
    const store = pairStore([{ ...TRACK_ROW, tags: ['Site C'] }, { ...TWIN_ROW, tags: ['Site C'] }]);

    const res = await put({ tags: [] });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(store.tagsOf('207'), []);
    assert.deepStrictEqual(store.tagsOf(TWIN_ID), []);
  });

  await t.test('resending the stored tags heals a twin that drifted', async () => {
    const store = pairStore([{ ...TRACK_ROW, tags: ['Site C'] }, { ...TWIN_ROW, tags: [] }]);

    const res = await put({ tags: ['Site C'] });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(store.tagsOf(TWIN_ID), ['Site C']);
  });

  await t.test('a row with no twin is the only write', async () => {
    const store = pairStore([TRACK_ROW]);

    const res = await put({ tags: ['Site C'] });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(store.written, ['207']);
  });

  await t.test('a PUT that does not send tags leaves the twin alone', async () => {
    const store = pairStore([{ ...TRACK_ROW, tags: ['Site C'] }, { ...TWIN_ROW, tags: ['Old Name'] }]);

    const res = await put({ description: 'A wind farm' });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(store.written, ['207']);
    assert.deepStrictEqual(store.tagsOf(TWIN_ID), ['Old Name']);
  });

  await t.test('a twin that keeps losing its etag race is a 500 and an error log', async () => {
    const store = pairStore([TRACK_ROW, TWIN_ROW], { refuse: TWIN_ID });
    const errors = t.mock.method(logger, 'error', () => {});

    const res = await put({ tags: ['Site C'] });

    assert.strictEqual(res.statusCode, 500);
    assert.match(res.body.error, /other copy/);
    assert.deepStrictEqual(store.tagsOf('207'), ['Site C'], 'the premise: the Track row did take them');
    assert.ok(errors.mock.calls.some(call => /mirror tags/.test(call.arguments[0])),
      `got: ${JSON.stringify(errors.mock.calls.map(call => call.arguments[0]))}`);
  });

  await t.test('a PUT that re-points eagleId does not write the tags onto that id\'s rows', async () => {
    const OTHER = 'other-eagle-id';
    const OTHER_TRACK = { id: '310', trackProjectId: 310, eagleId: OTHER, tags: ['Their Name'], _etag: '"o1"' };
    const OTHER_TWIN = { id: `eagle-${OTHER}`, eagleId: OTHER, tags: ['Their Name'], _etag: '"o2"' };
    const store = pairStore([TRACK_ROW, TWIN_ROW, OTHER_TRACK, OTHER_TWIN]);

    const res = await put({ eagleId: OTHER, tags: ['Site C'] });

    assert.strictEqual(res.statusCode, 200, 'the premise: eagleId is writable by this caller');
    assert.deepStrictEqual(store.written, ['207']);
    assert.deepStrictEqual(store.tagsOf(`eagle-${OTHER}`), ['Their Name']);
  });

  await t.test('a mirror that fails for a reason other than a race still audits the PUT, then 500s', async () => {
    const rows = [];
    audit._setTransport(async (_stream, batch) => { rows.push(...batch); });
    t.after(() => audit._setTransport(async () => {}));
    const store = pairStore([TRACK_ROW, TWIN_ROW], { refuse: TWIN_ID, refuseCode: 503 });
    const errors = t.mock.method(logger, 'error', () => {});

    const res = await put({ tags: ['Site C'] });

    assert.strictEqual(res.statusCode, 500);
    assert.match(res.body.error, /other copy/);
    assert.deepStrictEqual(store.tagsOf('207'), ['Site C'], 'the premise: the Track row did take them');
    assert.strictEqual(rows.length, 1, 'the primary write is audited');
    assert.strictEqual(rows[0].TargetId, '207');
    assert.ok(errors.mock.calls.some(call => /mirror tags/.test(call.arguments[0])));
  });

  await t.test('two PUTs on the pair that interleave leave both rows with the same tags', async () => {
    // Order: Track PUT saves, twin PUT saves, Track PUT mirrors, twin PUT mirrors.
    let twinSaved;
    const twinSavedYet = new Promise(resolve => { twinSaved = resolve; });
    let trackDone;
    const trackDoneYet = new Promise(resolve => { trackDone = resolve; });
    const firstWrite = new Set();
    const store = pairStore([TRACK_ROW, TWIN_ROW], {
      afterWrite: async (doc) => {
        if (firstWrite.has(doc.id)) return;
        firstWrite.add(doc.id);
        if (doc.id === '207') await twinSavedYet;
        else { twinSaved(); await trackDoneYet; }
      }
    });

    const onTrack = put({ tags: ['Site C'] }).then(res => { trackDone(); return res; });
    const onTwin = put({ tags: ['Peace River'] }, WRITER, TWIN_ID);
    const [trackRes, twinRes] = await Promise.all([onTrack, onTwin]);

    assert.strictEqual(trackRes.statusCode, 200);
    assert.strictEqual(twinRes.statusCode, 200);
    assert.deepStrictEqual(store.tagsOf('207'), store.tagsOf(TWIN_ID));
  });
});

test('POST /projects onto an existing id keeps the stored tags', async (t) => {
  t.mock.method(projects, 'getById', async () => ({ ...STORED, tags: ['Peace River Site C'] }));
  let saved;
  t.mock.method(projects, 'upsert', async (doc) => { saved = doc; return doc; });

  const res = mockRes();
  await projectController.createProject({
    params: {}, query: {}, user: STAFF,
    body: { trackProjectId: 207, name: 'Site C', centroid: { type: 'Point', coordinates: [-121.2, 56.2] } }
  }, res);

  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(saved.name, 'Site C', 'the premise: the row was rebuilt from the body');
  assert.deepStrictEqual(saved.tags, ['Peace River Site C']);
});
