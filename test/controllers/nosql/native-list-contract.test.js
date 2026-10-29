'use strict';

// The native list contract every `/api/<kind>` read is built from (helpers/native-query.js through
// mirror-reads.js). Driven through the real handler, the real `cosmosKind` repository and a fake
// Cosmos that serves a fixed container, so paging, counting and redaction are observed in the
// response rather than in calls.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const querystring = require('node:querystring');

const {
  cosmosKind, projectParentJoin, assertKindSpec, parseNativeQuery, nativeCriteria, presenceClause, flagClause,
  MAX_IDS, MAX_CONTAINS, ANON_MAX_PAGE_DEPTH
} = require('../../../src/helpers/native-query');
const { evaluate } = require('../../helpers/updates-store');
const cosmos = require('../../../src/db/cosmos-nosql');
const audit = require('../../../src/utils/audit');
const { recordEvents } = require('../../helpers/record-events');
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
  t.mock.method(cosmos, 'queryFirst', async (container, spec) => {
    specs.push(spec);
    const id = spec.parameters.find(p => p.name === '@id');
    return ROWS.find(row => row.id === id.value) || null;
  });
  return specs;
}

/**
 * By-id reads as a cross-partition query serves them: `pages` in order, each but the last with a
 * continuation token. `query` answers one page per call; `queryFirst` drains them all.
 */
function pagedById(t, pages) {
  t.mock.method(cosmos, 'query', async (container, spec, options = {}) => {
    const at = Number(options.continuationToken || 0);
    return { items: pages[at] || [], continuationToken: at + 1 < pages.length ? String(at + 1) : undefined };
  });
  t.mock.method(cosmos, 'queryFirst', async () => pages.flat()[0] || null);
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

  await t.test('a by-id read finds a row the first page of the cross-partition query does not hold', async (t) => {
    pagedById(t, [[], [ROWS[1]]]);
    const res = await call(get, '', { id: 'c2' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.id, 'c2');
  });

  await t.test('a by-id read that exhausts every page is a 404', async (t) => {
    pagedById(t, [[], [], []]);
    const res = await call(get, '', { id: 'c2' });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.error, 'Comment not found');
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

test('a filter alias', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const aliased = listHandler({ ...SPEC, aliases: { status: 'eaoStatus' } });

  await t.test('the alias filters the row field it names', async (t) => {
    const specs = fakeCosmos(t);
    assert.strictEqual((await call(aliased, 'status=Pending')).status, 200);
    const read = listQuery(specs);
    assert.ok(read.query.includes('c.eaoStatus = @nf0'), read.query);
    assert.strictEqual(param(read, '@nf0'), 'Pending');
  });

  await t.test('the row field spelling is an unknown parameter, refused before any read', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call(aliased, 'eaoStatus=Pending');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'unknown parameter: eaoStatus');
    assert.strictEqual(specs.length, 0);
  });

  await t.test("a multi-value field stays multi-value under its alias", async (t) => {
    const specs = fakeCosmos(t);
    assert.strictEqual((await call(aliased, 'status=Pending&status=Published')).status, 200);
    assert.ok(listQuery(specs).query.includes('c.eaoStatus IN'));
  });

  await t.test('a repeated single-value alias is refused under the name the caller sent', async (t) => {
    fakeCosmos(t);
    const single = listHandler({ ...SPEC, aliases: { by: 'author' } });
    const res = await call(single, 'by=a&by=b', { user: STAFF });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'parameter given more than once: by');
  });

  await t.test('an alias for a field that is not a declared filter fails at route load', () => {
    assert.throws(() => listHandler({ ...SPEC, aliases: { project: 'projectId' } }), /not a declared filter/);
  });

  await t.test('value aliases for a field that is not a declared filter fail at route load', () => {
    assert.throws(() => listHandler({ ...SPEC, valueAliases: { projectType: { a: 'b' } } }),
      /value aliases for projectType, which is not a declared filter/);
  });

  await t.test('an alias that shadows a control parameter fails at route load', () => {
    assert.throws(() => listHandler({ ...SPEC, aliases: { q: 'author' } }), /clashes/);
  });
});

test('a filter on a dotted path', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  // `author` is level 2 in the comments catalog; a record's dial is keyed by `author`, never `author._id`.
  const dotted = listHandler({ ...SPEC, filters: ['author._id'], multiValueFilters: [], aliases: { by: 'author._id' } });

  await t.test('matches the nested value inside the dial of its top-level field', async (t) => {
    const specs = fakeCosmos(t);
    assert.strictEqual((await call(dotted, 'by=a1', { user: STAFF })).status, 200);
    const read = listQuery(specs);
    assert.ok(read.query.includes(
      '((NOT IS_DEFINED(c.vis["author"]) OR c.vis["author"] >= 2) AND c.author._id = @nf0)'), read.query);
    assert.ok(!read.query.includes('c.vis["author._id"]'), read.query);
    assert.strictEqual(param(read, '@nf0'), 'a1');
  });

  await t.test('is refused when the caller cannot see its top-level field', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call(dotted, 'by=a1');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /cannot filter on a field this caller cannot see: author$/);
    assert.strictEqual(specs.length, 0);
  });
});

test('a day range', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const ranged = listHandler({
    ...SPEC,
    ranges: { addedFrom: { field: 'dateAdded', op: 'ge' }, addedTo: { field: 'dateAdded', op: 'le' } }
  });

  await t.test('each edge narrows the row field inside its dial, from the first to the last millisecond', async (t) => {
    const specs = fakeCosmos(t);
    assert.strictEqual((await call(ranged, 'addedFrom=2026-01-01&addedTo=2026-01-31')).status, 200);
    const read = listQuery(specs);
    assert.ok(read.query.includes('c.vis["dateAdded"]'), read.query);
    assert.ok(read.query.includes('c.dateAdded >= @nr0') && read.query.includes('c.dateAdded <= @nr1'), read.query);
    assert.strictEqual(param(read, '@nr0'), '2026-01-01T00:00:00.000Z');
    assert.strictEqual(param(read, '@nr1'), '2026-01-31T23:59:59.999Z');
  });

  await t.test('a day that does not exist is refused before any read', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call(ranged, 'addedFrom=2026-02-30');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'addedFrom takes one day as YYYY-MM-DD');
    assert.strictEqual(specs.length, 0);
  });

  await t.test('a repeated edge is refused', async (t) => {
    fakeCosmos(t);
    const res = await call(ranged, 'addedFrom=2026-01-01&addedFrom=2026-02-01');
    assert.strictEqual(res.body.error, 'parameter given more than once: addedFrom');
  });

  await t.test('an edge on a field the caller cannot see is refused', async (t) => {
    fakeCosmos(t);
    const hidden = listHandler({ ...SPEC, ranges: { notesFrom: { field: 'eaoNotes', op: 'ge' } } });
    assert.strictEqual((await call(hidden, 'notesFrom=2026-01-01')).status, 400);
  });

  await t.test('a range that shadows a filter or names no op fails at route load', () => {
    assert.throws(() => listHandler({ ...SPEC, ranges: { author: { field: 'dateAdded', op: 'ge' } } }), /clashes/);
    assert.throws(() => listHandler({ ...SPEC, ranges: { addedFrom: { field: 'dateAdded', op: 'gt' } } }), /ge or le/);
  });
});

test('a contains filter', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const texted = { ...SPEC, contains: { commentContains: 'comment', notesContains: 'eaoNotes' } };
  const list = listHandler(texted);

  await t.test('matches the trimmed text case-blind inside the field\'s dial, as a bound parameter', async (t) => {
    const specs = fakeCosmos(t);
    assert.strictEqual((await call(list, 'commentContains=%20Late%20')).status, 200);
    const read = listQuery(specs);
    assert.ok(read.query.includes(
      '((NOT IS_DEFINED(c.vis["comment"]) OR c.vis["comment"] >= 4) AND CONTAINS(c.comment, @nc0, true))'), read.query);
    assert.strictEqual(param(read, '@nc0'), 'Late');
  });

  await t.test('given twice is refused before any read', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call(list, 'commentContains=a&commentContains=b');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'parameter given more than once: commentContains');
    assert.strictEqual(specs.length, 0);
  });

  await t.test(`over ${MAX_CONTAINS} characters is refused`, async (t) => {
    fakeCosmos(t);
    const res = await call(list, `commentContains=${'a'.repeat(MAX_CONTAINS + 1)}`);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, `commentContains takes at most ${MAX_CONTAINS} characters`);
  });

  await t.test(`exactly ${MAX_CONTAINS} characters is taken`, async (t) => {
    fakeCosmos(t);
    assert.strictEqual((await call(list, `commentContains=${'a'.repeat(MAX_CONTAINS)}`)).status, 200);
  });

  await t.test('empty after trimming adds no clause, as an empty q does', async (t) => {
    const specs = fakeCosmos(t);
    assert.strictEqual((await call(list, 'commentContains=%20%20')).status, 200);
    const read = listQuery(specs);
    assert.ok(!read.query.includes('CONTAINS(c.comment'), read.query);
    assert.strictEqual(param(read, '@nc0'), undefined);
  });

  await t.test('on a field the caller cannot see is refused', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call(list, 'notesContains=staff');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /cannot filter on a field this caller cannot see: eaoNotes$/);
    assert.strictEqual(specs.length, 0);
  });

  await t.test('a name that shadows a filter fails at route load', () => {
    assert.throws(() => listHandler({ ...SPEC, contains: { author: 'comment' } }), /contains author clashes/);
  });
});

test('a presence filter', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const list = listHandler({ ...SPEC, presence: { hasComment: 'comment' } });

  await t.test('true keeps only rows whose field holds a value other than null or empty', () => {
    const { clause } = presenceClause('documentUrl', true);
    const rows = [
      { id: 'url', documentUrl: 'https://example.test/a.pdf' },
      { id: 'null', documentUrl: null },
      { id: 'empty', documentUrl: '' },
      { id: 'absent' }
    ];
    assert.deepStrictEqual(rows.filter(row => evaluate(clause, row, {})).map(row => row.id), ['url']);
  });

  await t.test('false keeps exactly the rows true leaves out', () => {
    const { clause } = presenceClause('documentUrl', false);
    const rows = [{ id: 'url', documentUrl: 'x' }, { id: 'null', documentUrl: null }, { id: 'empty', documentUrl: '' }, { id: 'absent' }];
    assert.deepStrictEqual(rows.filter(row => evaluate(clause, row, {})).map(row => row.id), ['null', 'empty', 'absent']);
  });

  await t.test('the list read holds the presence clause inside the field\'s dial', async (t) => {
    const specs = fakeCosmos(t);
    assert.strictEqual((await call(list, 'hasComment=true')).status, 200);
    const read = listQuery(specs);
    assert.ok(read.query.includes(
      `((NOT IS_DEFINED(c.vis["comment"]) OR c.vis["comment"] >= 4) AND ${presenceClause('comment', true).clause})`), read.query);
  });

  await t.test('a value other than true or false is refused before any read', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call(list, 'hasComment=maybe');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'hasComment takes only true or false');
    assert.strictEqual(specs.length, 0);
  });

  await t.test('given twice is refused', async (t) => {
    fakeCosmos(t);
    const res = await call(list, 'hasComment=true&hasComment=false');
    assert.strictEqual(res.body.error, 'parameter given more than once: hasComment');
  });

  await t.test('on a field the caller cannot see is refused', async (t) => {
    fakeCosmos(t);
    const hidden = listHandler({ ...SPEC, presence: { hasNotes: 'eaoNotes' } });
    assert.match((await call(hidden, 'hasNotes=true')).body.error, /cannot see: eaoNotes$/);
  });
});

test('a flag filter', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const list = listHandler({ ...SPEC, flags: { anonymous: 'isAnonymous' } });
  const rows = [
    { id: 'true', isAnonymous: true },
    { id: 'false', isAnonymous: false },
    { id: 'absent' },
    { id: 'null', isAnonymous: null },
    { id: 'text', isAnonymous: 'true' }
  ];
  const matching = on => rows.filter(row => evaluate(flagClause('isAnonymous', on).clause, row, {})).map(row => row.id);

  await t.test('true keeps only rows whose field is boolean true', () => {
    assert.deepStrictEqual(matching(true), ['true']);
  });

  await t.test('false keeps every other row, one lacking the field included', () => {
    assert.deepStrictEqual(matching(false), ['false', 'absent', 'null', 'text']);
  });

  await t.test('false guards with IS_BOOL, since Cosmos drops a row where NOT meets an undefined comparison', () => {
    assert.strictEqual(flagClause('isAnonymous', false).clause, '(NOT (IS_BOOL(c.isAnonymous) AND c.isAnonymous = true))');
  });

  await t.test('the list read holds the flag clause inside the field\'s dial', async (t) => {
    const specs = fakeCosmos(t);
    assert.strictEqual((await call(list, 'anonymous=false')).status, 200);
    const read = listQuery(specs);
    assert.ok(read.query.includes(
      `((NOT IS_DEFINED(c.vis["isAnonymous"]) OR c.vis["isAnonymous"] >= 4) AND ${flagClause('isAnonymous', false).clause})`), read.query);
  });

  await t.test('a value other than true or false is refused before any read', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call(list, 'anonymous=maybe');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'anonymous takes only true or false');
    assert.strictEqual(specs.length, 0);
  });

  await t.test('given twice is refused', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call(list, 'anonymous=true&anonymous=true');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'parameter given more than once: anonymous');
    assert.strictEqual(specs.length, 0);
  });

  await t.test('on a field the caller cannot see is refused', async (t) => {
    fakeCosmos(t);
    const hidden = listHandler({ ...SPEC, flags: { noted: 'eaoNotes' } });
    assert.match((await call(hidden, 'noted=true')).body.error, /cannot see: eaoNotes$/);
  });

  await t.test('a flag name another kind of parameter already takes is refused at route load', () => {
    const clashes = [
      ['author', {}],
      ['page', {}],
      ['byName', { aliases: { byName: 'author' } }],
      ['from', { ranges: { from: { field: 'dateAdded', op: 'ge' } } }],
      ['has', { presence: { has: 'comment' } }],
      ['says', { contains: { says: 'comment' } }]
    ];
    for (const [name, other] of clashes) {
      assert.throws(() => assertKindSpec({ ...SPEC, ...other, flags: { [name]: 'isAnonymous' } }),
        new RegExp(`flags ${name} clashes with a parameter of that name`));
    }
    assert.doesNotThrow(() => assertKindSpec({ ...SPEC, flags: { anonymous: 'isAnonymous' } }));
  });
});

test('a flag renders from the parsed query alone, as the index re-reads call it', () => {
  const parsed = parseNativeQuery({ ...SPEC, flags: { anonymous: 'isAnonymous' } }, { anonymous: 'true' }, null);
  assert.deepStrictEqual(parsed.flags, { isAnonymous: true });

  const clauses = nativeCriteria({}, parsed, null).criteria.map(c => c.clause).join(' AND ');
  assert.ok(clauses.includes(flagClause('isAnonymous', true).clause), clauses);
});

test('contains and presence render from the parsed query alone, as the index re-reads call it', () => {
  const spec = { ...SPEC, contains: { commentContains: 'comment' }, presence: { hasComment: 'comment' } };
  const parsed = parseNativeQuery(spec, { commentContains: 'late', hasComment: 'false' }, null);
  assert.deepStrictEqual(parsed.contains, { comment: 'late' });
  assert.deepStrictEqual(parsed.presence, { comment: false });

  const { criteria } = nativeCriteria({}, parsed, null);
  const clauses = criteria.map(c => c.clause).join(' AND ');
  assert.ok(clauses.includes('CONTAINS(c.comment, @nc0, true)'), clauses);
  assert.ok(clauses.includes(presenceClause('comment', false).clause), clauses);
  assert.deepStrictEqual(criteria.flatMap(c => c.params), [{ name: '@nc0', value: 'late' }]);
});

test('a kind without anyOf emits no EXISTS clause', async (t) => {
  await t.test('its filters stay plain filters, so an array-shaped value is matched as a value', () => {
    const parsed = parseNativeQuery(SPEC, { eaoStatus: ['Pending', 'Published'] }, null);
    assert.deepStrictEqual(parsed.anyOf, {});
    assert.deepStrictEqual(parsed.filters, { eaoStatus: ['Pending', 'Published'] });
    const clauses = nativeCriteria(SPEC, parsed, null).criteria.map(c => c.clause).join(' AND ');
    assert.ok(!clauses.includes('EXISTS'), clauses);
    assert.ok(clauses.includes('c.eaoStatus IN (@nf0_0, @nf0_1)'), clauses);
  });

  await t.test('a parsed query with no anyOf key renders, as an older caller builds one', () => {
    const { criteria } = nativeCriteria({}, { filters: { eaoStatus: ['Pending'] } }, null);
    assert.ok(!criteria.some(c => c.clause.includes('EXISTS')));
  });

  await t.test('an anyOf field that is not a declared filter is refused at route load', () => {
    assert.throws(() => assertKindSpec({ ...SPEC, anyOf: ['tags'] }), /any-of filter tags is not a declared filter/);
    assert.doesNotThrow(() => assertKindSpec({ ...SPEC, anyOf: ['eaoStatus'] }));
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
