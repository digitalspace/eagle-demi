'use strict';

/**
 * The registry is the thing being written, so the repository is an in-memory fake and every
 * assertion is on what it was ASKED to write — literal field values, literal ACL arrays.
 * Nothing here reaches Track or Cosmos.
 *
 * The load-bearing case is `'a changed name leaves the level where it was'`: the sync re-runs
 * `mergeTrackProject`, which derives `read` from the Eagle record, so without the carry every
 * night would silently reset a level `PUT /api/projects/:id/level` set.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { syncProjects, trackChanges } = require('../../src/scripts/sync-track-projects');
const { needsClosing } = require('../../src/scripts/close-unpublished-track-projects');
const { trackApiToExtract } = require('../../src/seed/sources');
const { mergeTrackProject } = require('../../src/merge/project');
const { readForLevel } = require('../../src/helpers/access-sql');

const NOW = '2026-09-02T00:00:00.000Z';

/** One row of `GET /api/v1/projects`, fields as measured on test 2026-09-02. */
const API_PROJECT = {
  id: 207,
  name: 'Nicomen Wind Energy',
  description: 'Proponent proposes to construct 35 - 2.0 MW wind turbines.',
  epic_guid: '58851172aaecd9001b820335',
  latitude: '50.2',
  longitude: '-121.4',
  address: 'Lytton',
  abbreviation: 'NICWIN',
  is_active: true,
  is_project_closed: true,
  project_state: { name: 'Closed' },
  project_state_id: 6,
  type: { name: 'Energy - Electricity' },
  sub_type: { name: 'Power Plants' },
  proponent: { name: 'Premier Renewable Energy' },
  ea_certificate: 'Withdrawn',
  eac_expires: null,
  eac_signed: null,
  region_env: 'Thompson-Okanagan',
  region_flnro: 'Thompson / Okanagan',
  created_at: '2019-11-04T20:23:41.664000'
};

const FLAT = trackApiToExtract(API_PROJECT);

/**
 * A stored record as the merge writes it, then widened to level 4 and classified — i.e. what the
 * ladder and the sysadmin own, which no re-merge may touch.
 */
function storedProject(overrides = {}) {
  return {
    ...mergeTrackProject(FLAT, null, { now: '2026-08-01T00:00:00.000Z' }),
    read: readForLevel(4),
    isPublished: true,
    vis: { eacExpires: 3 },
    regionalDistrict: 'Thompson-Nicola',
    ...overrides
  };
}

/** The projects repository, in memory. `deleteById` throws: this sync deletes nothing, ever. */
function fakeProjects(rows = []) {
  const items = rows.map(r => JSON.parse(JSON.stringify(r)));
  const writes = [];
  return {
    items, writes,
    listVisible: async () => ({ items }),
    upsert: async (project) => { writes.push(project); return project; },
    deleteById: async () => { throw new Error('the project sync must never delete'); }
  };
}

test('the mapper flattens a live project into the shape the merge reads', () => {
  assert.deepStrictEqual(trackApiToExtract(API_PROJECT), {
    track_project_id: 207,
    name: 'Nicomen Wind Energy',
    description: 'Proponent proposes to construct 35 - 2.0 MW wind turbines.',
    epic_guid: '58851172aaecd9001b820335',
    latitude: '50.2',
    longitude: '-121.4',
    address: 'Lytton',
    abbreviation: 'NICWIN',
    is_active: true,
    proponent_name: 'Premier Renewable Energy',
    sub_type_name: 'Power Plants',
    type_name: 'Energy - Electricity',
    project_state_name: 'Closed',
    ea_certificate: 'Withdrawn'
  });
});

test('the mapper produces exactly the keys the checked-in export carries', () => {
  const file = path.join(__dirname, '../../src/data/track_projects_enriched.json');
  const [sample] = JSON.parse(fs.readFileSync(file, 'utf8'));

  assert.deepStrictEqual(Object.keys(trackApiToExtract(API_PROJECT)).sort(), Object.keys(sample).sort(),
    'the live feed replaces the file, so a key the file has and the feed lacks is data lost');
});

test('a project state sent as a bare string maps the same as a nested one', () => {
  const bare = { ...API_PROJECT, project_state: 'Closed', type: 'Energy - Electricity' };

  assert.strictEqual(trackApiToExtract(bare).project_state_name, 'Closed');
  assert.strictEqual(trackApiToExtract(bare).type_name, 'Energy - Electricity');
});

test('a changed name leaves the level where it was', async () => {
  const projects = fakeProjects([storedProject()]);
  const renamed = { ...API_PROJECT, name: 'Nicomen Wind Energy Project' };

  const summary = await syncProjects([renamed], { live: true, deps: { projects }, now: NOW });

  assert.strictEqual(summary.updated, 1);
  assert.strictEqual(summary.created, 0);
  assert.strictEqual(projects.writes.length, 1);

  const [written] = projects.writes;
  assert.strictEqual(written.name, 'Nicomen Wind Energy Project', 'the Track field is what moves');
  assert.deepStrictEqual(written.read, readForLevel(4),
    'a re-merge with no Eagle record derives level 2 — the stored level has to win');
  assert.strictEqual(written.isPublished, true);
  assert.deepStrictEqual(written.vis, { eacExpires: 3 }, 'an upsert replaces the whole item');
  assert.strictEqual(written.regionalDistrict, 'Thompson-Nicola');
  assert.strictEqual(written.sources.track.name, 'Nicomen Wind Energy Project',
    'the raw payload is refreshed with the row');
  assert.strictEqual(written.updatedAt, NOW);
});

test('a project Track has not changed is not written at all', async () => {
  const projects = fakeProjects([storedProject()]);

  const summary = await syncProjects([API_PROJECT], { live: true, deps: { projects }, now: NOW });

  assert.deepStrictEqual(projects.writes, [], 'a nightly rewrite of 384 unchanged rows is churn');
  assert.strictEqual(summary.updated, 0);
  assert.strictEqual(summary.trackProjects, 1);
});

test('a project DEMI has never seen is created at level 1', async () => {
  const projects = fakeProjects([]);

  const summary = await syncProjects([API_PROJECT], { live: true, deps: { projects }, now: NOW });

  assert.strictEqual(summary.created, 1);
  const [written] = projects.writes;
  assert.strictEqual(written.id, '207');
  assert.deepStrictEqual(written.read, readForLevel(1),
    'admission is level 1; the merge default of 2 would publish to all of EAO');
  assert.strictEqual(written.isPublished, false);
  assert.strictEqual(written.name, 'Nicomen Wind Energy');
  assert.strictEqual(written.eaCertificate, 'Withdrawn');
});

test('a record the feed no longer lists is counted, not deleted', async () => {
  const projects = fakeProjects([
    storedProject(),
    { ...storedProject(), id: '999', sourceSystem: 'track' },
    { id: 'eagle-abc', sourceSystem: 'eagle', read: readForLevel(4) }
  ]);

  const summary = await syncProjects([API_PROJECT], { live: true, deps: { projects }, now: NOW });

  assert.strictEqual(summary.orphaned, 1, 'the Eagle-only record is not Track\'s to orphan');
  assert.strictEqual(projects.items.length, 3, 'and every row is still there');
  assert.deepStrictEqual(projects.writes, []);
});

test('a dry run writes nothing and still counts what a live run would do', async () => {
  const projects = fakeProjects([storedProject()]);
  const renamed = { ...API_PROJECT, name: 'Renamed' };
  const fresh = { ...API_PROJECT, id: 412, name: 'Brand New' };

  const summary = await syncProjects([renamed, fresh], { deps: { projects }, now: NOW });

  assert.deepStrictEqual(projects.writes, []);
  assert.strictEqual(summary.updated, 1);
  assert.strictEqual(summary.created, 1);
  assert.strictEqual(summary.trackProjects, 2);
});

/**
 * `POST /projects`, as `createProject` writes it: `sources: {}` and `eagleId: null`, then widened
 * to level 4 through `PUT /:id/level`. Under a Track id, because that is the collision that makes
 * it reachable from the feed at all.
 */
function apiProject(overrides = {}) {
  return {
    id: '207',
    trackProjectId: 207,
    eagleId: null,
    sourceSystem: 'track',
    name: 'Hand-created project',
    sources: {},
    read: readForLevel(4),
    isPublished: true,
    ...overrides
  };
}

test('a row created through POST /projects is left alone, not reclassified', async () => {
  const stored = apiProject();
  const projects = fakeProjects([stored]);
  assert.strictEqual(needsClosing(stored), false, 'the premise: nothing would close it today');

  const summary = await syncProjects([API_PROJECT], { live: true, deps: { projects }, now: NOW });

  assert.strictEqual(summary.skippedApiRows, 1);
  assert.strictEqual(summary.updated, 0);
  assert.deepStrictEqual(projects.writes, []);
  const [after] = projects.items;
  assert.deepStrictEqual(after, stored, 'byte-identical');
  assert.strictEqual((after.sources || {}).track, undefined,
    'the discriminator close-unpublished reads must stay absent');
  assert.strictEqual(needsClosing(after), false,
    'stamping sources.track on would strip public from a deliberately published row');
});

/** The Eagle-only row the merge writes when Track has no counterpart yet. */
function eagleOnlyProject(overrides = {}) {
  return {
    id: `eagle-${API_PROJECT.epic_guid}`,
    trackProjectId: null,
    eagleId: API_PROJECT.epic_guid,
    sourceSystem: 'eagle',
    name: 'Nicomen Wind Energy',
    read: readForLevel(4),
    isPublished: true,
    vis: { eacExpires: 3 },
    regionalDistrict: 'Thompson-Nicola',
    sources: { track: null, eagle: { _id: API_PROJECT.epic_guid, name: 'Nicomen Wind Energy' } },
    ...overrides
  };
}

test('a project stored as Eagle-only is re-keyed to its Track id, not duplicated', async () => {
  const projects = fakeProjects([eagleOnlyProject()]);

  const summary = await syncProjects([API_PROJECT], { live: true, deps: { projects }, now: NOW });

  assert.strictEqual(summary.relinked, 1);
  assert.strictEqual(summary.created, 0, 'a second row for a project DEMI already holds');
  assert.strictEqual(projects.writes.length, 1);

  const [written] = projects.writes;
  assert.strictEqual(written.id, '207', 'the Track id wins, as buildRegistry keys a matched pair');
  assert.strictEqual(written.eagleId, API_PROJECT.epic_guid);
  assert.strictEqual(written.sourceSystem, 'track');
  assert.deepStrictEqual(written.read, readForLevel(4), 'a re-key must not move a level');
  assert.strictEqual(written.isPublished, true);
  assert.deepStrictEqual(written.vis, { eacExpires: 3 });
  assert.strictEqual(written.regionalDistrict, 'Thompson-Nicola');
  assert.ok(written.sources.track, 'and it is a merge-produced Track row from now on');
});

test('an empty Track column does not blank a populated row', () => {
  const stored = storedProject();
  const merged = mergeTrackProject({ ...FLAT, ea_certificate: '' }, null, { now: NOW });

  assert.deepStrictEqual(trackChanges(stored, merged), {},
    'the merge omits what Track no longer supplies, so there is nothing to write');
});

test('one project that fails is counted and does not stop the next', async () => {
  const projects = fakeProjects([]);
  let first = true;
  projects.upsert = async (project) => {
    if (first) { first = false; throw new Error('cosmos said no'); }
    projects.writes.push(project);
  };

  const summary = await syncProjects(
    [API_PROJECT, { ...API_PROJECT, id: 412 }], { live: true, deps: { projects }, now: NOW });

  assert.strictEqual(summary.failures, 1);
  assert.strictEqual(projects.writes.length, 1, 'project 412 is still written');
});

test('no COSMOS_ENDPOINT reports zero instead of reaching for Cosmos', async (t) => {
  const held = process.env.COSMOS_ENDPOINT;
  delete process.env.COSMOS_ENDPOINT;
  t.after(() => { if (held !== undefined) process.env.COSMOS_ENDPOINT = held; });

  const summary = await syncProjects([API_PROJECT], { live: true, now: NOW });

  assert.deepStrictEqual(summary,
    { trackProjects: 1, created: 0, updated: 0, relinked: 0, skippedApiRows: 0, orphaned: 0,
      failures: 0 },
    'the feed side still counts; the write side is honestly zero');
});
