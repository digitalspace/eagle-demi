'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const trackProjects = require('../../src/data/track_projects_enriched.json');
const {
  mergeTrackProject,
  mergeEagleOnlyProject,
  buildRegistry,
  buildProjectIndex,
  normalizeCentroid,
  resolveProjectAcl,
  BC_BBOX,
  SECURE_ROLES
} = require('../../src/merge/project');

const inBC = (lng, lat) =>
  lng >= BC_BBOX.minLng && lng <= BC_BBOX.maxLng &&
  lat >= BC_BBOX.minLat && lat <= BC_BBOX.maxLat;

const NOW = '2026-07-30T00:00:00.000Z';
const OPTS = { now: NOW };

// A real Track record, and a real-shaped Eagle project for it.
const TRACK_207 = trackProjects.find(p => p.track_project_id === 207);

function eagleFor(track, overrides = {}) {
  return {
    _id: track.epic_guid,
    name: `${track.name} (Eagle)`,
    description: 'Eagle description',
    type: 'Energy - Electricity',
    status: 'Operating',
    shortName: 'EAGLESHORT',
    location: 'Eagle location',
    activeStatus: true,
    centroid: [-122.9, 49.1],
    eaStatus: 'Certificate Issued',
    eacDecision: 'Certificate Issued',
    currentPhaseName: 'Post Certification',
    legislation: 2002,
    projectLead: 'Some Person',
    sector: 'Energy - Electricity',
    read: ['public', 'sysadmin', 'staff'],
    ...overrides
  };
}

test('field precedence — Track wins, Eagle fills gaps', async (t) => {
  await t.test('Track values beat Eagle values', () => {
    const merged = mergeTrackProject(TRACK_207, eagleFor(TRACK_207), OPTS);
    assert.strictEqual(merged.name, TRACK_207.name);
    assert.strictEqual(merged.description, TRACK_207.description);
    assert.strictEqual(merged.projectState, TRACK_207.project_state_name);
    assert.strictEqual(merged.abbreviation, TRACK_207.abbreviation);
  });

  await t.test('an EMPTY Track field falls back to Eagle instead of blanking it', () => {
    // The single highest-consequence rule here: a spread merge would write undefined over a
    // populated Eagle value and silently destroy data. 12 real Track records have no
    // abbreviation, so this path is exercised by the actual dataset, not just this test.
    const gapped = { ...TRACK_207, abbreviation: '', description: null, address: '   ' };
    const merged = mergeTrackProject(gapped, eagleFor(TRACK_207), OPTS);

    assert.strictEqual(merged.abbreviation, 'EAGLESHORT');
    assert.strictEqual(merged.description, 'Eagle description');
    assert.strictEqual(merged.address, 'Eagle location');
  });

  await t.test('a field neither source has is simply absent, not null', () => {
    const gapped = { ...TRACK_207, abbreviation: '' };
    const merged = mergeTrackProject(gapped, eagleFor(TRACK_207, { shortName: '' }), OPTS);
    assert.ok(!('abbreviation' in merged));
  });

  await t.test('Eagle-only fields come across; absent ones are not fabricated', () => {
    const merged = mergeTrackProject(TRACK_207, eagleFor(TRACK_207), OPTS);
    assert.strictEqual(merged.eaStatus, 'Certificate Issued');
    assert.strictEqual(merged.currentPhaseName, 'Post Certification');
    assert.strictEqual(merged.legislation, 2002);
    assert.ok(!('cacEmail' in merged), 'a field Eagle did not supply must not appear');
  });

  await t.test('with no Eagle match, only Track fields are present', () => {
    const merged = mergeTrackProject(TRACK_207, null, OPTS);
    assert.strictEqual(merged.name, TRACK_207.name);
    assert.strictEqual(merged.eagleId, TRACK_207.epic_guid);
    assert.ok(!('eaStatus' in merged));
    assert.strictEqual(merged.sources.eagle, null);
  });

  await t.test('identity is the Track id, as a string, and is the partition key', () => {
    const merged = mergeTrackProject(TRACK_207, null, OPTS);
    assert.strictEqual(merged.id, '207');
    assert.strictEqual(merged.trackProjectId, 207);
    assert.strictEqual(merged.sourceSystem, 'track');
  });

  await t.test('a Track record without an id throws rather than producing a keyless item', () => {
    assert.throws(() => mergeTrackProject({ name: 'X' }, null, OPTS), TypeError);
    assert.throws(() => mergeTrackProject(null, null, OPTS), TypeError);
  });
});

test('centroid normalisation', async (t) => {
  await t.test('Track lat/lng strings become GeoJSON [lng, lat]', () => {
    // Track stores these as strings and lat-first; GeoJSON is lng-first. Getting this backwards
    // puts every project in the wrong hemisphere and the Typesense sync swaps again on top.
    const c = normalizeCentroid(TRACK_207, null);
    assert.deepStrictEqual(c, { type: 'Point', coordinates: [-121.4, 50.2] });
  });

  await t.test('falls back to Eagle in either shape', () => {
    assert.deepStrictEqual(
      normalizeCentroid(null, { centroid: [-122.9, 49.1] }).coordinates, [-122.9, 49.1]);
    assert.deepStrictEqual(
      normalizeCentroid(null, { centroid: { coordinates: [-122.9, 49.1] } }).coordinates,
      [-122.9, 49.1]);
  });

  await t.test('unparseable coordinates yield null, not NaN', () => {
    assert.strictEqual(normalizeCentroid({ latitude: 'n/a', longitude: 'n/a' }, null), null);
    assert.strictEqual(normalizeCentroid(null, null), null);
    assert.strictEqual(normalizeCentroid(null, { centroid: [1] }), null);
  });

  await t.test('a dropped minus sign on longitude is repaired', () => {
    // 7 real Track records carry a positive longitude. BC longitude is always negative, so
    // negating is unambiguous. Without this, Zincton plots in Uzbekistan.
    const zincton = trackProjects.find(p => p.track_project_id === 373);
    assert.strictEqual(zincton.longitude, '117.1114', 'upstream still has the bad sign');
    assert.deepStrictEqual(normalizeCentroid(zincton, null).coordinates, [-117.1114, 50.337]);
  });

  await t.test('a coordinate no rule can fix gets NO centroid, not a guessed one', () => {
    // Sparwood Wells #04: lat 45.861, lng 53.354. Sparwood is at ~49.7, -114.9 — both values
    // are wrong, and negating puts it in Newfoundland. Better absent than plausible-but-false.
    const sparwood = trackProjects.find(p => p.track_project_id === 358);
    assert.strictEqual(normalizeCentroid(sparwood, null), null);

    const merged = mergeTrackProject(sparwood, null, OPTS);
    assert.ok(!('centroid' in merged));
  });

  await t.test('bad Track coordinates fall through to Eagle rather than being stored', () => {
    const sparwood = trackProjects.find(p => p.track_project_id === 358);
    const c = normalizeCentroid(sparwood, { centroid: [-114.89, 49.74] });
    assert.deepStrictEqual(c.coordinates, [-114.89, 49.74]);
  });

  await t.test('an out-of-BC Eagle centroid is rejected too', () => {
    assert.strictEqual(normalizeCentroid(null, { centroid: [0, 0] }), null);
    assert.strictEqual(normalizeCentroid(null, { centroid: [-79.38, 43.65] }), null); // Toronto
  });

  await t.test('381 of 382 real Track projects yield a centroid inside BC', () => {
    const withCentroid = [];
    for (const track of trackProjects) {
      const c = normalizeCentroid(track, null);
      if (!c) continue;
      withCentroid.push(track.track_project_id);
      const [lng, lat] = c.coordinates;
      assert.ok(lng < 0, `longitude ${lng} not negative for ${track.track_project_id}`);
      assert.ok(inBC(lng, lat), `${track.track_project_id} outside BC: ${lng},${lat}`);
    }
    assert.strictEqual(withCentroid.length, 381);
    assert.ok(!withCentroid.includes(358), 'only Sparwood Wells #04 is unmappable');
  });
});

test('ACL — the merge never widens visibility', async (t) => {
  await t.test('an existing Eagle read[] is preserved verbatim', () => {
    const acl = resolveProjectAcl({ read: ['sysadmin', 'compliance'] }, true);
    assert.deepStrictEqual(acl, ['sysadmin', 'compliance']);
    assert.ok(!acl.includes('public'), 'publishing must not widen an upstream restriction');
  });

  await t.test('no read[] + published -> public plus the secure roles', () => {
    const acl = resolveProjectAcl(null, true);
    assert.ok(acl.includes('public'));
    for (const r of SECURE_ROLES) assert.ok(acl.includes(r));
  });

  await t.test('no read[] + unpublished -> fails closed', () => {
    const acl = resolveProjectAcl(null, false);
    assert.ok(!acl.includes('public'));
    assert.deepStrictEqual(acl, SECURE_ROLES);
  });

  await t.test('an empty read[] array is treated as absent, not as deny-all', () => {
    assert.ok(resolveProjectAcl({ read: [] }, true).includes('public'));
  });

  await t.test('is_active false marks a Track draft unpublished and non-public', () => {
    const merged = mergeTrackProject({ ...TRACK_207, is_active: false }, null, OPTS);
    assert.strictEqual(merged.isPublished, false);
    assert.ok(!merged.read.includes('public'));
  });
});

test('Eagle-only projects', async (t) => {
  const eagle = eagleFor({ epic_guid: 'abc123', name: 'Orphan' });

  await t.test('are keyed by Eagle id and flagged as such', () => {
    const merged = mergeEagleOnlyProject(eagle, OPTS);
    assert.strictEqual(merged.id, 'eagle-abc123');
    assert.strictEqual(merged.eagleId, 'abc123');
    assert.strictEqual(merged.trackProjectId, null);
    assert.strictEqual(merged.sourceSystem, 'eagle');
  });

  await t.test('map Eagle fields onto the canonical names', () => {
    const merged = mergeEagleOnlyProject(eagle, OPTS);
    assert.strictEqual(merged.name, 'Orphan (Eagle)');
    assert.strictEqual(merged.abbreviation, 'EAGLESHORT');
    assert.strictEqual(merged.projectState, 'Operating');
    assert.strictEqual(merged.eaStatus, 'Certificate Issued');
  });

  await t.test('require an _id', () => {
    assert.throws(() => mergeEagleOnlyProject({ name: 'X' }, OPTS), TypeError);
  });
});

test('buildRegistry against the real Track dataset', async (t) => {
  // The Eagle side is derived from the real 354 epic_guids so the join arithmetic is tested on
  // the actual distribution: 6 guids are withheld to dangle, 10 orphans are added.
  const guids = trackProjects.map(p => p.epic_guid).filter(Boolean);
  const matched = guids.slice(0, guids.length - 6);
  const eagleProjects = [
    ...matched.map(g => eagleFor({ epic_guid: g, name: `P${g}` })),
    ...Array.from({ length: 10 }, (_, i) =>
      eagleFor({ epic_guid: `orphan-${i}`, name: `Orphan ${i}` }))
  ];

  const { projects, report } = buildRegistry(trackProjects, eagleProjects, OPTS);

  await t.test('reconciles to the measured shape', () => {
    assert.strictEqual(report.trackTotal, 382);
    assert.strictEqual(report.matched, 348);
    assert.strictEqual(report.trackOnlyNoGuid, 28);
    assert.strictEqual(report.trackOnlyDanglingGuid, 6);
    assert.strictEqual(report.eagleOnly, 10);
    assert.strictEqual(report.total, 392);
  });

  await t.test('nothing is dropped — every Track project appears exactly once', () => {
    assert.strictEqual(projects.length, report.total);
    const trackIds = projects.filter(p => p.sourceSystem === 'track').map(p => p.id);
    assert.strictEqual(trackIds.length, 382);
    assert.strictEqual(new Set(trackIds).size, 382, 'duplicate project ids');
  });

  await t.test('ids are unique across both provenances', () => {
    const ids = projects.map(p => p.id);
    assert.strictEqual(new Set(ids).size, ids.length);
  });

  await t.test('matched projects carry both source payloads', () => {
    const both = projects.filter(p => p.sources.track && p.sources.eagle);
    assert.strictEqual(both.length, 348);
  });

  await t.test('no synthetic NRPTI id survives — the old auto-seeder symptom', () => {
    // 8000000 + hash % 1e6 produced 3,382 junk rows with colliding ids and duplicated names.
    const synthetic = projects.filter(p => p.trackProjectId >= 8000000);
    assert.deepStrictEqual(synthetic, []);
  });

  await t.test('an Eagle project matched to Track is not ALSO emitted as eagle-only', () => {
    const dupes = projects.filter(p => p.sourceSystem === 'eagle' && matched.includes(p.eagleId));
    assert.deepStrictEqual(dupes, []);
  });

  await t.test('empty and missing inputs do not throw', () => {
    assert.strictEqual(buildRegistry([], [], OPTS).report.total, 0);
    assert.strictEqual(buildRegistry(null, null, OPTS).report.total, 0);
    assert.strictEqual(buildRegistry(trackProjects, null, OPTS).report.matched, 0);
  });

  await t.test('an Eagle record without an _id is ignored, not merged blindly', () => {
    const { report: r } = buildRegistry([TRACK_207], [{ name: 'no id' }], OPTS);
    assert.strictEqual(r.eagleOnly, 0);
    assert.strictEqual(r.eagleTotal, 0);
  });
});

test('buildProjectIndex — the deterministic NRPTI join', async (t) => {
  const projects = [
    mergeTrackProject(TRACK_207, eagleFor(TRACK_207), OPTS),
    mergeEagleOnlyProject(eagleFor({ epic_guid: 'orphan-1', name: 'Orphan' }), OPTS)
  ];
  const index = buildProjectIndex(projects);

  await t.test('resolves an NRPTI _epicProjectId (an Eagle id) to the canonical id', () => {
    assert.strictEqual(index.resolve(TRACK_207.epic_guid), '207');
  });

  await t.test('resolves a Track id too', () => {
    assert.strictEqual(index.resolve(207), '207');
    assert.strictEqual(index.resolve('207'), '207');
  });

  await t.test('resolves an eagle-only project by its Eagle id', () => {
    assert.strictEqual(index.resolve('orphan-1'), 'eagle-orphan-1');
  });

  await t.test('returns null for anything unresolvable — no invented parent', () => {
    // This is what replaces normalizeProjectName and its hardcoded name special-cases. An
    // unresolvable record is dropped; it never gets a fabricated project.
    assert.strictEqual(index.resolve('nope'), null);
    assert.strictEqual(index.resolve(''), null);
    assert.strictEqual(index.resolve(null), null);
    assert.strictEqual(index.resolve(undefined), null);
  });
});
