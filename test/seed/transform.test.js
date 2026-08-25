'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  seedAcl, toNumber, toIsoOrNull, resolveListLabel,
  transformDocument, transformBoundary,
  SECURE_ROLES
} = require('../../src/seed/transform');

const NOW = '2026-07-30T00:00:00.000Z';
const OPTS = { now: NOW };

// A real eagle-api Document payload, trimmed to the fields the transform reads. Note what is
// NOT here: s3Key (null on all 2,961 sampled) and a usable isPublished.
const EAGLE_DOC = {
  _id: '58868f2be036fb0105767ea5',
  project: '588511a0aaecd9001b82316d',
  displayName: 'Site C - Public Hearing Schedule',
  documentFileName: 'Public Hearing Schedule - Fort St John.pdf',
  description: 'Hearing schedule',
  s3Key: null,
  internalURL: 'etl/site-c-clean-energy/1389817063122_20d7490a.pdf',
  internalSize: 84031,
  internalMime: 'application/pdf',
  internalExt: '.pdf',
  type: '5cf00c03a266b7e1877504da',
  milestone: '5cf00c03a266b7e1877504e9',
  datePosted: '2014-01-15T20:00:00.000Z',
  documentSource: 'PROJECT',
  read: ['project-admin', 'project-intake', 'project-team', 'project-system-admin', 'public'],
  isPublished: null,
  contentExtracted: true,
  contentPageCount: 12
};

const LIST = new Map([
  ['5cf00c03a266b7e1877504da', 'Letter'],
  ['5cf00c03a266b7e1877504e9', 'Application Review']
]);

test('seedAcl — every seeded item gets an explicit read[]', async (t) => {
  await t.test('preserves an upstream ACL verbatim', () => {
    // Rewriting it would either widen an upstream restriction or drop a role. Upstream systems
    // already carry role types, just from different vocabularies.
    const upstream = ['sysadmin', 'admin:nrced', 'admin:lng', 'admin:bcmi', 'public'];
    assert.deepStrictEqual(seedAcl(upstream), upstream);
  });

  await t.test('fails closed with no upstream ACL', () => {
    assert.deepStrictEqual(seedAcl(undefined), SECURE_ROLES);
    assert.deepStrictEqual(seedAcl([]), SECURE_ROLES);
    assert.deepStrictEqual(seedAcl(null), SECURE_ROLES);
    assert.ok(!seedAcl([]).includes('public'));
  });

  await t.test('drops junk entries without emptying the list', () => {
    assert.deepStrictEqual(seedAcl(['public', '', '   ', null, 'staff']), ['public', 'staff']);
  });

  await t.test('an all-junk ACL falls back to closed rather than to empty', () => {
    // An empty read[] would hit the isPublished mirror branch of the visibility predicate.
    assert.deepStrictEqual(seedAcl(['', '  ']), []);
  });
});

test('scalar coercion', async (t) => {
  await t.test('internalSize arrives as a number OR a numeric string', () => {
    // 261 of 2,961 sampled documents had it as a string. Left uncoerced, size comparisons and
    // sorts break in ways that look like data corruption.
    assert.strictEqual(toNumber(84031), 84031);
    assert.strictEqual(toNumber('84031'), 84031);
    assert.strictEqual(toNumber(''), null);
    assert.strictEqual(toNumber(null), null);
    assert.strictEqual(toNumber(undefined), null);
    assert.strictEqual(toNumber('not a number'), null);
    assert.strictEqual(toNumber(0), 0, 'a genuine zero is not null');
  });

  await t.test('dates normalise to ISO or null, never Invalid Date', () => {
    assert.strictEqual(toIsoOrNull('2014-01-15T20:00:00.000Z'), '2014-01-15T20:00:00.000Z');
    assert.strictEqual(toIsoOrNull('nonsense'), null);
    assert.strictEqual(toIsoOrNull(''), null);
    assert.strictEqual(toIsoOrNull(null), null);
  });

  await t.test('an unresolvable List ref keeps its raw value rather than vanishing', () => {
    assert.strictEqual(resolveListLabel('5cf00c03a266b7e1877504da', LIST), 'Letter');
    assert.strictEqual(resolveListLabel('unknown-id', LIST), 'unknown-id');
    assert.strictEqual(resolveListLabel(null, LIST), null);
  });
});

test('transformDocument', async (t) => {
  const doc = transformDocument(EAGLE_DOC, '207', LIST, OPTS);

  await t.test('the object key comes from internalURL, NOT s3Key', () => {
    // s3Key is null on every Eagle document (0 of 2,961 sampled had one). Reading it would seed
    // 60,661 records with no downloadable file.
    assert.strictEqual(EAGLE_DOC.s3Key, null, 'the source really has no s3Key');
    assert.strictEqual(doc.s3Key, 'etl/site-c-clean-energy/1389817063122_20d7490a.pdf');
  });

  await t.test('isPublished is DERIVED from read[], not copied', () => {
    // Upstream isPublished was true on only 66% of documents that are unambiguously public by
    // their ACL. Copying it would hide a third of the corpus.
    assert.strictEqual(EAGLE_DOC.isPublished, null, 'the source value is unusable');
    assert.strictEqual(doc.isPublished, true);
    assert.ok(doc.read.includes('public'));
  });

  await t.test('a non-public ACL yields isPublished false', () => {
    const priv = transformDocument(
      { ...EAGLE_DOC, read: ['project-team'], isPublished: true }, '207', LIST, OPTS);
    assert.strictEqual(priv.isPublished, false,
      'an upstream isPublished:true must not out-rank a private read[]');
  });

  await t.test('extraction state is reset, not carried', () => {
    // The old database has contentExtracted:true on records with no chunks behind them, and DEMI
    // has no chunk data at all. Importing the flag tells the extractor there is nothing to do.
    assert.strictEqual(EAGLE_DOC.contentExtracted, true, 'the source claims extracted');
    assert.strictEqual(doc.contentExtracted, false);
    assert.strictEqual(doc.contentPageCount, 0);
    assert.strictEqual(doc.contentExtractedAt, null);
  });

  await t.test('identity and partition key', () => {
    assert.strictEqual(doc.id, EAGLE_DOC._id, 'the Eagle _id makes a re-seed idempotent');
    assert.strictEqual(doc.eagleId, EAGLE_DOC._id);
    assert.strictEqual(doc.projectId, '207', 'canonical project id, not the Eagle project id');
    assert.strictEqual(doc.sourceSystem, 'eagle');
  });

  await t.test('List refs resolve to labels', () => {
    assert.strictEqual(doc.type, 'Letter');
    assert.strictEqual(doc.milestone, 'Application Review');
  });

  await t.test('the List ObjectId is kept ALONGSIDE the label', () => {
    // eagle-public's document filters send List ObjectIds, never labels. A row carrying only the
    // label has nothing for those values to compare against, so the filter matches zero rows
    // under a 200 — indistinguishable from "no results" for whoever is looking at the screen.
    assert.strictEqual(doc.typeId, EAGLE_DOC.type);
    assert.strictEqual(doc.milestoneId, EAGLE_DOC.milestone);
  });

  await t.test('an unresolvable ref keeps both the raw label and the id', () => {
    const d = transformDocument({ ...EAGLE_DOC, type: 'not-in-the-list' }, '207', LIST, OPTS);
    assert.strictEqual(d.type, 'not-in-the-list', 'the existing rule: the ref is not lost');
    assert.strictEqual(d.typeId, 'not-in-the-list');
  });

  await t.test('projectPhase and documentAuthorType, present and absent', () => {
    // The real eagle-api payload carries both as ObjectIds (measured on eagle-dev 2026-08-22);
    // the shared fixture carries neither, which is the null case the index has to tolerate.
    assert.strictEqual(EAGLE_DOC.projectPhase, undefined);
    assert.strictEqual(doc.projectPhase, null);
    assert.strictEqual(doc.projectPhaseId, null);
    assert.strictEqual(doc.documentAuthorType, null);
    assert.strictEqual(doc.documentAuthorTypeId, null);

    const both = transformDocument({
      ...EAGLE_DOC,
      projectPhase: '5d3f6c7eda7a38421829602f',
      documentAuthorType: '5cf00c03a266b7e1877504dc'
    }, '207', LIST, OPTS);
    assert.strictEqual(both.projectPhaseId, '5d3f6c7eda7a38421829602f');
    assert.strictEqual(both.documentAuthorTypeId, '5cf00c03a266b7e1877504dc');
  });

  await t.test('datePosted is stored as ISO — the documents index sorts on it', () => {
    // eagle-public's default document sort is `-datePosted`, and Edm.DateTimeOffset rejects
    // anything that is not a valid offset-bearing timestamp.
    assert.strictEqual(doc.datePosted, '2014-01-15T20:00:00.000Z');
    assert.strictEqual(
      transformDocument({ ...EAGLE_DOC, datePosted: 'nonsense' }, '207', LIST, OPTS).datePosted,
      null, 'an unparseable date is null, never Invalid Date');
  });

  await t.test('size is numeric and the extension is normalised', () => {
    assert.strictEqual(doc.fileSize, 84031);
    assert.strictEqual(transformDocument(
      { ...EAGLE_DOC, internalSize: '84031' }, '207', LIST, OPTS).fileSize, 84031);
    assert.strictEqual(doc.fileExt, 'pdf', 'leading dot stripped');
  });

  await t.test('an orphan document throws rather than being filed anywhere', () => {
    assert.throws(() => transformDocument(EAGLE_DOC, null, LIST, OPTS), /resolved projectId/);
    assert.throws(() => transformDocument(EAGLE_DOC, '', LIST, OPTS), /resolved projectId/);
    assert.throws(() => transformDocument({ project: 'x' }, '207', LIST, OPTS), /_id is required/);
  });
});

test('transformBoundary — simplified geometry only', async (t) => {
  const RAW = {
    _id: 'static_regionalDistricts_0',
    type: 'Regional District',
    name: 'Regional District of Bulkley-Nechako',
    code: 2,
    simplifiedGeometry: { type: 'Polygon', coordinates: [[[-128.4, 56.0], [-128.5, 56.1]]] },
    geometry: { type: 'Polygon', coordinates: [[[-128.4, 56.0]]] }
  };

  await t.test('full geometry is dropped', () => {
    // Full-resolution GeoJSON is already a build artifact the frontend prefers. Keeping it here
    // put the largest districts near the 2 MB cap; dropping it takes the largest item to 57 KB.
    const b = transformBoundary(RAW, OPTS);
    assert.ok(!('geometry' in b));
    assert.deepStrictEqual(b.simplifiedGeometry, RAW.simplifiedGeometry);
  });

  await t.test('type is the partition key and code is stringified', () => {
    const b = transformBoundary(RAW, OPTS);
    assert.strictEqual(b.type, 'Regional District');
    assert.strictEqual(b.code, '2');
    assert.strictEqual(b.id, RAW._id);
  });

  await t.test('public by default, but with an explicit ACL', () => {
    // This used to assert the OPPOSITE — that boundaries carry no read[] at all — which is what
    // made a staff-only shapefile inexpressible. Reference geography is still public by default;
    // the difference is that "public" is now written down rather than assumed.
    const b = transformBoundary(RAW, OPTS);
    assert.ok(b.read.includes('public'));
    assert.strictEqual(b.isPublished, true);
  });

  await t.test('an upstream restriction survives a re-seed', () => {
    // The case that matters: re-seeding must not republish a shapefile someone restricted.
    const restricted = { ...RAW, read: ['sysadmin', 'staff'] };
    const b = transformBoundary(restricted, OPTS);
    assert.deepStrictEqual(b.read, ['sysadmin', 'staff']);
    assert.strictEqual(b.isPublished, false, 'isPublished mirrors read[], never the reverse');
  });

  await t.test('a boundary missing its partition key or geometry throws', () => {
    assert.throws(() => transformBoundary({ _id: 'x', simplifiedGeometry: {} }), /no type/);
    assert.throws(() => transformBoundary({ _id: 'x', type: 'y' }), /no simplifiedGeometry/);
    assert.throws(() => transformBoundary({ type: 'y' }), /_id is required/);
  });
});

test('the real checked-in boundary exports all transform', async (t) => {
  const { loadBoundaries } = require('../../src/seed/sources');
  const raw = loadBoundaries();

  await t.test('281 features across 3 types', () => {
    const items = raw.map(b => transformBoundary(b, OPTS));
    assert.strictEqual(items.length, 281);
    const types = new Set(items.map(b => b.type));
    assert.deepStrictEqual([...types].sort(),
      ['Electoral District', 'Municipality', 'Regional District']);
  });

  await t.test('every item is comfortably under the 2 MB Cosmos limit', () => {
    let max = 0, maxName = '';
    for (const b of raw) {
      const size = JSON.stringify(transformBoundary(b, OPTS)).length;
      if (size > max) { max = size; maxName = b.name; }
    }
    assert.ok(max < 500_000, `largest boundary is ${max} bytes (${maxName})`);
  });

  await t.test('ids are unique — a duplicate would silently overwrite on upsert', () => {
    const ids = raw.map(b => transformBoundary(b, OPTS).id);
    assert.strictEqual(new Set(ids).size, ids.length);
  });
});

test('extraction state survives a re-seed', async (t) => {
  const { EXTRACTION_FIELDS } = require('../../src/seed/transform');
  const existing = {
    id: EAGLE_DOC._id,
    contentExtracted: true,
    contentExtractedAt: '2026-08-01T10:00:00.000Z',
    contentPageCount: 12,
    contentExtractionError: null
  };

  await t.test('no existing row resets, so a new document is queued for extraction', () => {
    const out = transformDocument(EAGLE_DOC, '207', LIST, OPTS);
    assert.strictEqual(out.contentExtracted, false,
      'upstream contentExtracted is true here and must NOT be believed');
    assert.strictEqual(out.contentExtractedAt, null);
    assert.strictEqual(out.contentPageCount, 0);
    assert.strictEqual(out.contentExtractionError, null);
  });

  await t.test('an existing row carries its four fields forward verbatim', () => {
    // A Cosmos upsert REPLACES the item. Without this a re-seed marks all 61k documents
    // unextracted while their chunks stay behind, and the extractor redoes the whole corpus.
    const out = transformDocument(EAGLE_DOC, '207', LIST, { ...OPTS, existing });
    for (const field of EXTRACTION_FIELDS) {
      assert.deepStrictEqual(out[field], existing[field], field);
    }
  });

  await t.test('a failed extraction is carried too, error and all', () => {
    const failed = {
      contentExtracted: false, contentExtractedAt: '2026-08-02T00:00:00.000Z',
      contentPageCount: 0, contentExtractionError: 'docling timed out'
    };
    const out = transformDocument(EAGLE_DOC, '207', LIST, { ...OPTS, existing: failed });
    assert.strictEqual(out.contentExtractionError, 'docling timed out',
      'losing the error re-queues a document that is known to fail');
  });

  await t.test('only the extraction fields are carried — never the ACL', () => {
    // The existing row is a projection, but a widened projection must not become a way for a
    // stale stored ACL to overwrite the one this seed just derived from upstream.
    const out = transformDocument(EAGLE_DOC, '207', LIST, {
      ...OPTS,
      existing: { ...existing, read: ['sysadmin'], isPublished: false, projectId: 'somewhere-else' }
    });
    assert.ok(out.read.includes('public'), 'the ACL comes from upstream, not from the stored row');
    assert.strictEqual(out.isPublished, true);
    assert.strictEqual(out.projectId, '207');
  });

  await t.test('the projected columns match what the repository selects', () => {
    // Two constants that must agree: transform decides which fields are carried, the repository
    // decides which are read. A drift means the carried set is silently smaller than intended.
    const repo = require('../../src/repositories/documents');
    assert.deepStrictEqual(repo.EXTRACTION_FIELDS, EXTRACTION_FIELDS);
  });
});

test('isFeatured is carried onto the Cosmos row', async (t) => {
  await t.test('true only when upstream says exactly true', () => {
    assert.strictEqual(transformDocument({ ...EAGLE_DOC, isFeatured: true }, '207', LIST, OPTS)
      .isFeatured, true);
    assert.strictEqual(transformDocument({ ...EAGLE_DOC, isFeatured: 'true' }, '207', LIST, OPTS)
      .isFeatured, false, 'a string must not read as featured');
    assert.strictEqual(transformDocument(EAGLE_DOC, '207', LIST, OPTS).isFeatured, false,
      'absent means not featured, never undefined');
  });
});
