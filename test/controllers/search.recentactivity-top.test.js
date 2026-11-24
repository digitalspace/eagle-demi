'use strict';

// `top=true` strip rows. The updates stub honours the pinned split, else a pinned strip looks like
// an unordered one.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const updatesRepo = require('../../src/repositories/updates');
const {
  PROJECT_ROW, get, getAsStaff, updateRow, specsFor, boundValues
} = require('../helpers/search-reads');

const day = (n) => `2026-09-${String(n).padStart(2, '0')}T00:00:00.000Z`;

const update = (id, dateDay, over = {}) => updateRow({
  id, eagleId: id, type: 'News', pinned: false, dateAdded: day(dateDay), headline: `h-${id}`, ...over
});

/** Cosmos by container. `updates` answers the pinned and the unpinned read apart, newest first. */
function stubStrip(t, updates) {
  const seen = [];
  updatesRepo.forgetParents();
  t.mock.method(cosmos, 'query', async (container, spec) => {
    seen.push({ container, spec });
    if (container === 'projects') return { items: [PROJECT_ROW] };
    if (container !== 'updates') return { items: [] };
    const hidden = (spec.parameters.find(p => p.name === '@hiddenParents') || {}).value || [];
    const wantsPinned = !/NOT IS_DEFINED\(c\.pinned\)/.test(spec.query);
    const items = updates
      .filter(u => !(u.projectId && hidden.includes(String(u.projectId))))
      .filter(u => (u.pinned === true) === wantsPinned)
      .sort((a, b) => b.dateAdded.localeCompare(a.dateAdded));
    return { items };
  });
  return seen;
}

const SIX_UNPINNED = [1, 2, 3, 4, 5, 6].map(n => update(`un-${n}`, 10 - n));

test('GET /search?dataset=RecentActivity&top=true&pageSize', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('with no pageSize the strip is still four rows', async () => {
    stubStrip(t, SIX_UNPINNED);

    const { status, body } = await get('/api/search?dataset=RecentActivity&top=true');

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body[0].searchResults.map(r => r._id), ['un-1', 'un-2', 'un-3', 'un-4']);
  });

  await t.test('an explicit pageSize is the row count', async () => {
    stubStrip(t, SIX_UNPINNED);

    const { body } = await get('/api/search?dataset=RecentActivity&top=true&pageSize=5');

    assert.deepStrictEqual(body[0].searchResults.map(r => r._id),
      ['un-1', 'un-2', 'un-3', 'un-4', 'un-5']);
    assert.strictEqual(body[0].count, 5);
  });

  await t.test('pinned rows lead and the limit still caps the whole strip', async () => {
    const pinned = [1, 2, 3].map(n => update(`pin-${n}`, n, { pinned: true }));
    stubStrip(t, [...pinned, ...SIX_UNPINNED]);

    const { body } = await get('/api/search?dataset=RecentActivity&top=true&pageSize=4');

    // The pinned rows are OLDER than every unpinned one; date alone would put them last.
    assert.deepStrictEqual(body[0].searchResults.map(r => r._id),
      ['pin-3', 'pin-2', 'pin-1', 'un-1']);
  });

  for (const bad of ['0', '21', 'abc', '2.5', '-3', '']) {
    await t.test(`pageSize=${bad} is refused, not clamped`, async () => {
      stubStrip(t, SIX_UNPINNED);

      const { status, body } = await get(
        `/api/search?dataset=RecentActivity&top=true&pageSize=${bad}`);

      assert.strictEqual(status, 400);
      assert.match(body.error, /pageSize must be an integer from 1 to 20/);
    });
  }

  // Both halves of the strip must carry the caller's ACL, or an unpublished update reaches the home page.
  await t.test('both strip reads carry the anonymous ACL, and staff widens them', async () => {
    const anonSeen = stubStrip(t, SIX_UNPINNED);
    await get('/api/search?dataset=RecentActivity&top=true');
    const anon = specsFor(anonSeen, 'updates').map(boundValues);
    t.mock.restoreAll();
    const staffSeen = stubStrip(t, SIX_UNPINNED);
    await getAsStaff(t, '/api/search?dataset=RecentActivity&top=true');
    const staff = specsFor(staffSeen, 'updates').map(boundValues);

    assert.strictEqual(anon.length, 2);
    for (const values of anon) assert.ok(values.includes('public') && !values.includes('staff'), values.join());
    assert.strictEqual(staff.length, 2);
    for (const values of staff) assert.ok(values.includes('staff'), values.join());
  });
});
