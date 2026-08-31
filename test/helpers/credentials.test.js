'use strict';

/**
 * Selected Credentials — the grant, the window, and the one extra OR arm.
 *
 * The dangerous direction here is a grant that reaches further than it says: further in ids,
 * further in levels, or further in time. Every case below is written against that, and the SQL and
 * OData assertions exist because `canRead` alone cannot see the two predicates a list read and a
 * search actually run.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  resolveAccess, canRead, visibilityFor, matchesLevels, levelOfRead
} = require('../../src/helpers/access-sql');
const { filterFor } = require('../../src/helpers/access-odata');
const { grantError, isLive, liveCredentials } = require('../../src/helpers/credentials');
const cosmos = require('../../src/db/cosmos-nosql');
const credentialsRepo = require('../../src/repositories/credentials');

const HOLDER = { sub: 'bceid-sub-1', preferred_username: 'external.person' };
const IN_A_YEAR = new Date(Date.now() + 365 * 86400000).toISOString();
const YESTERDAY = new Date(Date.now() - 86400000).toISOString();

/** A grant as the API stores it. */
function grant(overrides = {}) {
  return {
    id: 'cred-1',
    party: { type: 'user', id: HOLDER.sub },
    scope: { type: 'project', ids: ['207'] },
    levels: [1, 2],
    start: YESTERDAY,
    end: IN_A_YEAR,
    grantedBy: 'sys.admin',
    grantedAt: YESTERDAY,
    revokedAt: null,
    batchId: 'batch-1',
    note: '',
    ...overrides
  };
}

/** The access context the middleware + resolveAccess produce for a credential holder. */
function accessWith(credentials) {
  return resolveAccess({ user: HOLDER, credentials: liveCredentials(credentials) });
}

// Rows, by the level their read[] puts them at.
const LEVEL_1 = { id: '207', read: ['team'] };
const LEVEL_2 = { id: '207', read: ['staff', 'sysadmin'] };
const LEVEL_3 = { id: '207', read: ['staff', 'idir'] };
const OTHER_PROJECT = { id: '311', read: ['staff'] };
const DOCUMENT = { id: 'd1', projectId: '207', read: ['staff'] };

test('a grant without an end is refused', () => {
  const { end: _dropped, ...noEnd } = grant();
  assert.match(grantError(noEnd), /end is required/);

  // And every other refusal the endpoint owes, in the same shape.
  assert.match(grantError(grant({ end: YESTERDAY })), /future/);
  assert.match(grantError(grant({ levels: [0, 1] })), /cannot be granted/);
  assert.match(grantError(grant({ levels: [4] })), /cannot be granted/);
  assert.match(grantError(grant({ party: { type: 'robot', id: 'x' } })), /party\.type/);
  assert.match(grantError(grant({ scope: { type: 'chunk', ids: ['1'] } })), /scope\.type/);
  assert.match(
    grantError(grant({ scope: { type: 'project', ids: Array.from({ length: 201 }, (_, i) => `${i}`) } })),
    /at most 200/);

  // 200 is the ceiling, not one under it, and a valid grant passes.
  assert.strictEqual(
    grantError(grant({ scope: { type: 'project', ids: Array.from({ length: 200 }, (_, i) => `${i}`) } })),
    null);
  assert.strictEqual(grantError(grant()), null);
});

test('an expired credential grants nothing', () => {
  const expired = grant({ end: YESTERDAY });

  assert.strictEqual(isLive(expired), false);
  assert.deepStrictEqual(liveCredentials([expired]), [], 'dropped before it reaches resolveAccess');
  assert.strictEqual(canRead(LEVEL_2, accessWith([expired]), 'id'), false);

  // Live is the other half of the same check, or the case above would pass against a broken filter.
  assert.strictEqual(canRead(LEVEL_2, accessWith([grant()]), 'id'), true);

  // A grant whose window has not opened yet is equally inert.
  const future = grant({ start: IN_A_YEAR });
  assert.strictEqual(canRead(LEVEL_2, accessWith([future]), 'id'), false);
});

test('a revoked credential grants nothing', () => {
  const revoked = grant({ revokedAt: new Date().toISOString() });

  assert.strictEqual(isLive(revoked), false);
  assert.strictEqual(canRead(LEVEL_2, accessWith([revoked]), 'id'), false);
  assert.strictEqual(visibilityFor(accessWith([revoked]), 'id').params.some(p => p.value === '207'),
    false, 'a revoked grant leaves no id bound into the query either');
});

test('a document-scoped grant is no sight of the project with the same id', () => {
  // On the projects container (partitionField 'id') a document-scoped grant compares nothing:
  // scope.ids hold DOCUMENT ids, and a project sharing one of those strings must not match.
  const access = accessWith([grant({ scope: { type: 'document', ids: ['207'] } })]);
  assert.strictEqual(canRead(LEVEL_2, access, 'id'), false);
  assert.strictEqual(visibilityFor(access, 'id').params.some(p => p.value === '207'), false,
    'no document id is bound into a projects query');
});

test('a credential at levels [3] does not reach a level-1 record', () => {
  const access = accessWith([grant({ levels: [3] })]);

  assert.strictEqual(canRead(LEVEL_1, access, 'id'), false);
  assert.strictEqual(canRead(LEVEL_3, access, 'id'), true);

  // The ceiling in the other direction: levels 1-2 must not pick up the level-3 row, which carries
  // `staff` because levels 2-4 nest. Token containment alone would let it through.
  const lower = accessWith([grant({ levels: [1, 2] })]);
  assert.strictEqual(canRead(LEVEL_3, lower, 'id'), false);
  assert.strictEqual(canRead(LEVEL_1, lower, 'id'), true);
  assert.strictEqual(canRead(LEVEL_2, lower, 'id'), true);

  // A row carrying no ladder token at all reads as level 1, and stays privileged-only regardless.
  assert.strictEqual(levelOfRead([]), 1);
  assert.strictEqual(matchesLevels([], [1]), false);
  assert.strictEqual(canRead({ id: '207', read: [] }, lower, 'id'), false);
});

test('a credential grants only its own ids', () => {
  const access = accessWith([grant()]);

  assert.strictEqual(canRead(LEVEL_2, access, 'id'), true);
  assert.strictEqual(canRead(OTHER_PROJECT, access, 'id'), false);

  // The project-scoped grant reaches that project's documents, which carry it as `projectId` —
  // the same field the team arm compares.
  assert.strictEqual(canRead(DOCUMENT, access, 'projectId'), true);
  assert.strictEqual(canRead({ ...DOCUMENT, projectId: '311' }, access, 'projectId'), false);

  // A DOCUMENT-scoped grant names the records themselves, and is not sight of their project.
  const docGrant = accessWith([grant({ scope: { type: 'document', ids: ['d1'] } })]);
  assert.strictEqual(canRead(DOCUMENT, docGrant, 'projectId'), true);
  assert.strictEqual(canRead({ ...DOCUMENT, id: 'd2' }, docGrant, 'projectId'), false);
  assert.strictEqual(canRead(LEVEL_2, docGrant, 'id'), false, 'a document grants no project row');
});

test('the SQL predicate carries the same grant, bound not interpolated', () => {
  // canRead is the point-read twin; this is what a LIST read runs, and nothing else in the suite
  // would notice the arm being deleted from it.
  const { clause, params } = visibilityFor(accessWith([grant()]), 'id');

  assert.match(clause, /c\.id IN \(@roleC0_0\)/, 'the scope ids are an OR arm on the partition field');
  assert.match(clause, /AND EXISTS\(SELECT VALUE r FROM r IN c\.read WHERE r IN \(@roleCG0_0, @roleCG0_1\)\)/,
    'and the granted levels are the ladder tokens the role arm already uses');
  assert.match(clause, /AND NOT EXISTS\(SELECT VALUE r FROM r IN c\.read WHERE r IN \(@roleCW0_0, @roleCW0_1\)\)/,
    'with the ceiling that stops levels 2-4 nesting the grant upward');

  const value = (name) => params.find(p => p.name === name).value;
  assert.strictEqual(value('@roleC0_0'), '207');
  assert.deepStrictEqual([value('@roleCG0_0'), value('@roleCG0_1')], ['team', 'staff']);
  assert.deepStrictEqual([value('@roleCW0_0'), value('@roleCW0_1')], ['idir', 'public']);

  // No caller value reaches the SQL text.
  assert.ok(!clause.includes('207'));

  // A boundary-shaped container has no project axis, so the arm is skipped rather than compared
  // against a field the rows do not carry.
  assert.ok(!visibilityFor(accessWith([grant()]), null).clause.includes('roleC0_0'));
});

test('the search filter carries the same grant', () => {
  const { filter, empty } = filterFor(accessWith([grant()]), 'id');

  assert.strictEqual(empty, false);
  assert.match(filter, /search\.in\(id, '207', ','\)/);
  assert.match(filter, /read\/any\(r: search\.in\(r, 'team,staff', ','\)\)/);
  assert.match(filter, /not read\/any\(r: search\.in\(r, 'idir,public', ','\)\)/);

  // ORed with the role arm — a grant widens, it never narrows what the caller could already see.
  assert.match(filter, /^\(read\/any\(r: search\.in\(r, 'public', ','\)\) or /);

  // An anonymous caller holding nothing gets the filter it got before credentials existed.
  assert.strictEqual(filterFor(resolveAccess({}), 'id').filter,
    "read/any(r: search.in(r, 'public', ','))");
});

test('a document-scoped grant filters on the field THIS index carries', () => {
  const access = accessWith([grant({ scope: { type: 'document', ids: ['d1'] } })]);

  // Documents hold the grant's ids in `id`; chunks hold them in `documentId`, and a chunk's own
  // `id` is not filterable — filtering on it is a 400 from the service, not a narrower result.
  assert.match(filterFor(access, 'projectId', 'id').filter, /search\.in\(id, 'd1', ','\)/);
  assert.match(filterFor(access, 'projectId', 'documentId').filter,
    /search\.in\(documentId, 'd1', ','\)/);

  // Unnamed — the projects index — the grant matches nothing rather than naming a missing field.
  assert.strictEqual(filterFor(access, 'id').filter, "read/any(r: search.in(r, 'public', ','))");
  assert.strictEqual(filterFor(access, 'projectId').filter,
    "read/any(r: search.in(r, 'public', ','))");
});

test('a credential changes no record', () => {
  const row = { id: '207', read: ['staff', 'sysadmin'], isPublished: false, name: 'Skeena LNG' };
  const before = JSON.stringify(row);

  assert.strictEqual(canRead(row, accessWith([grant()]), 'id'), true);

  assert.strictEqual(JSON.stringify(row), before, 'the row is read, never rewritten');
  assert.deepStrictEqual(row.read, ['staff', 'sysadmin']);
});

test('closing a project revokes its credentials', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const stored = [
    grant({ id: 'c1', party: { type: 'user', id: 'u1' } }),
    grant({ id: 'c2', party: { type: 'group', id: 'g1' } }),
    grant({ id: 'c3', party: { type: 'user', id: 'u2' }, scope: { type: 'project', ids: ['311'] } })
  ];

  // A miniature evaluator rather than a canned answer: it reads the clause the repository sent and
  // applies it. A revoke that forgot the project binding, or the live guard, returns three rows
  // here and fails the count below.
  const queries = [];
  t.mock.method(cosmos, 'query', async (container, spec) => {
    queries.push({ container, spec });
    const projectId = (spec.parameters.find(p => p.name === '@projectId') || {}).value;
    const items = stored.filter(row =>
      (!/c\.scope\.type = 'project'/.test(spec.query) || row.scope.type === 'project') &&
      (!/ARRAY_CONTAINS\(c\.scope\.ids, @projectId\)/.test(spec.query) ||
        row.scope.ids.includes(projectId)) &&
      (!/IS_NULL\(c\.revokedAt\)/.test(spec.query) || !row.revokedAt));
    return { items };
  });

  const patched = [];
  t.mock.method(cosmos, 'patch', async (container, id, pk, operations) => {
    patched.push({ container, id, pk, operations });
    return {};
  });

  const revoked = await credentialsRepo.revokeForProject('207', 'project-closed');

  assert.strictEqual(queries[0].container, 'credentials');
  assert.deepStrictEqual(revoked.map(r => r.id), ['c1', 'c2']);
  assert.strictEqual(patched.length, 2, 'the grant over another project is untouched');
  assert.deepStrictEqual(patched.map(p => p.pk), ['u1', 'g1'], 'patched in the party partition');
  assert.strictEqual(patched[0].operations.length, 1);
  assert.strictEqual(patched[0].operations[0].op, 'set');
  assert.strictEqual(patched[0].operations[0].path, '/revokedAt');
  assert.ok(patched[0].operations[0].value, 'stamped, never deleted — the row is the record');
});
