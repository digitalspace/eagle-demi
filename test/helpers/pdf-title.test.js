'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { isPdf, isEligible, isCurrent, needsRestore } = require('../../src/helpers/pdf-title');

const DOC = {
  id: '5f1e2d3c4b5a69788796a5b4',
  projectId: '207',
  displayName: 'Site C Report',
  s3Key: '207/9f86d081884c7d659a2feaa0c55ad015',
  mimeType: 'application/pdf',
  read: ['staff', 'idir', 'public'],
  isPublished: true
};

const TITLED = {
  ...DOC,
  pdfTitle: {
    sourceKey: DOC.s3Key,
    originalLength: 1200,
    originalSha256: 'a'.repeat(64),
    title: 'Site C Report',
    titledLength: 1300,
    titledSha256: 'b'.repeat(64),
    status: 'titled'
  }
};

const WITHHELD = { ...TITLED, vis: { displayName: 3 } };

test('isPdf', async (t) => {
  await t.test('by recorded type, parameters ignored', () => {
    assert.equal(isPdf({ mimeType: 'Application/PDF; charset=binary' }), true);
  });

  await t.test('by extension when the type is generic', () => {
    assert.equal(isPdf({ mimeType: 'application/octet-stream', fileExt: '.PDF' }), true);
  });

  await t.test('not an image', () => {
    assert.equal(isPdf({ mimeType: 'image/png', fileExt: 'png' }), false);
  });
});

test('isEligible', async (t) => {
  await t.test('a public PDF with a stored file and a public name', () => {
    assert.equal(isEligible(DOC), true);
  });

  await t.test('a non-ASCII public name still qualifies', () => {
    assert.equal(isEligible({ ...DOC, displayName: 'Évaluation environnementale' }), true);
  });

  const ineligible = {
    'unpublished (no public token in read[])': { ...DOC, read: ['staff', 'idir'], isPublished: false },
    'isPublished true without public in read[]': { ...DOC, read: ['staff'], isPublished: true },
    'sealed': { ...DOC, read: ['compliance'] },
    'sealed even with a public token left in read[]': { ...DOC, read: ['compliance', 'public'] },
    'not a PDF': { ...DOC, mimeType: 'image/png', fileExt: 'png' },
    'no stored file': { ...DOC, s3Key: '' },
    'a vis dial withholds the name': { ...DOC, vis: { displayName: 2 } },
    'the name is blank': { ...DOC, displayName: '  ' }
  };
  for (const [name, doc] of Object.entries(ineligible)) {
    await t.test(`not when ${name}`, () => {
      assert.equal(isEligible(doc), false);
    });
  }
});

test('isCurrent', async (t) => {
  await t.test('a record made from this file under this name', () => {
    assert.equal(isCurrent(TITLED), true);
  });

  await t.test('a skipped record for the same inputs is current too: no retry', () => {
    assert.equal(isCurrent({ ...TITLED, pdfTitle: { ...TITLED.pdfTitle, status: 'skipped' } }), true);
  });

  await t.test('a newline in the stored name matches its one-line title', () => {
    assert.equal(isCurrent({ ...TITLED, displayName: 'Site C\nReport' }), true);
  });

  const stale = {
    'the document was renamed': { ...TITLED, displayName: 'Site C Report (amended)' },
    'the file was replaced (s3Key changed)': { ...TITLED, s3Key: '207/0000000000000000000000000000beef' },
    'there is no record': DOC,
    'a vis dial withholds the name': WITHHELD
  };
  for (const [name, doc] of Object.entries(stale)) {
    await t.test(`not when ${name}`, () => {
      assert.equal(isCurrent(doc), false);
    });
  }
});

test('needsRestore', async (t) => {
  await t.test('a titled file whose name a vis dial now withholds', () => {
    assert.equal(needsRestore(WITHHELD), true);
  });

  await t.test('not while the public can still read the name', () => {
    assert.equal(needsRestore(TITLED), false);
  });

  await t.test('not when the record was skipped: the file was never written', () => {
    assert.equal(needsRestore({ ...WITHHELD, pdfTitle: { ...WITHHELD.pdfTitle, status: 'skipped' } }), false);
  });

  await t.test('not when the file was replaced: the new file was never titled', () => {
    assert.equal(needsRestore({ ...WITHHELD, s3Key: '207/0000000000000000000000000000beef' }), false);
  });

  await t.test('not without a record', () => {
    assert.equal(needsRestore({ ...DOC, vis: { displayName: 3 } }), false);
  });
});
