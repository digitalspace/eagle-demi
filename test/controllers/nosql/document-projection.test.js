'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const documents = require('../../../src/repositories/documents');
const documentController = require('../../../src/controllers/nosql/document');
const { redactForAccess } = require('../../../src/vis/redact');
const config = require('../../../src/config');

// The redactor allowlists `sources.*` by ENRICHMENT_SOURCES; test deploys name wildfire.
config.enrichmentSources = ['wildfire'];

/** The fail-closed level every unauthenticated caller resolves to. */
const ANON_ACCESS = { level: 4 };

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    setHeader(k, v) { this.headers[k] = v; }
  };
}

const ANON = { query: {}, params: {}, body: {} };
const ADMIN_USER = { realm_access: { roles: ['sysadmin'] } };

/**
 * The read ACL gates ROWS, not fields — so a caller entitled to the row was getting the raw Cosmos
 * record with it: `read[]` (the internal role vocabulary), `s3Key` (the object-store key) and
 * `_etag`. `/api/search` already withholds all of that from every row shape it emits; these two
 * CRUD routes simply did not follow the same rule.
 */
const STORED = {
  id: 'd1',
  projectId: '207',
  displayName: 'Application Part A',
  documentFileName: 'part-a.pdf',
  s3Key: 'etl/site-c/1389817063122_20d7490a.pdf',
  read: ['public', 'sysadmin', 'staff', 'demi-admin'],
  isPublished: true,
  _etag: '"0x8DF007286A35D0A"'
};

test('document routes withhold the raw Cosmos record', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('neither the list nor the point read emits read[], s3Key or _etag', async () => {
    t.mock.method(documents, 'listVisible', async () => ({
      items: [structuredClone(STORED)], continuationToken: undefined
    }));
    t.mock.method(documents, 'getById', async () => structuredClone(STORED));

    const list = mockRes();
    await documentController.getDocuments({ ...ANON }, list);
    const one = mockRes();
    await documentController.getDocument({ params: { id: 'd1' }, query: {} }, one);

    for (const [label, body] of [['list', list.body[0]], ['point read', one.body]]) {
      assert.strictEqual(body.read, undefined, `${label}: the ACL is withheld`);
      assert.strictEqual(body.s3Key, undefined, `${label}: the object key is withheld`);
      assert.strictEqual(body._etag, undefined, `${label}: the concurrency token is withheld`);
      assert.strictEqual(body.displayName, 'Application Part A', `${label}: the record survives`);
      assert.strictEqual(body.documentFileName, 'part-a.pdf', `${label}: the label survives`);
      assert.strictEqual(body.isPublished, true, `${label}: the mirror survives`);
    }
  });

  /**
   * The same for a privileged caller. The search path takes no privilege branch on which FIELDS
   * leave — only on which rows — and a second rule here is exactly how the two projections came to
   * disagree in the first place.
   */
  await t.test('a privileged caller gets the same projection, not the raw row', async () => {
    t.mock.method(documents, 'listVisible', async () => ({
      items: [structuredClone(STORED)], continuationToken: undefined
    }));

    const res = mockRes();
    await documentController.getDocuments({ query: {}, user: ADMIN_USER }, res);

    assert.strictEqual(res.body[0].read, undefined);
    assert.strictEqual(res.body[0].s3Key, undefined);
    assert.strictEqual(res.body[0]._etag, undefined);
  });

  /**
   * Dropping `read[]` has to be lossless. The seeded Eagle documents carry an ACL and no usable
   * `isPublished` (seed/transform.js), so reporting the stored flag verbatim would call a
   * restricted document published, or a published one hidden, depending which way the two rows
   * disagree. `isPublished` is derived from the ACL, the same expression the search rows use.
   */
  await t.test('isPublished is derived from read[], not read off the stored flag', async () => {
    const disagreeing = { ...structuredClone(STORED), read: ['sysadmin', 'staff'], isPublished: true };
    t.mock.method(documents, 'getById', async () => disagreeing);

    const res = mockRes();
    await documentController.getDocument({ params: { id: 'd1' }, query: {} }, res);
    assert.strictEqual(res.body.isPublished, false, 'the ACL wins — the row is not public');
  });

  await t.test('a document with no ACL falls back to its stored isPublished', async () => {
    t.mock.method(documents, 'getById', async () => ({
      id: 'd2', projectId: '207', displayName: 'Legacy', isPublished: true
    }));

    const res = mockRes();
    await documentController.getDocument({ params: { id: 'd2' }, query: {} }, res);
    assert.strictEqual(res.body.isPublished, true);
  });

  /**
   * Why the strip lives at res.json and not in the data layer: updateDocument reads, spreads and
   * upserts, so a narrowed READ would erase the ACL and the object key from the stored document on
   * the next edit — which would unlink the file and hand the row an empty `read[]`.
   */
  await t.test('narrowing the response does not narrow what is stored', async () => {
    t.mock.method(documents, 'getById', async () => structuredClone(STORED));
    let saved;
    t.mock.method(documents, 'upsert', async (doc) => { saved = doc; return doc; });

    const res = mockRes();
    await documentController.updateDocument({
      params: { id: 'd1' }, query: {}, body: { displayName: 'Renamed' }
    }, res);

    assert.deepStrictEqual(saved.read, STORED.read, 'stored ACL intact');
    assert.strictEqual(saved.s3Key, STORED.s3Key, 'stored object key intact');
    assert.strictEqual(res.body.read, undefined, 'response still narrowed');
    assert.strictEqual(res.body.s3Key, undefined, 'response still narrowed');
    assert.strictEqual(res.body.displayName, 'Renamed');
  });
});

/**
 * `GET /projects` already passed rows through publicView, which stripped `sources` and nothing
 * else — so it shipped a LARGER role vocabulary than the documents route did.
 */
test('EVERY response that emits a document row goes through publicView', async () => {
  // The three write paths — create, publish, delete — had no test at all: reverting the strip on
  // any of them left the whole suite green, so they could regress to shipping `read[]`, `s3Key` and
  // `_etag` to an anonymous caller silently.
  //
  // Asserted against the SOURCE rather than by driving each handler, deliberately. Driving them
  // would pin the four sites that exist today and say nothing about the fifth somebody adds next
  // year — and "somebody added a return path and forgot the strip" is precisely how this defect
  // arrived. A source invariant fails on the new site, before anyone has to think of testing it.
  //
  // Comments are stripped first, reusing `test/helpers/router-source.js` — the same helper the
  // auth-coverage test uses, and for the same reason it exists: a bare regex over source text
  // counts `// return res.json(saved)` as a real call site, so a matcher that reads comments can be
  // satisfied by prose. That lesson cost a review round once already. `jsonEmissions` reads each
  // argument to its MATCHING paren: the line-bounded version of this missed the delete route
  // outright, whose `deleted: publicView(existing)` sits three lines below its `res.json(`.
  const { jsonEmissions } = require('../../helpers/router-source');
  const emissions = jsonEmissions(fs.readFileSync(
    path.join(__dirname, '../../../src/controllers/nosql/document.js'), 'utf8'));

  assert.ok(emissions.length >= 6, `expected the known response sites, found ${emissions.length}`);

  // A row-emitting site names a repository row BARE — `publicView(saved)`, `items.map(publicView)`.
  // The negative lookahead for a dot is what separates that from a hand-built literal that merely
  // reads a scalar off one: `{ id: doc.id, chunks: keepIds.length }` carries no ACL and no storage
  // key, and counting it would make this test fail against correct code — which is how a source
  // invariant gets deleted by the next person instead of fixed.
  const ROW_SOURCES = /\b(saved|updated|existing|doc|items)\b(?!\s*\.)/;
  const unstripped = emissions.filter(e => ROW_SOURCES.test(e) && !/publicView/.test(e));

  assert.deepStrictEqual(unstripped, [],
    'these emit a repository row without publicView — each one ships read[], s3Key and _etag');
});

test('the projects redactor withholds the ACL as well as the upstream payloads', async (t) => {
  const STORED_PROJECT = {
    id: '207',
    name: 'Nicomen Wind Energy',
    read: ['public', 'project-proponent', 'project-admin', 'system-eao', 'project-intake'],
    isPublished: true,
    _etag: '"0x8DF00728"',
    sources: {
      track: { track_project_id: 207 },
      wildfire: {
        activeCountWithin50km: 2,
        nearestDistanceKm: 12.4,
        firesOfNoteNearby: 1,
        lastCalculatedAt: '2026-08-23T00:00:00.000Z'
      }
    }
  };

  await t.test('read[] and _etag are stripped; the allowlisted aggregate survives', () => {
    const view = redactForAccess('projects', structuredClone(STORED_PROJECT), ANON_ACCESS);

    assert.strictEqual(view.read, undefined, 'the role vocabulary is withheld');
    assert.strictEqual(view._etag, undefined, 'the concurrency token is withheld');
    assert.strictEqual(view.sources.track, undefined, 'the Track payload is still withheld');
    assert.strictEqual(view.sources.wildfire.activeCountWithin50km, 2,
      'the wildfire aggregate still survives');
    assert.strictEqual(view.name, 'Nicomen Wind Energy', 'the record itself survives');
    assert.strictEqual(view.isPublished, true, 'the mirror survives');
  });

  await t.test('a project with no wildfire aggregate still loses read[]', () => {
    const view = redactForAccess('projects',
      { id: '208', name: 'P', read: ['sysadmin'], isPublished: false }, ANON_ACCESS);

    assert.strictEqual(view.read, undefined);
    assert.strictEqual(view.isPublished, false, 'derived from the ACL: not public');
    assert.strictEqual(view.name, 'P');

    // NO ACL AT ALL falls back to the stored flag, and the fallback must not default to TRUE — a
    // row that reached here without a `read[]` is the one case where the authoritative source is
    // missing, and guessing "published" there publishes it. The branch is unreachable for stored
    // rows today (`resolveProjectAcl` and the project controller both guarantee a non-empty
    // `read[]`), which is exactly why it needs an assertion rather than trust: nothing else would
    // notice it changing.
    assert.strictEqual(
      redactForAccess('projects', { id: '209', name: 'Q', isPublished: false }, ANON_ACCESS)
        .isPublished, false,
      'no ACL: the stored flag is the fallback, never a default-true');
    assert.strictEqual(
      redactForAccess('projects', { id: '210', name: 'R', isPublished: true }, ANON_ACCESS)
        .isPublished, true,
      'and the fallback is the stored flag, not a constant');
    // NEITHER field: the row says nothing about its own visibility, so the answer is NOT PUBLIC.
    // `isPublished === true` and `isPublished !== false` agree on every row that carries the flag
    // and disagree only here — where the second one publishes a row that never claimed to be
    // public. That is the whole reason the comparison is written the strict way round.
    assert.strictEqual(
      redactForAccess('projects', { id: '211', name: 'S' }, ANON_ACCESS).isPublished, false,
      'a row that asserts neither an ACL nor a flag is not published by default');
  });
});

test('the `sources` allowlist is ENRICHMENT_SOURCES, not a hardcoded key', async (t) => {
  const stored = () => ({
    id: '207',
    name: 'Nicomen Wind Energy',
    isPublished: true,
    sources: { track: { track_project_id: 207 }, wildfire: { activeCountWithin50km: 2 } }
  });

  t.after(() => { config.enrichmentSources = ['wildfire']; });

  await t.test('empty list: no enrichment leaves at all — the prod setting', () => {
    config.enrichmentSources = [];
    assert.strictEqual(redactForAccess('projects', stored(), ANON_ACCESS).sources, undefined);
  });

  await t.test('a named key passes, and nothing else does', () => {
    config.enrichmentSources = ['wildfire'];
    const view = redactForAccess('projects', stored(), ANON_ACCESS);
    assert.deepStrictEqual(view.sources, { wildfire: { activeCountWithin50km: 2 } });
  });

  await t.test('a listed key the row does not carry is never invented', () => {
    config.enrichmentSources = ['wildfire', 'nowhere'];
    assert.deepStrictEqual(
      Object.keys(redactForAccess('projects', stored(), ANON_ACCESS).sources), ['wildfire']);
  });
});
