'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const trackProjects = require('../../src/data/track_projects_enriched.json');
const {
  mergeTrackProject,
  mergeEagleOnlyProject,
  carryEagleOnlyFields,
  carryDemiOnlyFields,
  buildRegistry,
  buildProjectIndex,
  normalizeCentroid,
  resolveProjectAcl,
  BC_BBOX
} = require('../../src/merge/project');
const { redactForAccess } = require('../../src/vis/redact');

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

/**
 * The project-record fields eagle-public reads off the page but DEMI had no home for. eagle-api
 * resolves the ObjectId-bearing ones before pushing — the merge has no Mongo to resolve them
 * against — so these cases pin the SHAPE that arrives as much as the fact that it lands.
 */
// The index filters `sector` and `projectSubType` by exact match; "Groundwater Extraction " (9 rows)
// matched no filter value.
test('sector and sub-type are stored trimmed', async (t) => {
  await t.test('on a Track-matched project', () => {
    const merged = mergeTrackProject({ ...TRACK_207, sub_type_name: ' Power Plants  ' },
      eagleFor(TRACK_207, { sector: 'Groundwater Extraction ' }), OPTS);
    assert.strictEqual(merged.sector, 'Groundwater Extraction');
    assert.strictEqual(merged.projectSubType, 'Power Plants');
  });

  await t.test('on an Eagle-only project', () => {
    const merged = mergeEagleOnlyProject(eagleFor(TRACK_207, { sector: '  Dams ' }), OPTS);
    assert.strictEqual(merged.sector, 'Dams');
  });
});

test('the pushed-enriched Eagle project record', async (t) => {
  const ENRICHED = {
    CEAALink: 'https://iaac-aeic.gc.ca/050/evaluations/proj/80000',
    applicableRegulation: {
      _id: '588511d0aaecd9001b826192',
      name: 'Reviewable Projects Regulation',
      item: 'https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/370_2002'
    },
    build: 'modification',
    dateAdded: '2016-12-14T00:00:00.000Z',
    dateUpdated: '2021-06-02T00:00:00.000Z',
    projectLeadPhone: '250 555 0101',
    responsibleEPDPhone: '250 555 0102',
    proponentId: '58850f69aaecd9001b8085cc',
    proponentName: 'Eagle Proponent Ltd',
    pins: [{ _id: '5cf00c03a266b7e187750001', name: 'Some Nation', province: 'BC' }],
    featuredDocuments: ['5cf00c03a266b7e187750002', '5cf00c03a266b7e187750003']
  };

  await t.test('every enriched field lands at the TOP level of the merged record', () => {
    const merged = mergeTrackProject(TRACK_207, eagleFor(TRACK_207, ENRICHED), OPTS);

    for (const [field, value] of Object.entries(ENRICHED)) {
      if (field === 'proponentName') continue; // Track wins for it; asserted below.
      assert.deepStrictEqual(merged[field], value, `${field} did not land top level`);
    }
  });

  // They were reachable only under `sources.eagle`, which the field catalog holds at maxVis 0 —
  // so a caller saw neither. Promoting them must not stop the raw payload carrying them.
  await t.test('pins and featuredDocuments are top level AND still under sources.eagle', () => {
    const merged = mergeTrackProject(TRACK_207, eagleFor(TRACK_207, ENRICHED), OPTS);

    assert.deepStrictEqual(merged.pins, ENRICHED.pins);
    assert.deepStrictEqual(merged.featuredDocuments, ENRICHED.featuredDocuments);
    assert.deepStrictEqual(merged.sources.eagle.pins, ENRICHED.pins);
    assert.deepStrictEqual(merged.sources.eagle.featuredDocuments, ENRICHED.featuredDocuments);
  });

  // A raw Mongo push nests content under `legislation_<year>` and keeps pins and featured documents
  // at the top level. Both have to survive the flatten, from opposite sides of it.
  await t.test('a raw Mongo doc keeps them across the legislation flatten', () => {
    const merged = mergeTrackProject(TRACK_207, {
      _id: TRACK_207.epic_guid,
      read: ['public'],
      pins: ENRICHED.pins,
      featuredDocuments: ENRICHED.featuredDocuments,
      currentLegislationYear: 'legislation_2002',
      legislation_2002: { name: 'Nested Name', proponentId: ENRICHED.proponentId }
    }, OPTS);

    assert.deepStrictEqual(merged.pins, ENRICHED.pins);
    assert.deepStrictEqual(merged.featuredDocuments, ENRICHED.featuredDocuments);
    assert.strictEqual(merged.proponentId, ENRICHED.proponentId);
  });

  await t.test('an Eagle project with no Track counterpart keeps its proponent name', () => {
    const merged = mergeEagleOnlyProject(
      eagleFor({ epic_guid: 'orphan1', name: 'Orphan' }, ENRICHED), OPTS);

    assert.strictEqual(merged.proponentName, 'Eagle Proponent Ltd');
    assert.strictEqual(merged.proponentId, ENRICHED.proponentId);
    assert.deepStrictEqual(merged.applicableRegulation, ENRICHED.applicableRegulation);
  });

  await t.test('Track still wins the proponent name when Track has one', () => {
    const merged = mergeTrackProject(TRACK_207, eagleFor(TRACK_207, ENRICHED), OPTS);
    assert.strictEqual(merged.proponentName, TRACK_207.proponent_name);
  });

  // The reason the Eagle slot was filled at all: a blank Track column must not blank the pushed
  // name, exactly as for every other TRACK_PRECEDENCE pair.
  await t.test('a blank Track proponent_name falls back instead of erasing Eagle\'s', () => {
    const merged = mergeTrackProject(
      { ...TRACK_207, proponent_name: '  ' }, eagleFor(TRACK_207, ENRICHED), OPTS);
    assert.strictEqual(merged.proponentName, 'Eagle Proponent Ltd');
  });

  await t.test('an enriched field Eagle did not send is absent, not null', () => {
    const merged = mergeTrackProject(TRACK_207, eagleFor(TRACK_207), OPTS);
    for (const field of Object.keys(ENRICHED)) {
      if (field === 'proponentName') continue;
      assert.ok(!(field in merged), `${field} was fabricated`);
    }
  });
});

/**
 * `dateUpdated` is the stamp eagle-public prints as "Last updated". It is Eagle's own edit date and
 * lives inside the legislation block, so it has to survive the flatten AND stay clear of
 * `updatedAt`, which is DEMI's sync stamp and moves every time the merge runs.
 */
test('Eagle\'s dateUpdated', async (t) => {
  const EDITED = '2021-06-02T00:00:00.000Z';

  await t.test('it lands top level on a Track-matched project', () => {
    const merged = mergeTrackProject(TRACK_207, eagleFor(TRACK_207, { dateUpdated: EDITED }), OPTS);
    assert.strictEqual(merged.dateUpdated, EDITED);
  });

  await t.test('and on an Eagle-only project', () => {
    const merged = mergeEagleOnlyProject(eagleFor(TRACK_207, { dateUpdated: EDITED }), OPTS);
    assert.strictEqual(merged.dateUpdated, EDITED);
  });

  await t.test('it survives the legislation flatten of a raw Mongo push', () => {
    const merged = mergeTrackProject(TRACK_207, {
      _id: TRACK_207.epic_guid,
      read: ['public'],
      currentLegislationYear: 'legislation_2002',
      legislation_2002: { name: 'Nested Name', dateUpdated: EDITED }
    }, OPTS);

    assert.strictEqual(merged.dateUpdated, EDITED);
  });

  await t.test('it does not become the sync stamp, and the sync stamp does not become it', () => {
    const merged = mergeTrackProject(TRACK_207, eagleFor(TRACK_207, { dateUpdated: EDITED }), OPTS);
    assert.strictEqual(merged.updatedAt, NOW, 'updatedAt is DEMI\'s own, injected by opts.now');

    const never = mergeTrackProject(TRACK_207, eagleFor(TRACK_207), OPTS);
    assert.ok(!('dateUpdated' in never),
      'a project Eagle never edited must read as never edited, not as edited when DEMI last synced');
  });
});

/**
 * Fields eagle-api's project GET returns that DEMI used to leave inside `sources.eagle`, which no
 * caller can read. Carried for staff only; the anonymous response must not move.
 */
test('Eagle fields carried for staff', async (t) => {
  const STAFF_FIELDS = {
    CELead: 'Casey Federal', CELeadEmail: 'ce.lead@example.invalid', CELeadPhone: '250 555 0199',
    dateCommentsOpen: '2019-01-01', hasMetCommentPeriods: true
  };
  const STAFF = { level: 2 };
  const ANONYMOUS = { level: 4 };

  await t.test('they survive the legislation flatten of a raw Mongo push', () => {
    const merged = mergeTrackProject(TRACK_207, {
      _id: TRACK_207.epic_guid,
      read: ['public'],
      currentLegislationYear: 'legislation_2002',
      legislation_2002: { name: 'Nested Name', ...STAFF_FIELDS }
    }, OPTS);

    assert.strictEqual(merged.CELeadEmail, 'ce.lead@example.invalid');
    assert.strictEqual(merged.hasMetCommentPeriods, true);
  });

  await t.test('they land on an Eagle-only project too', () => {
    const merged = mergeEagleOnlyProject(eagleFor(TRACK_207, STAFF_FIELDS), OPTS);
    assert.strictEqual(merged.CELead, 'Casey Federal');
  });

  await t.test('staff reads them', () => {
    const merged = mergeTrackProject(TRACK_207, eagleFor(TRACK_207, STAFF_FIELDS), OPTS);
    const out = redactForAccess('projects', merged, STAFF);
    assert.strictEqual(out.CELeadEmail, 'ce.lead@example.invalid');
    assert.strictEqual(out.dateCommentsOpen, '2019-01-01');
  });

  await t.test('an anonymous caller does not', () => {
    const merged = mergeTrackProject(TRACK_207, eagleFor(TRACK_207, STAFF_FIELDS), OPTS);
    const out = redactForAccess('projects', merged, ANONYMOUS);
    assert.ok(!('CELeadEmail' in out));
    assert.ok(!('hasMetCommentPeriods' in out));
  });

  await t.test('the anonymous response is the same as before they were carried', () => {
    const without = mergeTrackProject(TRACK_207, eagleFor(TRACK_207), OPTS);
    const withThem = mergeTrackProject(TRACK_207, eagleFor(TRACK_207, STAFF_FIELDS), OPTS);
    assert.deepStrictEqual(
      redactForAccess('projects', withThem, ANONYMOUS),
      redactForAccess('projects', without, ANONYMOUS));
  });
});

/**
 * Work phases are Track's alone — Eagle has no equivalent — so there is no precedence contest,
 * only the rule that an absent feed must not blank a stored value. That rule is what stops a Track
 * outage from erasing the assessment rail off every project on the next nightly run.
 */
test('Track work phases', async (t) => {
  const PHASES = [
    { name: 'Early Engagement', eaActId: 3, eaActName: '2018 Act', workType: 'Assessment',
      startDate: '2021-05-03T00:00:00.000Z', endDate: '2021-11-08T00:00:00.000Z',
      numberOfDays: 90, legislated: true, sortOrder: 1, isCompleted: true }
  ];

  await t.test('phases arrive verbatim when Track supplies them', () => {
    const merged = mergeTrackProject(TRACK_207, eagleFor(TRACK_207), { ...OPTS, phases: PHASES });
    assert.deepStrictEqual(merged.phases, PHASES);
  });

  await t.test('Eagle\'s own phase record is untouched by them', () => {
    const eagle = eagleFor(TRACK_207, { phaseHistory: ['Pre-Application', 'Application Review'] });
    const merged = mergeTrackProject(TRACK_207, eagle, { ...OPTS, phases: PHASES });

    assert.strictEqual(merged.currentPhaseName, 'Post Certification');
    assert.deepStrictEqual(merged.phaseHistory, ['Pre-Application', 'Application Review']);
  });

  await t.test('no phases and an empty list are both absent, never null or []', () => {
    assert.ok(!('phases' in mergeTrackProject(TRACK_207, null, OPTS)));
    assert.ok(!('phases' in mergeTrackProject(TRACK_207, null, { ...OPTS, phases: [] })));
    assert.ok(!('phases' in mergeEagleOnlyProject(eagleFor(TRACK_207))),
      'an Eagle-only project has no Track work to draw a rail from');
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
  await t.test('an unpublished merge writes the level-2 ladder token', () => {
    // Literal, not read off a constant: a re-merge must write exactly what a controller writes,
    // and reading the value off `readForLevel` here would pass whatever that becomes.
    assert.deepStrictEqual(resolveProjectAcl(null), ['staff']);
  });

  await t.test('an existing Eagle read[] is preserved, minus the compliance token', () => {
    const acl = resolveProjectAcl({ read: ['sysadmin', 'compliance'] });
    assert.deepStrictEqual(acl, ['sysadmin']);
    assert.ok(!acl.includes('public'), 'the merge must never widen an upstream restriction');
  });

  await t.test('a compliance-only Eagle read[] lands privileged-only, not sealed', () => {
    assert.deepStrictEqual(resolveProjectAcl({ read: ['compliance'] }), ['sysadmin']);
  });

  await t.test('a Track project with no Eagle match is NOT public', () => {
    // Reversed 2026-08-23 by the product owner: "if track has a project that eagle does not have,
    // this project is NOT public." Eagle is what publishes; a project that has not reached it has
    // not been published by anyone.
    //
    // The rule this replaced read the Track export as self-evidently public because the file is
    // committed to a public repository — an argument about the FILE, not the projects in it. It
    // made 28 projects anonymously readable in demi-test with no Eagle counterpart, 19 of which
    // returned zero anonymous hits on prod eagle-search.
    const acl = resolveProjectAcl(null);
    assert.ok(!acl.includes('public'), 'no Eagle counterpart means nobody published it');
  });

  await t.test('an empty read[] is Eagle hiding the project from everyone: privileged-only', () => {
    assert.deepStrictEqual(resolveProjectAcl({ read: [] }), ['sysadmin']);
    assert.deepStrictEqual(resolveProjectAcl({}), ['staff'], 'only a missing read[] is the legacy level 2');
  });

  await t.test('isPublished MIRRORS read[] — it is never an independent signal', () => {
    // It used to be `track.is_active !== false`, conflating a Track-internal record flag with
    // publication. 23 projects (Ajax Mine, Aurora LNG Digby Island) then read isPublished:false
    // while Eagle's ACL correctly made them public. Nothing leaked, but the mirror lied — and
    // setDocumentPublished 409s on an unpublished parent, so no document could be published
    // under any of them.
    const restricted = mergeTrackProject(TRACK_207, { _id: 'x', read: ['sysadmin'] }, OPTS);
    assert.strictEqual(restricted.isPublished, false);
    assert.ok(!restricted.read.includes('public'));

    const open = mergeTrackProject(TRACK_207, { _id: 'x', read: ['public', 'staff'] }, OPTS);
    assert.strictEqual(open.isPublished, true);
  });

  await t.test('is_active does NOT affect visibility, and is still carried through', () => {
    // Of the 40 Track projects it marks inactive, 17 are "Pre Work", 8 "Under Work" and 2
    // "Operation" — it is orthogonal to both publication and lifecycle stage. Asserted against an
    // Eagle counterpart that publishes, so the subject is is_active and not the missing-match rule
    // above: with `null` for Eagle every project is unpublished now, which would pass whatever
    // is_active did and prove nothing.
    const eagle = { _id: 'x', read: ['public', 'staff'] };
    const inactive = mergeTrackProject({ ...TRACK_207, is_active: false }, eagle, OPTS);
    const active = mergeTrackProject({ ...TRACK_207, is_active: true }, eagle, OPTS);

    assert.strictEqual(inactive.isPublished, true, 'a closed project Eagle publishes is public');
    assert.deepStrictEqual(inactive.read, active.read, 'is_active does not move the ACL');
    assert.strictEqual(inactive.isActive, false, 'the flag itself is preserved');
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

test('a raw push under the Building Canada Act block', async (t) => {
  const BLOCK = {
    name: 'Federal Corridor',
    legislation: 'Building Canada Act',
    legislationYear: 2025,
    centroid: [-123.1, 49.3]
  };
  const raw = (top = {}) => ({ _id: 'bca1', read: ['public'], legislation_2025: BLOCK, ...top });
  // A project moved onto the new Act keeps its old block, so only currentLegislationYear decides.
  const moved = () => raw({
    currentLegislationYear: 'legislation_2025',
    legislation_2018: { name: 'Old Name', legislation: 'Environmental Assessment Act', legislationYear: 2018 }
  });

  await t.test('flattens to its label and year', () => {
    const merged = mergeEagleOnlyProject(moved(), OPTS);

    assert.strictEqual(merged.name, 'Federal Corridor');
    assert.strictEqual(merged.legislation, 'Building Canada Act');
    assert.strictEqual(merged.legislationYear, 2025);
    assert.deepStrictEqual(merged.centroid.coordinates, BLOCK.centroid);
  });

  await t.test('is found as the lone block when currentLegislationYear is missing', () => {
    const merged = mergeEagleOnlyProject(raw(), OPTS);

    assert.strictEqual(merged.legislation, 'Building Canada Act');
    assert.strictEqual(merged.legislationYear, 2025);
  });

  await t.test('an empty block with no top-level name is rejected, not stored nameless', () => {
    assert.throws(() => mergeEagleOnlyProject(raw({ legislation_2025: {} }), OPTS),
      err => err.status === 400);
  });
});

test('legislation blocks are found by key pattern, not a list of Acts', async (t) => {
  const FUTURE = { name: 'Future Act Project', legislation: 'Future Act', legislationYear: 2031 };
  const OLD = { name: 'Old Name', legislation: 'Environmental Assessment Act', legislationYear: 2018 };
  const raw = (top = {}) => ({ _id: 'act2031', read: ['public'], legislation_2031: FUTURE, ...top });

  await t.test('a lone block for an Act DEMI has never seen flattens to its label and year', () => {
    const merged = mergeEagleOnlyProject(raw(), OPTS);

    assert.strictEqual(merged.name, 'Future Act Project');
    assert.strictEqual(merged.legislation, 'Future Act');
    assert.strictEqual(merged.legislationYear, 2031);
  });

  await t.test('two blocks with no currentLegislationYear and no top-level name are rejected', () => {
    assert.throws(() => mergeEagleOnlyProject(raw({ legislation_2018: OLD }), OPTS),
      err => err.status === 400);
  });

  await t.test('a currentLegislationYear naming a non-legislation key is ignored', () => {
    const merged = mergeEagleOnlyProject(
      raw({ currentLegislationYear: 'decoy', decoy: { name: 'Decoy', legislationYear: 1 } }), OPTS);

    assert.strictEqual(merged.name, 'Future Act Project');
    assert.strictEqual(merged.legislationYear, 2031);
  });

  // An array would otherwise coerce to its one element in both the key test and the lookup.
  await t.test('a non-string currentLegislationYear names no block, even one that exists', () => {
    assert.throws(() => mergeEagleOnlyProject(
      raw({ currentLegislationYear: ['legislation_2018'], legislation_2018: OLD }), OPTS),
    err => err.status === 400);
  });

  await t.test('a currentLegislationYear naming an empty block falls back to the one named block', () => {
    const merged = mergeEagleOnlyProject(
      raw({ currentLegislationYear: 'legislation_2018', legislation_2018: {} }), OPTS);

    assert.strictEqual(merged.name, 'Future Act Project');
    assert.strictEqual(merged.legislationYear, 2031);
  });

  for (const bad of ['legislation_25', 'legislation_2025x']) {
    await t.test(`${bad} is not a legislation block`, () => {
      const merged = mergeEagleOnlyProject(raw({ [bad]: OLD }), OPTS);

      assert.strictEqual(merged.name, 'Future Act Project');
      assert.strictEqual(merged.legislationYear, 2031);
    });
  }
});

test('a push of a hydrated eagle-api project, every block default-filled', async (t) => {
  // Mirrors UNUSED_BLOCK in test/controllers/nosql/eagle-push.test.js: what `toObject()` gives
  // for an Act the project never used. eagle-api does not require `name`.
  const UNUSED_BLOCK = Object.freeze({
    CEAAInvolvement: null, CELead: '', centroid: [], description: '', eacDecision: null,
    location: '', proponent: null, region: '', type: '', legislation: '', sector: '', status: '',
    isTermsAgreed: false, dateUpdated: null, applicableRegulation: null, groups: []
  });
  const CURRENT = {
    ...UNUSED_BLOCK, description: 'Current text', status: 'In Progress',
    legislation: 'Building Canada Act', legislationYear: 2025
  };
  const OLD = {
    ...UNUSED_BLOCK, name: 'Old Name', description: 'Old text', status: 'Complete',
    legislation: 'Environmental Assessment Act', legislationYear: 2018
  };
  const raw = (top = {}) => ({
    _id: 'hydrated1', read: ['public'], currentLegislationYear: 'legislation_2025',
    legislation_1996: { ...UNUSED_BLOCK }, legislation_2002: { ...UNUSED_BLOCK },
    legislation_2018: OLD, legislation_2025: CURRENT, ...top
  });
  const assertCurrent = (merged) => {
    assert.strictEqual(merged.description, 'Current text');
    assert.strictEqual(merged.projectState, 'In Progress');
    assert.strictEqual(merged.legislation, 'Building Canada Act');
    assert.strictEqual(merged.legislationYear, 2025);
  };

  await t.test('a nameless current block is flattened, not the named older one', () => {
    const merged = mergeEagleOnlyProject(raw(), OPTS);

    assertCurrent(merged);
    assert.strictEqual(merged.name, undefined);
  });

  await t.test('a stale top-level name does not turn it into a raw pass-through', () => {
    assertCurrent(mergeEagleOnlyProject(raw({ name: 'Stale Top Name' }), OPTS));
  });

  await t.test('a blank-only name on the current block is still the current block', () => {
    const merged = mergeEagleOnlyProject(raw({ legislation_2025: { ...CURRENT, name: '   ' } }), OPTS);

    assertCurrent(merged);
    assert.notStrictEqual(merged.name, 'Old Name');
  });

  await t.test('with no current key the one named block wins over default-filled siblings', () => {
    const merged = mergeEagleOnlyProject(
      raw({ currentLegislationYear: undefined, legislation_2025: { ...UNUSED_BLOCK } }), OPTS);

    assert.strictEqual(merged.name, 'Old Name');
    assert.strictEqual(merged.legislationYear, 2018);
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

  await t.test('no synthetic id survives — the removed auto-seeder symptom', () => {
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

test('buildProjectIndex — the deterministic id join', async (t) => {
  const projects = [
    mergeTrackProject(TRACK_207, eagleFor(TRACK_207), OPTS),
    mergeEagleOnlyProject(eagleFor({ epic_guid: 'orphan-1', name: 'Orphan' }), OPTS)
  ];
  const index = buildProjectIndex(projects);

  await t.test('resolves an upstream Eagle id to the canonical id', () => {
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

/**
 * The same fields as the pushed record above, but arriving from the SEED. eagle-api resolves them
 * for the push only; `/api/public/search?dataset=Project` returns `proponent` populated and `pins`
 * as bare ObjectIds, which is why every seeded row held `proponentId: null`.
 */
test('the seed-shaped Eagle project record', async (t) => {
  const ORG = {
    _id: '58850f68aaecd9001b80857c',
    _schemaName: 'Organization',
    name: 'Columbia Power Corporation',
    province: 'British Columbia',
    city: 'Castlegar'
  };
  const PIN = { _id: '5cf00c03a266b7e187750001', name: 'Some Nation', province: 'BC' };
  const ORGS = new Map([[PIN._id, PIN]]);
  const OPTS_ORGS = { now: NOW, orgs: ORGS };
  // Nothing to inherit a proponent name from, so the Eagle slot's own value is what shows.
  const NO_PROPONENT = { ...TRACK_207, proponent_name: '' };

  await t.test('a populated proponent object becomes proponentId and proponentName', () => {
    const merged = mergeTrackProject(
      NO_PROPONENT, eagleFor(TRACK_207, { proponent: ORG }), OPTS);

    assert.strictEqual(merged.proponentId, ORG._id);
    assert.strictEqual(merged.proponentName, ORG.name);
  });

  await t.test('a bare ObjectId gives proponentId and no invented name', () => {
    const merged = mergeTrackProject(
      NO_PROPONENT, eagleFor(TRACK_207, { proponent: ORG._id }), OPTS);

    assert.strictEqual(merged.proponentId, ORG._id);
    assert.strictEqual(merged.proponentName, undefined,
      'a name the feed never sent must not be conjured from the id');
  });

  await t.test('what the push already resolved is never overwritten', () => {
    const merged = mergeTrackProject(NO_PROPONENT, eagleFor(TRACK_207, {
      proponent: ORG,
      proponentId: 'pushed-id',
      proponentName: 'Pushed Name'
    }), OPTS);

    assert.strictEqual(merged.proponentId, 'pushed-id');
    assert.strictEqual(merged.proponentName, 'Pushed Name');
  });

  await t.test('pins resolve to the push shape, and an unknown org drops', () => {
    const merged = mergeTrackProject(NO_PROPONENT, eagleFor(TRACK_207, {
      pins: [PIN._id, '5cf00c03a266b7e187759999']
    }), OPTS_ORGS);

    assert.deepStrictEqual(merged.pins, [PIN]);
  });

  await t.test('without a lookup, pin ids are left alone rather than made nameless', () => {
    const merged = mergeTrackProject(NO_PROPONENT, eagleFor(TRACK_207, { pins: [PIN._id] }), OPTS);

    assert.deepStrictEqual(merged.pins, [PIN._id]);
  });

  await t.test('a nested Mongo doc is normalised out of its legislation block', () => {
    const merged = mergeEagleOnlyProject({
      _id: TRACK_207.epic_guid,
      currentLegislationYear: 'legislation_2002',
      pins: [PIN._id],
      legislation_2002: { name: 'Nested Name', proponent: ORG }
    }, OPTS_ORGS);

    assert.strictEqual(merged.proponentId, ORG._id);
    assert.strictEqual(merged.proponentName, ORG.name);
    assert.deepStrictEqual(merged.pins, [PIN]);
  });

  await t.test('normalising never rewrites the caller\'s own record', () => {
    const eagle = eagleFor(TRACK_207, { proponent: ORG, pins: [PIN._id] });
    mergeTrackProject(NO_PROPONENT, eagle, OPTS_ORGS);

    assert.strictEqual(eagle.proponentId, undefined);
    assert.deepStrictEqual(eagle.pins, [PIN._id]);
  });

  // The seed's feed is narrower than the push's: no applicableRegulation, no featuredDocuments.
  await t.test('a re-merge keeps the Eagle-only fields its feed cannot rebuild', () => {
    const existing = {
      applicableRegulation: { _id: 'r1', name: 'Reviewable Projects Regulation', item: null },
      featuredDocuments: ['d1'],
      region: 'Stale Region'
    };
    const merged = carryEagleOnlyFields(
      mergeTrackProject(TRACK_207, eagleFor(TRACK_207, { region: 'Kootenay' }), OPTS), existing);

    assert.deepStrictEqual(merged.applicableRegulation, existing.applicableRegulation);
    assert.deepStrictEqual(merged.featuredDocuments, existing.featuredDocuments);
    assert.strictEqual(merged.region, 'Kootenay',
      'a field the feed DID supply must win over the stored copy');
  });
});

/**
 * `carryEagleOnlyFields` — what a re-merge may take back off the stored row, and what it may not.
 *
 * A Cosmos upsert replaces the item, so a re-seed has to carry the push's enrichment forward or
 * blank it. Carrying the WHOLE `EAGLE_ONLY_FIELDS` list did that at a price nobody saw: `hasValue`
 * cannot tell a field the feed omitted from one the EAO cleared, so an upstream clear was
 * unappliable for the ~36 fields the feed does carry — the old value came straight back on every
 * run. Only the four the feed sends nothing for may be carried.
 */
test('carryEagleOnlyFields carries only what the feed cannot rebuild', async (t) => {
  const PIN = { _id: '5cf00c03a266b7e187750001', name: 'Some Nation', province: 'BC' };
  const OTHER_PIN = { _id: '5cf00c03a266b7e187750002', name: 'Another Nation', province: 'BC' };
  const UNKNOWN_PIN_ID = '5cf00c03a266b7e187759999';

  await t.test('a field the feed cleared is NOT restored from the stored row', () => {
    // `region` and `pinsRead` are both in EAGLE_ONLY_FIELDS and both in the feed, so the EAO
    // clearing either has to stick. This is the regression: they came back on every re-merge.
    const stored = { region: 'Kootenay', pinsRead: ['public'], proponentId: 'org-1' };
    const merged = carryEagleOnlyFields(
      mergeTrackProject(TRACK_207, eagleFor(TRACK_207, { region: '', pinsRead: [] }), OPTS),
      stored);

    assert.strictEqual(merged.region, undefined, 'a cleared region must stay cleared');
    assert.strictEqual(merged.pinsRead, undefined, 'a cleared pinsRead must stay cleared');
  });

  await t.test('a push-only field the feed never sends IS carried', () => {
    // `/api/public/search?dataset=Project` sends neither: the push resolves `proponentId` off the
    // Organization it was handed, and the search omits `applicableRegulation` entirely.
    const stored = {
      proponentId: 'org-1',
      applicableRegulation: { _id: 'r1', name: 'Reviewable Projects Regulation', item: null }
    };
    const merged = carryEagleOnlyFields(
      mergeTrackProject(TRACK_207, eagleFor(TRACK_207), OPTS), stored);

    assert.strictEqual(merged.proponentId, 'org-1');
    assert.deepStrictEqual(merged.applicableRegulation, stored.applicableRegulation);
  });

  await t.test('pins: [] upstream clears the pins', () => {
    const merged = carryEagleOnlyFields(
      mergeTrackProject(TRACK_207, eagleFor(TRACK_207, { pins: [] }), OPTS), { pins: [PIN] });

    assert.strictEqual(merged.pins, undefined,
      'the item is replaced whole, so no pins field is a project with no pins');
  });

  await t.test('a bare id takes the stored shape, and an unresolvable one keeps its own', () => {
    // The feed sends pins as bare ObjectIds. Only the SHAPE comes off the stored row, per id —
    // dropping an id the stored row cannot resolve would lose a pin the EAO still has.
    const merged = carryEagleOnlyFields(
      mergeTrackProject(TRACK_207, eagleFor(TRACK_207, { pins: [PIN._id, UNKNOWN_PIN_ID] }), OPTS),
      { pins: [PIN] });

    assert.deepStrictEqual(merged.pins, [PIN, UNKNOWN_PIN_ID]);
  });

  await t.test('membership stays the feed\'s — a pin the EAO removed does not come back', () => {
    const merged = carryEagleOnlyFields(
      mergeTrackProject(TRACK_207, eagleFor(TRACK_207, { pins: [PIN._id] }), OPTS),
      { pins: [PIN, OTHER_PIN] });

    assert.deepStrictEqual(merged.pins, [PIN]);
  });
});

// `tags` is written only by `PUT /projects/:id`; no feed sends it, so a re-merge has nothing to
// rebuild it from and the stored row is the only copy.
test('carryDemiOnlyFields', async (t) => {
  await t.test('the stored tags land on the rebuilt row', () => {
    const merged = carryDemiOnlyFields(mergeTrackProject(TRACK_207, eagleFor(TRACK_207), OPTS),
      { id: '207', tags: ['Old Name', 'Another Name'] });

    assert.deepStrictEqual(merged.tags, ['Old Name', 'Another Name']);
    assert.strictEqual(merged.id, '207');
  });

  await t.test('a stored row with no tags gives the rebuilt row none', () => {
    const merged = carryDemiOnlyFields(mergeTrackProject(TRACK_207, eagleFor(TRACK_207), OPTS),
      { id: '207' });

    assert.strictEqual(merged.tags, undefined, 'absent, not fabricated as []');
  });

  await t.test('the rebuilt row gets its own copy, so editing it leaves the stored row alone', () => {
    const stored = { id: '207', tags: ['Old Name'] };
    const merged = carryDemiOnlyFields(mergeTrackProject(TRACK_207, eagleFor(TRACK_207), OPTS), stored);

    merged.tags.push('New Name');

    assert.deepStrictEqual(stored.tags, ['Old Name']);
  });

  await t.test('no stored row hands the rebuilt row back as it was', () => {
    const rebuilt = mergeEagleOnlyProject(eagleFor(TRACK_207), OPTS);

    const merged = carryDemiOnlyFields(rebuilt, null);

    assert.strictEqual(merged, rebuilt);
    assert.strictEqual(merged.tags, undefined);
  });
});
