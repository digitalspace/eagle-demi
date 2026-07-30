'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  toGeopoint, allowedRoles, constrainToProject,
  transformDocument, transformProject, transformRecord, transformDocumentChunk,
  transformItem, buildProjectLookup
} = require('../../src/typesense/transform-nosql');
const { SCHEMAS } = require('../../src/typesense/collections');

const PROJECT = {
  id: '207',
  trackProjectId: 207,
  eagleId: '58851172aaecd9001b820335',
  name: 'Nicomen Wind Energy',
  abbreviation: 'NICWIN',
  description: '35 wind turbines',
  projectType: 'Energy - Electricity',
  projectState: 'Closed',
  proponentName: 'Premier Renewable Energy',
  address: 'Lytton',
  region: 'Thompson-Okanagan',
  sector: 'Energy - Electricity',
  eaStatus: 'Certificate Issued',
  currentPhaseName: 'Post Certification',
  centroid: { type: 'Point', coordinates: [-121.4, 50.2] },
  isPublished: true,
  read: ['public', 'sysadmin', 'staff'],
  updatedAt: '2026-07-30T00:00:00.000Z'
};

const lookups = { projects: buildProjectLookup([PROJECT]), documents: new Map() };

test('geopoint conversion — the lng/lat swap', async (t) => {
  await t.test('GeoJSON [lng, lat] becomes Typesense [lat, lng]', () => {
    // Both orders are valid-looking numbers, so getting this wrong fails silently and puts every
    // project in the wrong hemisphere.
    assert.deepStrictEqual(toGeopoint({ type: 'Point', coordinates: [-121.4, 50.2] }),
      [50.2, -121.4]);
    assert.deepStrictEqual(toGeopoint([-121.4, 50.2]), [50.2, -121.4]);
  });

  await t.test('out-of-range coordinates are rejected, not indexed', () => {
    // A [lat, lng] pair fed in by mistake gives a latitude of -121.4, which Typesense rejects at
    // import time — better to drop the field than fail the whole batch.
    assert.strictEqual(toGeopoint([50.2, -121.4]), undefined, 'latitude -121.4 is impossible');
    assert.strictEqual(toGeopoint([200, 50]), undefined);
  });

  await t.test('malformed input yields undefined rather than NaN', () => {
    assert.strictEqual(toGeopoint(null), undefined);
    assert.strictEqual(toGeopoint(undefined), undefined);
    assert.strictEqual(toGeopoint([1]), undefined);
    assert.strictEqual(toGeopoint({ coordinates: ['a', 'b'] }), undefined);
    assert.strictEqual(toGeopoint({}), undefined);
  });
});

test('allowed_roles — the only security duty of this module', async (t) => {
  await t.test('read[] is copied verbatim', () => {
    assert.deepStrictEqual(allowedRoles({ read: ['public', 'staff'] }), ['public', 'staff']);
  });

  await t.test('no read[] and not published -> DENY ALL, not public', () => {
    // Typesense filters on allowed_roles. An empty array matches nothing; ['public'] would make
    // an un-ACL'd item searchable by the entire internet.
    assert.deepStrictEqual(allowedRoles({}), []);
    assert.deepStrictEqual(allowedRoles({ read: [], isPublished: false }), []);
    assert.deepStrictEqual(allowedRoles({ isPublished: 'yes' }), [],
      'only a literal true counts as published');
  });

  await t.test('no read[] but explicitly published -> public', () => {
    assert.deepStrictEqual(allowedRoles({ isPublished: true }), ['public']);
  });
});

test('constrainToProject — a child may never out-rank its project', async (t) => {
  await t.test('intersects rather than unions', () => {
    // Enforced at write time by resolveDocumentAcl too. Repeated here because the index is a
    // second copy: a stale or hand-edited child would otherwise be searchable beyond its project.
    assert.deepStrictEqual(
      constrainToProject(['public', 'staff'], { read: ['staff', 'sysadmin'] }), ['staff']);
  });

  await t.test('a public child under a private project loses public', () => {
    assert.deepStrictEqual(
      constrainToProject(['public'], { read: ['sysadmin'] }), []);
  });

  await t.test('an unknown project does not silently restrict everything', () => {
    // A missing lookup entry is a data problem, not a reason to blank the index. The project's own
    // document carries the authoritative ACL either way.
    assert.deepStrictEqual(constrainToProject(['public'], undefined), ['public']);
    assert.deepStrictEqual(constrainToProject(['public'], { read: [] }), ['public']);
  });
});

test('transformDocument', async (t) => {
  const DOC = {
    id: '58868f2be036fb0105767ea5',
    projectId: '207',
    displayName: 'Site C - Public Hearing Schedule',
    documentFileName: 'schedule.pdf',
    description: 'Hearing schedule',
    // Already labels: resolved against List at SEED time, which is why no listLookup exists here.
    type: 'Letter',
    milestone: 'Application Review',
    fileExt: 'pdf',
    datePosted: '2014-01-15T20:00:00.000Z',
    documentSource: 'PROJECT',
    legislation: 2002,
    read: ['public', 'staff'],
    isPublished: true
  };

  await t.test('denormalises project name, region and centroid', () => {
    const out = transformDocument(DOC, lookups.projects);
    assert.strictEqual(out.projectName, 'Nicomen Wind Energy');
    assert.strictEqual(out.region, 'Thompson-Okanagan');
    assert.deepStrictEqual(out.centroid, [50.2, -121.4]);
  });

  await t.test('type and milestone pass through as labels, not ids', () => {
    const out = transformDocument(DOC, lookups.projects);
    assert.strictEqual(out.type, 'Letter');
    assert.strictEqual(out.milestone, 'Application Review');
  });

  await t.test('the ACL is constrained by the project', () => {
    const out = transformDocument({ ...DOC, read: ['public', 'staff', 'compliance'] },
      lookups.projects);
    assert.ok(!out.allowed_roles.includes('compliance'),
      'a role the project does not grant must not reach the index');
  });

  await t.test('dates become epoch millis and fileExt maps to internalExt', () => {
    const out = transformDocument(DOC, lookups.projects);
    assert.strictEqual(out.datePosted, Date.parse('2014-01-15T20:00:00.000Z'));
    assert.strictEqual(out.internalExt, 'pdf');
  });

  await t.test('a non-numeric legislation is omitted rather than breaking the int32 field', () => {
    assert.ok(!('legislation' in transformDocument({ ...DOC, legislation: 'Act 2002' },
      lookups.projects)));
    assert.ok(!('legislation' in transformDocument({ ...DOC, legislation: 0 }, lookups.projects)));
  });

  await t.test('an unknown project omits the denormalised fields but still indexes', () => {
    const out = transformDocument({ ...DOC, projectId: '999' }, lookups.projects);
    assert.strictEqual(out.projectId, '999');
    assert.ok(!('projectName' in out));
    assert.deepStrictEqual(out.allowed_roles, ['public', 'staff']);
  });
});

test('transformProject', async (t) => {
  const out = transformProject(PROJECT);

  await t.test('maps the merged model onto the index schema', () => {
    assert.strictEqual(out.id, '207');
    assert.strictEqual(out.name, 'Nicomen Wind Energy');
    assert.strictEqual(out.displayName, 'NICWIN');
    assert.strictEqual(out.status, 'Closed', 'projectState -> status');
    assert.strictEqual(out.type, 'Energy - Electricity', 'projectType -> type');
    assert.strictEqual(out.proponent, 'Premier Renewable Energy', 'proponentName -> proponent');
    assert.strictEqual(out.location, 'Lytton', 'address -> location');
    assert.deepStrictEqual(out.centroid, [50.2, -121.4]);
  });

  await t.test('the Eagle id stays searchable as epicProjectId', () => {
    // A legacy EPIC link or bookmark must still resolve after the identity change to Track ids.
    assert.strictEqual(out.epicProjectId, '58851172aaecd9001b820335');
  });

  await t.test('nrptiRecordCount is NOT emitted — it would leak restricted data', () => {
    // The compliance aggregate lives in project_fragments behind a `compliance` ACL. The project
    // document is public, so copying the count here would expose it through search regardless of
    // what the fragment's ACL says.
    assert.ok(!('nrptiRecordCount' in out));
  });

  await t.test('sector falls back to the project type, never to empty', () => {
    assert.strictEqual(transformProject({ ...PROJECT, sector: '' }).sector,
      'Energy - Electricity');
    assert.strictEqual(transformProject({ id: '1', read: ['public'] }).sector, 'Other');
  });

  await t.test('an unpublished project with no ACL is not searchable', () => {
    const priv = transformProject({ id: '9', name: 'Draft', isPublished: false, read: [] });
    assert.deepStrictEqual(priv.allowed_roles, []);
  });
});

test('transformRecord', async (t) => {
  const REC = {
    id: '5ebaecdb0c09f47591a9bdcb',
    projectId: '207',
    dataset: 'Inspection',
    recordName: 'Inspection Report',
    recordType: 'Inspection',
    projectName: 'LNG Canada (per NRPTI)',
    issuingAgency: 'AGENCY_EAO',
    dateIssued: '2015-11-02T08:00:00.000Z',
    read: ['sysadmin', 'admin:nrced', 'public'],
    isPublished: true
  };

  await t.test('the registry names the project, not NRPTI', () => {
    // Resolving through _epicProjectId exists precisely so the canonical registry is the naming
    // authority; keeping NRPTI's own string would reintroduce two names for one project.
    assert.strictEqual(transformRecord(REC, lookups.projects).projectName, 'Nicomen Wind Energy');
  });

  await t.test('falls back to the NRPTI name when the project is unknown', () => {
    assert.strictEqual(
      transformRecord({ ...REC, projectId: '999' }, lookups.projects).projectName,
      'LNG Canada (per NRPTI)');
  });

  await t.test('dataset maps to nrptiSchemaName and the ACL is constrained', () => {
    const out = transformRecord(REC, lookups.projects);
    assert.strictEqual(out.nrptiSchemaName, 'Inspection');
    assert.ok(!out.allowed_roles.includes('admin:nrced'),
      'an NRPTI role the project does not grant must not reach the index');
    assert.ok(out.allowed_roles.includes('public'));
  });

  await t.test('issuedTo is flattened from several shapes', () => {
    assert.strictEqual(transformRecord(
      { ...REC, issuedTo: { fullName: 'Acme Ltd' } }, lookups.projects).issuedToName, 'Acme Ltd');
    assert.strictEqual(transformRecord(
      { ...REC, issuedTo: { firstName: 'A', lastName: 'B' } }, lookups.projects).issuedToName,
    'A B');
    assert.strictEqual(transformRecord(
      { ...REC, issuedTo: 'Plain String' }, lookups.projects).issuedToName, 'Plain String');
    assert.ok(!('issuedToName' in transformRecord({ ...REC, issuedTo: null }, lookups.projects)));
  });

  await t.test('recordName is required by the schema and always present', () => {
    // The schema declares it non-optional, so an import would fail the whole batch without it.
    assert.strictEqual(transformRecord({ ...REC, recordName: '' }, lookups.projects).recordName,
      '(unnamed record)');
  });
});

test('transformDocumentChunk', async (t) => {
  const documents = new Map([['d1', {
    type: 'Letter', milestone: 'Application Review', region: 'Thompson-Okanagan',
    read: ['staff'], displayName: 'Parent Doc', datePosted: '2014-01-15T20:00:00.000Z'
  }]]);
  const CHUNK = {
    id: 'c1', documentId: 'd1', projectId: '207',
    content: 'The Northern Red-legged Frog is blue-listed.', pageNumber: 3, chunkIndex: 0,
    read: ['public'], isPublished: true
  };

  await t.test('inherits the PARENT DOCUMENT visibility, not its own', () => {
    // A chunk is a fragment of a document. If the document is staff-only, its text must not be
    // findable by the public — that would leak the content the ACL exists to protect.
    const out = transformDocumentChunk(CHUNK, lookups.projects, documents);
    assert.deepStrictEqual(out.allowed_roles, ['staff']);
    assert.ok(!out.allowed_roles.includes('public'));
  });

  await t.test('denormalises parent and project metadata', () => {
    const out = transformDocumentChunk(CHUNK, lookups.projects, documents);
    assert.strictEqual(out.documentName, 'Parent Doc');
    assert.strictEqual(out.documentType, 'Letter');
    assert.strictEqual(out.projectName, 'Nicomen Wind Energy');
    assert.strictEqual(out.pageNumber, 3);
  });

  await t.test('an empty chunk is dropped — unsearchable and pure index cost', () => {
    assert.strictEqual(transformDocumentChunk({ ...CHUNK, content: '' },
      lookups.projects, documents), null);
    assert.strictEqual(transformDocumentChunk({ ...CHUNK, content: '   ' },
      lookups.projects, documents), null);
  });

  await t.test('a missing parent falls back to the chunk ACL rather than throwing', () => {
    const out = transformDocumentChunk({ ...CHUNK, documentId: 'gone' },
      lookups.projects, documents);
    assert.deepStrictEqual(out.allowed_roles, ['public']);
  });
});

test('transformItem', async (t) => {
  await t.test('dispatches by schema name', () => {
    assert.strictEqual(transformItem('Project', PROJECT, lookups).id, '207');
    assert.strictEqual(
      transformItem('Document', { id: 'd', projectId: '207', read: ['public'] }, lookups).id, 'd');
  });

  await t.test('an unknown schema yields null, not a throw', () => {
    assert.strictEqual(transformItem('RecentActivity', {}, lookups), null,
      'the dead Mongo-era transforms are gone, not silently retained');
    assert.strictEqual(transformItem('ProjectNotification', {}, lookups), null);
  });

  await t.test('a throwing transform yields null so one bad item cannot abort a reindex', () => {
    // The count guard in full-sync catches the case where MANY items fail, which is the situation
    // that actually matters.
    assert.strictEqual(transformItem('Project', null, lookups), null);
  });
});

test('every emitted field exists in the Typesense schema', async (t) => {
  // A field Typesense does not know is rejected at import and fails the whole batch. Asserting
  // against collections.js catches a drift between the transform and the index contract.
  const check = (schemaName, emitted) => {
    const declared = new Set(SCHEMAS[schemaName].fields.map(f => f.name));
    const unknown = Object.keys(emitted).filter(k => !declared.has(k));
    assert.deepStrictEqual(unknown, [], `${schemaName} emits undeclared field(s)`);
  };

  await t.test('Project', () => check('Project', transformProject(PROJECT)));

  await t.test('Document', () => check('Document', transformDocument({
    id: 'd1', projectId: '207', displayName: 'X', documentFileName: 'x.pdf', description: 'd',
    type: 'Letter', milestone: 'M', documentAuthorType: 'A', projectPhase: 'P', legislation: 2002,
    fileExt: 'pdf', datePosted: '2014-01-15T20:00:00.000Z', dateUploaded: '2014-01-15T20:00:00.000Z',
    isFeatured: true, documentSource: 'PROJECT', region: 'R', read: ['public']
  }, lookups.projects)));

  await t.test('Record', () => check('Record', transformRecord({
    id: 'r1', projectId: '207', dataset: 'Order', recordName: 'N', recordType: 'Order',
    issuingAgency: 'A', issuedTo: 'X', summary: 'S', dateIssued: '2020-01-01T00:00:00.000Z',
    read: ['public']
  }, lookups.projects)));

  await t.test('DocumentChunk', () => check('DocumentChunk', transformDocumentChunk({
    id: 'c1', documentId: 'd1', projectId: '207', content: 'text', pageNumber: 1, chunkIndex: 0,
    read: ['public']
  }, lookups.projects, new Map([['d1', {
    type: 'T', milestone: 'M', region: 'R', read: ['public'], displayName: 'D',
    datePosted: '2020-01-01T00:00:00.000Z'
  }]]))));

  await t.test('required non-optional fields are always emitted', () => {
    for (const schemaName of ['Project', 'Document', 'Record']) {
      const required = SCHEMAS[schemaName].fields.filter(f => !f.optional).map(f => f.name);
      const emitted = schemaName === 'Project'
        ? transformProject(PROJECT)
        : schemaName === 'Document'
          ? transformDocument({ id: 'd', projectId: '207', read: ['public'] }, lookups.projects)
          : transformRecord({ id: 'r', projectId: '207', recordName: 'N', read: ['public'] },
            lookups.projects);
      for (const field of required) {
        assert.ok(field in emitted, `${schemaName} omits required field "${field}"`);
      }
    }
  });
});

test('buildProjectLookup', async (t) => {
  await t.test('keys by id and carries name, region, centroid and ACL', () => {
    const map = buildProjectLookup([PROJECT]);
    const meta = map.get('207');
    assert.strictEqual(meta.name, 'Nicomen Wind Energy');
    assert.strictEqual(meta.region, 'Thompson-Okanagan');
    assert.deepStrictEqual(meta.centroid, [50.2, -121.4]);
    assert.deepStrictEqual(meta.read, ['public', 'sysadmin', 'staff']);
  });

  await t.test('skips entries with no id and tolerates empty input', () => {
    assert.strictEqual(buildProjectLookup([{ name: 'no id' }, null]).size, 0);
    assert.strictEqual(buildProjectLookup([]).size, 0);
    assert.strictEqual(buildProjectLookup(null).size, 0);
  });
});
