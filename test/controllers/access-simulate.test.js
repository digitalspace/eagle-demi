'use strict';

/**
 * POST /api/access/simulate answers with the REAL engine, so this suite is written as literals: a
 * table of callers and exactly what each of them reaches. Recomputing the expectation from
 * access-sql.js would make it pass whatever the ladder did next, which is the failure this
 * endpoint exists to prevent in the frontend.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { simulate } = require('../../src/controllers/access-simulate');
const { CATALOGS } = require('../../src/vis/catalog');
const { withServer } = require('../helpers/with-server');

function run(body) {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };
  simulate({ body }, res);
  return res;
}

/** `via` is the whole row: a level is readable exactly when some arm reached it. */
function rows(via) {
  return Object.fromEntries(Object.entries(via).map(([l, v]) => [l, { readable: v !== null, via: v }]));
}

const PROJECT_207 = { scope: { type: 'project', ids: ['207'] }, levels: [2] };

const CASES = [
  {
    name: 'an empty body is the anonymous caller: level 4, and only the public row',
    body: {},
    me: { roles: ['public'], level: 4, tier: 'public', privileged: false, staffUi: false },
    via: { 1: null, 2: null, 3: null, 4: 'role' }
  },
  {
    name: 'staff reads levels 2-4 on its role, and never level 1',
    body: { roles: ['staff'] },
    me: { roles: ['public', 'staff'], level: 2, tier: 'public', privileged: false, staffUi: true },
    via: { 1: null, 2: 'role', 3: 'role', 4: 'role' }
  },
  {
    name: 'a team grants staff the level-1 row of its own project',
    body: { roles: ['staff'], teams: ['207'] },
    me: { roles: ['public', 'staff'], level: 2, tier: 'public', privileged: false, staffUi: true },
    via: { 1: 'team', 2: 'role', 3: 'role', 4: 'role' }
  },
  {
    name: 'a levels:[2] credential reaches level 2 exactly — not the level-3 row above it',
    body: { roles: ['public'], credential: PROJECT_207 },
    me: { roles: ['public'], level: 4, tier: 'public', privileged: false, staffUi: false },
    via: { 1: null, 2: 'credential', 3: null, 4: 'role' }
  },
  {
    name: 'sysadmin is privileged: level 1 and every row',
    body: { roles: ['sysadmin'] },
    me: { roles: ['public', 'sysadmin'], level: 1, tier: 'privileged', privileged: true, staffUi: true },
    via: { 1: 'role', 2: 'role', 3: 'role', 4: 'role' }
  },
  {
    name: 'compliance is level 2 on the field plane and reaches no staff row',
    body: { roles: ['compliance'] },
    me: { roles: ['public', 'compliance'], level: 2, tier: 'public', privileged: false, staffUi: false },
    via: { 1: null, 2: null, 3: null, 4: 'role' }
  },
  {
    name: 'an IDIR login with no realm role is level 3',
    body: { identityProvider: 'idir' },
    me: { roles: ['public', 'idir'], level: 3, tier: 'public', privileged: false, staffUi: false },
    via: { 1: null, 2: null, 3: 'role', 4: 'role' }
  },
  {
    name: 'a realm role named idir or team is stripped, exactly as on a real token',
    body: { roles: ['idir', 'team', 'staff'] },
    me: { roles: ['public', 'staff'], level: 2, tier: 'public', privileged: false, staffUi: true },
    via: { 1: null, 2: 'role', 3: 'role', 4: 'role' }
  },
  {
    name: 'a projectScope makes the tier scoped and leaves the grants alone',
    body: { roles: ['staff'], teams: ['207'], projectScope: ['207'] },
    me: { roles: ['public', 'staff'], level: 2, tier: 'scoped', privileged: false, staffUi: true },
    via: { 1: 'team', 2: 'role', 3: 'role', 4: 'role' }
  },
  {
    name: 'a scope that excludes the probed project reaches nothing at all',
    // The restriction is ANDed in front of every arm, so a staff key minted for another project
    // reads none of these rows — the leak resolveAccess was fixed to prevent.
    body: { roles: ['staff'], projectScope: ['999'] },
    me: { roles: ['public', 'staff'], level: 2, tier: 'scoped', privileged: false, staffUi: true },
    via: { 1: null, 2: null, 3: null, 4: null }
  }
];

const BAD_BODIES = [
  { name: 'an unknown key', body: { role: ['staff'] }, error: /unknown field\(s\): role/ },
  { name: 'roles as a string', body: { roles: 'staff' }, error: /roles must be an array of strings/ },
  { name: 'an empty team id', body: { teams: [''] }, error: /teams must be an array of strings/ },
  {
    name: 'an unknown identity provider',
    body: { identityProvider: 'twitter' },
    error: /identityProvider must be one of idir, bceid, github/
  },
  {
    name: 'a credential level nobody may grant',
    body: { credential: { scope: { type: 'project', ids: ['207'] }, levels: [4] } },
    error: /levels 4 cannot be granted/
  },
  {
    name: 'a credential scope type that does not exist',
    body: { credential: { scope: { type: 'chunk', ids: ['207'] }, levels: [2] } },
    error: /scope.type must be one of document, project/
  },
  {
    name: 'a credential with no ids',
    body: { credential: { scope: { type: 'project', ids: [] }, levels: [2] } },
    error: /scope.ids must be a non-empty array/
  },
  {
    name: 'a credential carrying a window of its own',
    body: { credential: { scope: { type: 'project', ids: ['207'] }, levels: [2], end: '2099-01-01' } },
    error: /unknown credential field\(s\): end/
  }
];

test('access simulate', async (t) => {
  for (const testCase of CASES) {
    await t.test(testCase.name, () => {
      const res = run(testCase.body);

      assert.strictEqual(res.statusCode, 200);
      const { rows: got, fields, predicatesAssumedFalse, notes, ...me } = res.body;
      assert.deepStrictEqual(me, testCase.me);
      assert.deepStrictEqual(got, rows(testCase.via));
      assert.strictEqual(predicatesAssumedFalse, true);
      assert.strictEqual(notes.sealedCompartment, 'designed, not built (Phase 5)');
      assert.ok(fields.projects.length > 0 && fields.documents.length > 0);
    });
  }

  for (const bad of BAD_BODIES) {
    await t.test(`400 on ${bad.name}`, () => {
      const res = run(bad.body);

      assert.strictEqual(res.statusCode, 400);
      assert.match(res.body.error, bad.error);
      assert.strictEqual(res.body.rows, undefined, 'a refused body is answered, never simulated');
    });
  }

  await t.test('a credential moves rows and changes no field', () => {
    // The two planes are orthogonal: a grant says which RECORDS, the caller's level says which
    // ATTRIBUTES of one. A credential that widened a field would be the bug this asserts against.
    const plain = run({ roles: ['staff'] }).body;
    const granted = run({
      roles: ['staff'],
      credential: { scope: { type: 'project', ids: ['207'] }, levels: [1] }
    }).body;

    assert.deepStrictEqual(granted.fields, plain.fields);
    assert.strictEqual(granted.level, plain.level);
    // Not vacuous: the grant really was applied, it just applied on the row plane.
    assert.deepStrictEqual(granted.rows['1'], { readable: true, via: 'credential' });
    assert.deepStrictEqual(plain.rows['1'], { readable: false, via: null });
  });

  await t.test('every catalogued field is listed, plumbing keys included', () => {
    const body = run({}).body;

    for (const entity of ['projects', 'documents']) {
      assert.deepStrictEqual(
        body.fields[entity].map(f => f.field), Object.keys(CATALOGS[entity]),
        `${entity} fields must be the catalog itself — the frontend decides what to show`);
    }

    const read = body.fields.projects.find(f => f.field === 'read');
    assert.deepStrictEqual(read, { field: 'read', defaultVis: 0, maxVis: 0, when: null, visible: false });
  });

  await t.test('a predicate field is reported at its defaultVis, with the predicate named', () => {
    // cacEmail is 2/4 behind `cacPublished`. No record is simulated, so the predicate reads false
    // and the field sits at 2 — visible to staff, withheld from the public.
    const anonymous = run({}).body.fields.projects.find(f => f.field === 'cacEmail');
    const staff = run({ roles: ['staff'] }).body.fields.projects.find(f => f.field === 'cacEmail');

    assert.deepStrictEqual(anonymous,
      { field: 'cacEmail', defaultVis: 2, maxVis: 4, when: 'cacPublished', visible: false });
    assert.strictEqual(staff.visible, true);
  });

  await t.test('the mounted route answers an anonymous POST', async () => {
    await withServer(async (call) => {
      const res = await call('/api/access/simulate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roles: ['staff'], teams: ['207'] })
      });

      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.level, 2);
      assert.deepStrictEqual(body.rows['1'], { readable: true, via: 'team' });

      const refused = await call('/api/access/simulate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nope: true })
      });
      assert.strictEqual(refused.status, 400);
    });
  });
});
