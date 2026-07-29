'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const projects = require('../../src/repositories/projects');
const documents = require('../../src/repositories/documents');
const records = require('../../src/repositories/records');
const fragments = require('../../src/repositories/fragments');
const { TIER } = require('../../src/helpers/access-sql');

const PUBLIC = { tier: TIER.PUBLIC, roles: ['public'], projectScope: null };
const ADMIN = { tier: TIER.PRIVILEGED, roles: ['public', 'sysadmin'], projectScope: null };
const SCOPED = { tier: TIER.SCOPED, roles: ['public', 'project-team'], projectScope: ['207'] };

/**
 * Capture the spec and options a repository hands to the data layer.
 *
 * Both entry points are mocked: queryValue() calls the module-internal query() reference
 * rather than the export, so mocking query() alone would miss every count.
 */
function captureQuery(t) {
  const calls = [];
  const record = (container, spec, options = {}) => {
    // Run the real validator so a malformed spec fails the test rather than passing silently.
    cosmos.assertQuerySpec(spec, container);
    calls.push({ container, spec, options });
  };

  t.mock.method(cosmos, 'query', async (container, spec, options = {}) => {
    record(container, spec, options);
    return { items: [], continuationToken: undefined, requestCharge: 0 };
  });
  t.mock.method(cosmos, 'queryValue', async (container, spec, options = {}) => {
    record(container, spec, options);
    return 0;
  });

  return calls;
}

test('projects repository', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('anonymous list applies the ACL predicate and never a bare SELECT', async () => {
    const calls = captureQuery(t);
    await projects.listVisible(PUBLIC, {});

    const { spec } = calls[0];
    assert.match(spec.query, /^SELECT \* FROM c WHERE /);
    assert.match(spec.query, /EXISTS\(SELECT VALUE r FROM r IN c\.read/);
    assert.ok(spec.parameters.some(p => p.value === 'public'));
  });

  await t.test('privileged list is unrestricted but still well-formed', async () => {
    const calls = captureQuery(t);
    await projects.listVisible(ADMIN, {});
    assert.match(calls[0].spec.query, /WHERE true/);
  });

  await t.test('scoped list restricts to the caller partitions, keeping the ACL', async () => {
    const calls = captureQuery(t);
    await projects.listVisible(SCOPED, {});

    const { spec } = calls[0];
    assert.match(spec.query, /EXISTS/, 'role ACL must still apply');
    assert.match(spec.query, /c\.id IN \(@scope0\)/, 'partition restriction must apply');
    assert.ok(spec.parameters.some(p => p.value === '207'));
  });

  await t.test('trackOnly uses an indexed equality, not an EXISTS/!=null test', async () => {
    const calls = captureQuery(t);
    await projects.listVisible(PUBLIC, { trackOnly: true });

    const { spec } = calls[0];
    assert.match(spec.query, /c\.sourceSystem = @sourceSystem/);
    assert.ok(!spec.query.includes('sources.track'),
      'the old $exists/$ne provenance test should be gone');
  });

  await t.test('filter values are bound, never interpolated', async () => {
    const calls = captureQuery(t);
    await projects.listVisible(PUBLIC, { regionalDistrict: "'; DROP--" });

    const { spec } = calls[0];
    assert.ok(!spec.query.includes('DROP'), 'caller input must not reach the SQL text');
    assert.ok(spec.parameters.some(p => p.value === "'; DROP--"));
  });

  await t.test('count uses the IDENTICAL predicate as the list', async () => {
    const calls = captureQuery(t);
    await projects.listVisible(PUBLIC, { trackOnly: true, municipality: 'Vancouver' });
    await projects.countVisible(PUBLIC, { trackOnly: true, municipality: 'Vancouver' });

    const listWhere = calls[0].spec.query.split(' WHERE ')[1].split(' ORDER BY ')[0];
    const countWhere = calls[1].spec.query.split(' WHERE ')[1];
    assert.strictEqual(countWhere, listWhere,
      'a count built from a different filter leaks the size of an unreadable set');
    assert.match(calls[1].spec.query, /SELECT VALUE COUNT\(1\)/);
  });

  await t.test('ORDER BY targets an indexed path', async () => {
    const calls = captureQuery(t);
    await projects.listVisible(PUBLIC, {});
    // /name is in the container indexing policy. Cosmos rejects an ORDER BY on an unindexed
    // path outright rather than degrading, so this must stay in step with the Bicep.
    assert.match(calls[0].spec.query, /ORDER BY c\.name ASC$/);
  });

  await t.test('getById gates the point read', async () => {
    t.mock.method(cosmos, 'readItem', async () => ({
      id: '207', read: ['sysadmin'], isPublished: false
    }));
    assert.strictEqual(await projects.getById(PUBLIC, '207'), null,
      'a point read must not return what a list would hide');
    assert.ok(await projects.getById(ADMIN, '207'));
  });
});

test('documents repository', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a project filter scopes the query to one partition', async () => {
    const calls = captureQuery(t);
    await documents.listVisible(PUBLIC, { projectId: '207' });

    const { spec, options } = calls[0];
    assert.match(spec.query, /c\.projectId = @projectId/);
    assert.strictEqual(options.partitionKey, '207',
      'the dominant list should be single-partition');
  });

  await t.test('without a project it stays cross-partition but still ACL-filtered', async () => {
    const calls = captureQuery(t);
    await documents.listVisible(PUBLIC, {});
    assert.strictEqual(calls[0].options.partitionKey, undefined);
    assert.match(calls[0].spec.query, /EXISTS/);
  });

  await t.test('extracted:false emits an equality, not a $ne translation', async () => {
    const calls = captureQuery(t);
    await documents.listVisible(ADMIN, { extracted: false });
    // Mongo's {$ne: true} matches missing fields; SQL `!= true` excludes them. Translating
    // naively here would silently skip every document. Defaults-on-write make it an equality.
    assert.match(calls[0].spec.query, /c\.contentExtracted = @extracted/);
    assert.ok(!calls[0].spec.query.includes('!='));
  });

  await t.test('getById without a project id filters in the query, not after', async () => {
    const calls = captureQuery(t);
    await documents.getById(PUBLIC, 'doc1');
    assert.match(calls[0].spec.query, /EXISTS/,
      'an unreadable document must never reach this process');
  });
});

test('records repository', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('project name search uses CONTAINS, not a regex', async () => {
    const calls = captureQuery(t);
    await records.listVisible(PUBLIC, { projectName: 'Site C' });
    assert.match(calls[0].spec.query, /CONTAINS\(c\.projectName, @projectName, true\)/);
    assert.ok(!calls[0].spec.query.includes('RegexMatch'),
      'caller input must not become a pattern — no ReDoS surface');
  });

  await t.test('count matches the list predicate', async () => {
    const calls = captureQuery(t);
    await records.listVisible(PUBLIC, { projectId: '207', dataset: 'Inspection' });
    await records.countVisible(PUBLIC, { projectId: '207', dataset: 'Inspection' });

    const listWhere = calls[0].spec.query.split(' WHERE ')[1].split(' ORDER BY ')[0];
    assert.strictEqual(calls[1].spec.query.split(' WHERE ')[1], listWhere);
  });
});

test('fragments repository', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('ids are deterministic so a re-seed updates rather than duplicates', () => {
    assert.strictEqual(fragments.fragmentId('207', 'nrpti'), '207:nrpti');
  });

  await t.test('put refuses an empty ACL — fragments must fail closed', async () => {
    await assert.rejects(() => fragments.put('207', 'nrpti', {}, []), /non-empty read/);
    await assert.rejects(() => fragments.put('207', 'nrpti', {}, undefined), /non-empty read/);
  });

  await t.test('a caller without the fragment role gets nothing, not a stripped item', async () => {
    t.mock.method(cosmos, 'readItem', async () => ({
      id: '207:nrpti', projectId: '207', fragmentType: 'nrpti', read: ['sysadmin'], data: { x: 1 }
    }));
    assert.strictEqual(await fragments.get(PUBLIC, '207', 'nrpti'), null);
    assert.ok(await fragments.get(ADMIN, '207', 'nrpti'));
  });
});
