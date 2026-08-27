'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  TRACK_PRECEDENCE,
  EAGLE_ONLY_FIELDS,
  mergeTrackProject,
  mergeEagleOnlyProject
} = require('../../src/merge/project');
const { transformDocument } = require('../../src/seed/transform');
const { catalogFor } = require('../../src/vis/catalog');

const catalog = catalogFor('projects');
const documentCatalog = catalogFor('documents');

// Both fixtures are written out by hand rather than generated from TRACK_PRECEDENCE and
// EAGLE_ONLY_FIELDS: a fixture derived from the constants would grow a new field at the same
// moment the merge does, and the completeness assertion below would never fail.

const TRACK_FIXTURE = {
  track_project_id: 207,
  epic_guid: '5850d1b4652f7e0019b52c0e',
  longitude: '-123.1',
  latitude: '49.2',
  name: 'Track Name',
  description: 'Track description',
  type_name: 'Mines',
  sub_type_name: 'Coal Mine',
  proponent_name: 'Track Proponent Ltd',
  project_state_name: 'Operating',
  abbreviation: 'TRK',
  address: '100 Track Road, Victoria BC',
  is_active: true
};

const EAGLE_FIXTURE = {
  _id: '5850d1b4652f7e0019b52c0e',
  read: ['public', 'sysadmin', 'staff'],
  name: 'Eagle Name',
  description: 'Eagle description',
  type: 'Energy-Electricity',
  status: 'Pre-Construction',
  shortName: 'EGL',
  location: '200 Eagle Way, Nanaimo BC',
  activeStatus: 'Active',
  centroid: [-124.05, 49.75],
  eaStatus: 'Certificate Issued',
  eacDecision: 'Certificate Issued',
  decisionDate: '2019-03-14T00:00:00.000Z',
  currentPhaseName: 'Post Decision - Certificate Issued',
  phaseHistory: ['Pre-Application', 'Application Review'],
  legislation: '2002 Environmental Assessment Act',
  legislationYear: 2002,
  review180Start: '2018-01-10T00:00:00.000Z',
  review45Start: '2018-08-01T00:00:00.000Z',
  reviewExtensions: ['30 days'],
  reviewSuspensions: ['suspended 2018-05-01'],
  substitution: false,
  CEAAInvolvement: 'Substituted',
  projectLead: 'Alex Lead',
  projectLeadEmail: 'alex.lead@example.invalid',
  responsibleEPD: 'Blair EPD',
  responsibleEPDEmail: 'blair.epd@example.invalid',
  complianceLead: 'Casey Compliance',
  execProjectDirector: 'Drew Director',
  eaoMember: 'Erin Member',
  sector: 'Energy-Electricity',
  commodity: 'Coal',
  region: 'Vancouver Island',
  fedElecDist: 'Nanaimo-Ladysmith',
  provElecDist: 'Nanaimo',
  projectCAC: true,
  projectCACPublished: true,
  cacEmail: 'cac@example.invalid',
  overallProgress: 75,
  code: 'eagle-project-code',
  nameSearchTerms: ['eagle', 'name']
};

test('the projects catalog covers every field the merge emits', async (t) => {
  await t.test('the fixtures actually populate every merge constant', () => {
    for (const field of EAGLE_ONLY_FIELDS) {
      assert.ok(field in EAGLE_FIXTURE, `EAGLE_FIXTURE is missing ${field}`);
    }
    for (const [, trackField] of TRACK_PRECEDENCE) {
      assert.ok(trackField in TRACK_FIXTURE, `TRACK_FIXTURE is missing ${trackField}`);
    }
  });

  await t.test('every key mergeTrackProject emits is catalogued', () => {
    const out = mergeTrackProject(TRACK_FIXTURE, EAGLE_FIXTURE);
    assert.deepStrictEqual(Object.keys(out).filter(k => !(k in catalog)), []);
  });

  await t.test('every key mergeEagleOnlyProject emits is catalogued', () => {
    const out = mergeEagleOnlyProject(EAGLE_FIXTURE);
    assert.deepStrictEqual(Object.keys(out).filter(k => !(k in catalog)), []);
  });

  await t.test('no upstream field is named vis', () => {
    assert.ok(!('vis' in mergeTrackProject(TRACK_FIXTURE, EAGLE_FIXTURE)));
    assert.ok(!('vis' in mergeEagleOnlyProject(EAGLE_FIXTURE)));
  });

  await t.test('the job-written fields are catalogued', () => {
    for (const key of ['regionalDistrict', 'municipality', 'electoralDistrict', 'createdAt', 'sources.wildfire']) {
      assert.ok(key in catalog, `${key} is not catalogued`);
    }
  });

  await t.test('every entry has both bounds and defaultVis <= maxVis', () => {
    for (const [key, entry] of Object.entries(catalog)) {
      assert.strictEqual(typeof entry.defaultVis, 'number', `${key}.defaultVis`);
      assert.strictEqual(typeof entry.maxVis, 'number', `${key}.maxVis`);
      assert.ok(entry.defaultVis >= 0 && entry.defaultVis <= 4, `${key}.defaultVis out of range`);
      assert.ok(entry.maxVis >= 0 && entry.maxVis <= 4, `${key}.maxVis out of range`);
      assert.ok(entry.defaultVis <= entry.maxVis, `${key} defaults above its ceiling`);
    }
  });

  await t.test('read, sources and vis can never be seen', () => {
    assert.strictEqual(catalog.read.maxVis, 0);
    assert.strictEqual(catalog.sources.maxVis, 0);
    assert.strictEqual(catalog.vis.maxVis, 0);
  });

  await t.test('the Cosmos system fields can never be seen', () => {
    assert.strictEqual(catalog._rid.maxVis, 0);
    assert.strictEqual(catalog._self.maxVis, 0);
    assert.strictEqual(catalog._attachments.maxVis, 0);
    assert.strictEqual(catalog._ts.maxVis, 0);
  });

  await t.test('_etag is writer-visible only', () => {
    assert.strictEqual(catalog._etag.defaultVis, 2);
    assert.strictEqual(catalog._etag.maxVis, 2);
  });

  await t.test('the restricted contacts start below public', () => {
    assert.strictEqual(catalog.complianceLead.defaultVis, 2);
    assert.strictEqual(catalog.complianceLead.maxVis, 4);
    assert.strictEqual(catalog.execProjectDirector.defaultVis, 2);
    assert.strictEqual(catalog.execProjectDirector.maxVis, 4);
  });

  await t.test('the contact emails stay public until the EAO signs off', () => {
    assert.strictEqual(catalog.projectLeadEmail.defaultVis, 4);
    assert.strictEqual(catalog.responsibleEPDEmail.defaultVis, 4);
    assert.strictEqual(catalog.cacEmail.defaultVis, 4);
  });

  await t.test('catalogFor throws on an unknown entity', () => {
    assert.throws(() => catalogFor('widgets'), /no field catalog/);
    assert.throws(() => catalogFor(undefined), /no field catalog/);
  });
});

// Hand-written for the same reason as the project fixtures above: derived from the transform, it
// would grow a field at the same moment the transform does and never fail.
const EAGLE_DOCUMENT_FIXTURE = {
  _id: '5850d1b4652f7e0019b52c1f',
  read: ['public', 'sysadmin', 'staff'],
  displayName: 'Application Part A',
  documentFileName: 'part-a.pdf',
  description: 'Application, part A',
  internalURL: 'etl/site-c/1389817063122_20d7490a.pdf',
  internalExt: '.PDF',
  internalSize: '104857',
  internalMime: 'application/pdf',
  type: '5cf00c03a266b7e1877504ca',
  milestone: '5cf00c03a266b7e1877504db',
  projectPhase: '5cf00c03a266b7e1877504ee',
  documentAuthorType: '5cf00c03a266b7e1877504f9',
  datePosted: '2018-04-02T00:00:00.000Z',
  dateUploaded: '2018-04-01T00:00:00.000Z',
  documentAuthor: 'Proponent Ltd',
  documentSource: 'PROJECT',
  isFeatured: true,
  region: 'Vancouver Island',
  eaoStatus: 'Published',
  orcsClassification: '85100-25',
  edrmsRecordNumber: 'EDRMS-1234',
  legislation: 2002
};

test('the documents catalog covers every field the seed and the controller write', async (t) => {
  await t.test('documents catalog covers every transformDocument key', () => {
    const out = transformDocument(EAGLE_DOCUMENT_FIXTURE, '207', new Map());
    assert.deepStrictEqual(Object.keys(out).filter(k => !(k in documentCatalog)), []);
  });

  await t.test('the controller-written fields are catalogued', () => {
    // createDocument adds the first four; patchExtraction the next two; upsertFromEagle and the
    // project ACL cascade write `ownRead`.
    for (const key of ['createdAt', 'isDeleted', 'sourceSystem', 'read',
      'extractionMethod', 'extraction', 'ownRead']) {
      assert.ok(key in documentCatalog, `${key} is not catalogued`);
    }
  });

  await t.test('s3Key never exceeds maxVis 0', () => {
    assert.strictEqual(documentCatalog.s3Key.maxVis, 0);
    assert.strictEqual(documentCatalog.s3Key.defaultVis, 0);
  });

  await t.test('the two ACL fields and the dial map can never be seen', () => {
    assert.strictEqual(documentCatalog.read.maxVis, 0);
    assert.strictEqual(documentCatalog.ownRead.maxVis, 0);
    assert.strictEqual(documentCatalog.vis.maxVis, 0);
  });

  await t.test('_etag is writer-visible only', () => {
    assert.strictEqual(documentCatalog._etag.defaultVis, 2);
    assert.strictEqual(documentCatalog._etag.maxVis, 2);
  });

  await t.test('the records-management ids stay public until the EAO signs off', () => {
    assert.strictEqual(documentCatalog.orcsClassification.defaultVis, 4);
    assert.strictEqual(documentCatalog.edrmsRecordNumber.defaultVis, 4);
  });

  await t.test('every entry has both bounds and defaultVis <= maxVis', () => {
    for (const [key, entry] of Object.entries(documentCatalog)) {
      assert.strictEqual(typeof entry.defaultVis, 'number', `${key}.defaultVis`);
      assert.strictEqual(typeof entry.maxVis, 'number', `${key}.maxVis`);
      assert.ok(entry.defaultVis >= 0 && entry.defaultVis <= 4, `${key}.defaultVis out of range`);
      assert.ok(entry.maxVis >= 0 && entry.maxVis <= 4, `${key}.maxVis out of range`);
      assert.ok(entry.defaultVis <= entry.maxVis, `${key} defaults above its ceiling`);
    }
  });
});
