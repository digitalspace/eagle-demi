'use strict';

// The native list contract every `/api/<kind>` read is built from (helpers/native-query.js through
// mirror-reads.js). Driven through the real handler, the real `cosmosKind` repository and a fake
// Cosmos that serves a fixed container, so paging, counting and redaction are observed in the
// response rather than in calls.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const querystring = require('node:querystring');

// First: the logger's uncaughtException handler would swallow a load failure here into a green run.
const { cosmosKind, projectParentJoin, MAX_IDS, ANON_MAX_PAGE_DEPTH } = require('../../../src/helpers/native-query');
const cosmos = require('../../../src/db/cosmos-nosql');
const config = require('../../../src/config');
const audit = require('../../../src/utils/audit');
const projects = require('../../../src/repositories/projects');
const { makeRes } = require('../../../src/http/router');
const { listHandler, getHandler } = require('../../../src/controllers/nosql/mirror-reads');

const STAFF = { realm_access: { roles: ['staff'] } };

// `author` is level 2 unless the comment is attributed; `eaoNotes` is level 2 always; c3 dials its
// own `comment` down to level 2.
const ROWS = Array.from({ length: 6 }, (_, i) => ({
  id: `c${i + 1}`,
  projectId: 'p1',
  read: ['public'],
  comment: `comment ${i + 1}`,
  author: `Author ${i + 1}`,
  isAnonymous: true,
  eaoNotes: 'staff only',
  ...(i === 2 ? { vis: { comment: 2 } } : {})
}));

const SPEC = {
  entity: 'comments',
  repository: cosmosKind({ container: 'comments', entity: 'comments', partitionField: 'projectId', defaultOrder: 'c.id ASC' }),
  sortKeys: ['dateAdded', 'author'],
  filters: ['eaoStatus', 'author'],
  multiValueFilters: ['eaoStatus'],
  qFields: ['comment'],
  notFound: 'Comment not found'
};

const list = listHandler(SPEC);
const get = getHandler(SPEC);

/** Fake Cosmos: COUNT answers 7, an `@id` read answers that row, a list read pages ROWS by size.
 * Every query spec is recorded, so a test can read the list query as well as the count. */
function fakeCosmos(t) {
  const specs = [];
  t.mock.method(cosmos, 'query', async (container, spec, options = {}) => {
    specs.push(spec);
    if (spec.query.includes('COUNT(1)')) return { items: [7] };
    const id = spec.parameters.find(p => p.name === '@id');
    if (id) return { items: ROWS.filter(row => row.id === id.value) };
    return { items: ROWS.slice(0, options.maxItemCount) };
  });
  return specs;
}

/** The one recorded spec that is neither the COUNT nor a by-id read. */
function listQuery(specs) {
  const lists = specs.filter(spec => !spec.query.includes('COUNT(1)') && !spec.parameters.some(p => p.name === '@id'));
  assert.strictEqual(lists.length, 1, 'expected one list read');
  return lists[0];
}

function param(spec, name) {
  const found = spec.parameters.find(p => p.name === name);
  return found && found.value;
}

const DCR_KEYS = ['auditDcrEndpoint', 'auditDcrImmutableId', 'eventsDcrEndpoint', 'eventsDcrImmutableId'];

/**
 * The audit and events rows a request leaves behind, read at the transport. mirror-reads holds its
 * own references to `analyticsEvent`/`auditEvent`, so the writer is observed rather than mocked.
 */
function recordEvents(t) {
  const saved = DCR_KEYS.map(key => config[key]);
  // Non-empty is what turns the writer on; the transport below means nothing is ever dialled.
  DCR_KEYS.forEach((key) => { config[key] = 'test-dcr'; });
  const sent = [];
  audit._setTransport(async (stream, rows) => { rows.forEach(row => sent.push({ stream, ...row })); });
  t.after(() => {
    DCR_KEYS.forEach((key, i) => { config[key] = saved[i]; });
    audit._resetTransport();
  });
  return async (stream) => {
    await audit.flush();
    return sent.filter(row => row.stream === stream);
  };
}

async function call(handler, qs, { user, id } = {}) {
  const req = { query: querystring.parse(qs), params: { id }, headers: {}, header: () => undefined, user };
  const res = makeRes('test');
  await handler(req, res);
  return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : undefined };
}

test('native list contract', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('an unknown parameter is refused before any read', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call(list, 'continuationToken=abc');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /unknown parameter: continuationToken/);
    assert.strictEqual(specs.length, 0);
  });

  await t.test('a repeated control parameter is refused', async (t) => {
    fakeCosmos(t);
    const res = await call(list, 'page=1&page=2');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /more than once: page/);
  });

  await t.test('a repeated single-value filter is refused, a declared multi-value one is not', async (t) => {
    fakeCosmos(t);
    assert.strictEqual((await call(list, 'author=a&author=b', { user: STAFF })).status, 400);
    assert.strictEqual((await call(list, 'eaoStatus=Pending&eaoStatus=Published')).status, 200);
  });

  await t.test('page is 1-based: page=1 is the first rows, page=2 the next', async (t) => {
    fakeCosmos(t);
    const first = await call(list, 'page=1&pageSize=2');
    const second = await call(list, 'page=2&pageSize=2');
    assert.deepStrictEqual(first.body.map(r => r.id), ['c1', 'c2']);
    assert.deepStrictEqual(second.body.map(r => r.id), ['c3', 'c4']);
  });

  await t.test('page=0 is refused', async (t) => {
    fakeCosmos(t);
    assert.strictEqual((await call(list, 'page=0')).status, 400);
  });

  await t.test('count=true sets a measured x-total-count', async (t) => {
    fakeCosmos(t);
    const res = await call(list, 'count=true');
    assert.strictEqual(res.headers['x-total-count'], '7');
  });

  await t.test('no count, no total header', async (t) => {
    fakeCosmos(t);
    const res = await call(list, '');
    assert.strictEqual(res.headers['x-total-count'], undefined);
  });

  await t.test('a sort key off the allow-list is refused', async (t) => {
    fakeCosmos(t);
    const res = await call(list, 'sort=comment');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /cannot sort on/);
  });

  await t.test('only one sort key is taken', async (t) => {
    fakeCosmos(t);
    assert.strictEqual((await call(list, 'sort=dateAdded,-author', { user: STAFF })).status, 400);
  });

  await t.test(`ids above ${MAX_IDS} are refused`, async (t) => {
    fakeCosmos(t);
    const ids = Array.from({ length: MAX_IDS + 1 }, (_, i) => `id${i}`).join(',');
    const res = await call(list, `ids=${ids}`);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /at most 100/);
  });

  await t.test(`ids at ${MAX_IDS} are read`, async (t) => {
    fakeCosmos(t);
    const ids = Array.from({ length: MAX_IDS }, (_, i) => `id${i}`).join(',');
    assert.strictEqual((await call(list, `ids=${ids}`)).status, 200);
  });

  await t.test('a filter on a level-2 field is refused for an anonymous caller', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call(list, 'author=Jane&count=true');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /cannot filter on a field this caller cannot see: author/);
    assert.strictEqual(specs.length, 0);
  });

  await t.test('staff may filter on it, and the count skips records whose own dial hides it', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call(list, 'author=Jane&count=true', { user: STAFF });
    assert.strictEqual(res.status, 200);
    const count = specs.find(spec => spec.query.includes('COUNT(1)'));
    assert.ok(count.query.includes('(NOT IS_DEFINED(c.vis["author"]) OR c.vis["author"] >= 2)'), count.query);
  });

  await t.test('ids= reads every named id, and only those, through an IN clause', async (t) => {
    const specs = fakeCosmos(t);
    const ids = Array.from({ length: MAX_IDS }, (_, i) => `id${i}`);
    assert.strictEqual((await call(list, `ids=${ids.join(',')}`)).status, 200);
    const read = listQuery(specs);
    const names = ids.map((_, i) => `@nid${i}`);
    assert.ok(read.query.includes(`c.id IN (${names.join(', ')})`), read.query);
    assert.deepStrictEqual(names.map(name => param(read, name)), ids);
  });

  await t.test('a filter narrows the list read, inside the per-record dial on that field', async (t) => {
    const specs = fakeCosmos(t);
    await call(list, 'author=Jane', { user: STAFF });
    const read = listQuery(specs);
    assert.ok(read.query.includes(
      '((NOT IS_DEFINED(c.vis["author"]) OR c.vis["author"] >= 2) AND c.author = @nf0)'), read.query);
    assert.strictEqual(param(read, '@nf0'), 'Jane');
  });

  await t.test('a multi-value filter narrows the list read to any of its values', async (t) => {
    const specs = fakeCosmos(t);
    await call(list, 'eaoStatus=Pending&eaoStatus=Published');
    const read = listQuery(specs);
    assert.ok(read.query.includes(
      '((NOT IS_DEFINED(c.vis["eaoStatus"]) OR c.vis["eaoStatus"] >= 4) AND c.eaoStatus IN (@nf0_0, @nf0_1))'),
    read.query);
    assert.deepStrictEqual([param(read, '@nf0_0'), param(read, '@nf0_1')], ['Pending', 'Published']);
  });

  await t.test('q searches every qField of the list read, each inside its per-record dial', async (t) => {
    const specs = fakeCosmos(t);
    const twoFields = listHandler({ ...SPEC, qFields: ['comment', 'eaoStatus'] });
    await call(twoFields, 'q=road');
    const read = listQuery(specs);
    assert.ok(read.query.includes(
      '(((NOT IS_DEFINED(c.vis["comment"]) OR c.vis["comment"] >= 4) AND CONTAINS(c.comment, @nq, true))' +
      ' OR ((NOT IS_DEFINED(c.vis["eaoStatus"]) OR c.vis["eaoStatus"] >= 4) AND CONTAINS(c.eaoStatus, @nq, true)))'),
    read.query);
    assert.strictEqual(param(read, '@nq'), 'road');
  });

  await t.test('q carries the same per-record dial for an anonymous caller', async (t) => {
    const specs = fakeCosmos(t);
    await call(list, 'q=road&count=true');
    const count = specs.find(spec => spec.query.includes('COUNT(1)'));
    assert.ok(count.query.includes('c.vis["comment"] >= 4'), count.query);
  });

  await t.test(`an anonymous caller cannot page past ${ANON_MAX_PAGE_DEPTH} rows`, async (t) => {
    fakeCosmos(t);
    const res = await call(list, 'page=21&pageSize=100');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /within 2000 rows/);
  });

  await t.test('an authenticated caller can', async (t) => {
    fakeCosmos(t);
    assert.strictEqual((await call(list, 'page=21&pageSize=100', { user: STAFF })).status, 200);
  });

  await t.test('an authenticated list is never stored by a cache', async (t) => {
    fakeCosmos(t);
    const res = await call(list, '', { user: STAFF });
    assert.strictEqual(res.headers['cache-control'], 'private, no-store');
  });

  await t.test('an anonymous list carries no no-store', async (t) => {
    fakeCosmos(t);
    const res = await call(list, '');
    assert.strictEqual(res.headers['cache-control'], undefined);
  });

  await t.test('level-2 fields are absent from an anonymous list', async (t) => {
    fakeCosmos(t);
    const res = await call(list, '');
    assert.strictEqual(res.body[0].author, undefined);
    assert.strictEqual(res.body[0].eaoNotes, undefined);
    assert.strictEqual(res.body[0].comment, 'comment 1');
  });

  await t.test('a field a record dials to level 2 is absent when read anonymously by id', async (t) => {
    fakeCosmos(t);
    const res = await call(get, '', { id: 'c3' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.comment, undefined);
    assert.strictEqual(res.body.author, undefined);
  });

  await t.test('staff read the same record whole, uncached', async (t) => {
    fakeCosmos(t);
    const res = await call(get, '', { id: 'c3', user: STAFF });
    assert.strictEqual(res.body.comment, 'comment 3');
    assert.strictEqual(res.body.eaoNotes, 'staff only');
    assert.strictEqual(res.headers['cache-control'], 'private, no-store');
  });

  await t.test('a missing DEMI id and a missing Eagle id answer the same 404', async (t) => {
    fakeCosmos(t);
    const demi = await call(get, '', { id: 'nope' });
    const eagle = await call(get, '', { id: '5c1a2b3c4d5e6f7a8b9c0d1e' });
    assert.strictEqual(demi.status, 404);
    assert.deepStrictEqual(eagle.body, demi.body);
  });

  await t.test('a parent project name its own dial hides from the public is not joined for an anonymous caller', async (t) => {
    fakeCosmos(t);
    t.mock.method(projects, 'listRowsByIds', async () => [
      { id: 'p1', read: ['public'], name: 'Site C', eagleId: '5c1a2b3c4d5e6f7a8b9c0d1e', vis: { name: 2 } }
    ]);
    const joined = listHandler({ ...SPEC, parentJoin: projectParentJoin });

    const anonymous = await call(joined, 'pageSize=1');
    assert.strictEqual(anonymous.body[0].projectName, undefined);
    assert.strictEqual(anonymous.body[0].projectEagleId, '5c1a2b3c4d5e6f7a8b9c0d1e');

    const staff = await call(joined, 'pageSize=1', { user: STAFF });
    assert.strictEqual(staff.body[0].projectName, 'Site C');
  });

  await t.test('a search term on comments or users stays out of analytics; on another kind it is logged', async (t) => {
    fakeCosmos(t);
    const events = recordEvents(t);
    const kind = entity => listHandler({ ...SPEC, entity, filters: [], multiValueFilters: [], qFields: ['displayName'] });

    await call(listHandler({ ...SPEC }), 'q=road');
    await call(kind('users'), 'q=jane', { user: STAFF });
    await call(kind('documents'), 'q=bridge');
    await call(kind('documents'), '');

    const searches = await events(audit.EVENTS_STREAM);
    assert.deepStrictEqual(searches.map(row => [row.EventName, row.SearchTerm, row.Detail.kind]),
      [['search', 'bridge', 'documents']]);
  });

  await t.test('an audited kind writes a list audit row for an authenticated caller only', async (t) => {
    fakeCosmos(t);
    const events = recordEvents(t);
    const audited = listHandler({ ...SPEC, audited: true });

    await call(audited, '');
    await call(list, '', { user: STAFF });
    await call(audited, 'pageSize=2', { user: STAFF });

    const rows = await events(audit.AUDIT_STREAM);
    assert.deepStrictEqual(rows.map(row => [row.Action, row.TargetType, row.Detail.count]), [['comments.list', 'comments', 2]]);
  });

  await t.test('a by-id read falls back to the Eagle id lookup for a 24-hex id', async (t) => {
    fakeCosmos(t);
    const byEagle = getHandler({
      ...SPEC,
      repository: { ...SPEC.repository, getByEagleId: async (_access, id) => ({ ...ROWS[0], eagleId: id }) }
    });
    const res = await call(byEagle, '', { id: '5c1a2b3c4d5e6f7a8b9c0d1e' });
    assert.strictEqual(res.body.id, 'c1');
  });
});

test('a store that cannot take Cosmos SQL gets the parsed query, the same object in list and count', async () => {
  const seen = {};
  const repository = {
    async list(access, args) { seen.list = args.parsed; return []; },
    async count(access, args) { seen.count = args.parsed; return 0; },
    async getById() { return null; }
  };
  const res = await call(listHandler({ ...SPEC, repository }), 'q=late&eaoStatus=Pending&eaoStatus=Published&count=true');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(seen.list.q, 'late');
  assert.deepStrictEqual(seen.list.filters, { eaoStatus: ['Pending', 'Published'] });
  assert.strictEqual(seen.count, seen.list);
});
