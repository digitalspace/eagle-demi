'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { fileNameFor, pdfTitleFor } = require('../../src/helpers/file-name');

const DOC = {
  id: '5f1e2d3c4b5a69788796a5b4',
  displayName: 'Site C Report',
  documentFileName: 'site-c-report-final.pdf',
  read: ['staff', 'idir', 'public']
};

test('pdfTitleFor', async (t) => {
  await t.test('is the display name, not the file name', () => {
    assert.equal(pdfTitleFor(DOC), 'Site C Report');
  });

  await t.test('keeps a slash: a title is not a path', () => {
    assert.equal(pdfTitleFor({ ...DOC, displayName: '2019/20 Annual Report' }), '2019/20 Annual Report');
  });

  await t.test('keeps non-ASCII text', () => {
    assert.equal(pdfTitleFor({ ...DOC, displayName: 'Évaluation — Lhù’ààn Mân’' }), 'Évaluation — Lhù’ààn Mân’');
  });

  await t.test('puts a name with newlines and runs of space on one line', () => {
    assert.equal(pdfTitleFor({ ...DOC, displayName: '  Site C\r\n  Report\t\tVolume 2 ' }), 'Site C Report Volume 2');
  });

  await t.test('drops bidi overrides and turns other control characters into a space', () => {
    assert.equal(pdfTitleFor({ ...DOC, displayName: 'Site\u0007C ‮Report' }), 'Site C Report');
  });

  await t.test('is null when the name is blank', () => {
    assert.equal(pdfTitleFor({ ...DOC, displayName: ' \n ' }), null);
  });

  await t.test('is null when a vis dial withholds the name from the public', () => {
    assert.equal(pdfTitleFor({ ...DOC, vis: { displayName: 3 } }), null);
  });
});

test('fileNameFor never cuts a character in half', () => {
  // 145 + the emoji's two UTF-16 units straddle the 146-unit cut a `.pdf` name gets.
  const name = fileNameFor({ ...DOC, documentFileName: `${'a'.repeat(145)}\u{1F4C4} report.pdf` }, {});
  assert.equal(name, `${'a'.repeat(145)}.pdf`);
  assert.doesNotThrow(() => encodeURIComponent(name));
});
