'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { clean, fileNameFor, pdfTitleFor } = require('../../src/helpers/file-name');

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

test('fileNameFor turns a lone surrogate into U+FFFD', () => {
  for (const lone of ['\uD83D', '\uDCC4']) {
    const name = fileNameFor({ ...DOC, documentFileName: `Report ${lone} draft.pdf` }, {});
    assert.equal(name, 'Report \uFFFD draft.pdf');
    assert.doesNotThrow(() => encodeURIComponent(name));
  }
});

test('clean', async (t) => {
  await t.test('drops the characters Windows refuses in a file name', () => {
    assert.equal(clean('Site C: Final? <v2> "draft" a|b*.pdf'), 'Site C Final v2 draft ab.pdf');
  });

  await t.test('strips dots and spaces from both ends', () => {
    assert.equal(clean('Report.. '), 'Report');
    assert.equal(clean(' ..'), '');
  });
});

test('fileNameFor names a dot-only file by its id', () => {
  assert.equal(fileNameFor({ ...DOC, documentFileName: ' ..', displayName: '' }, {}), DOC.id);
});

test('fileNameFor leaves no dot or space where the name was cut', () => {
  const name = fileNameFor({ ...DOC, documentFileName: `${'a'.repeat(144)} . report.pdf` }, {});
  assert.equal(name, `${'a'.repeat(144)}.pdf`);
});

test('fileNameFor keeps a name off the Windows device names', () => {
  // Windows opens the device, not the file, for `CON.pdf` or `aux.draft.pdf`.
  assert.equal(fileNameFor({ ...DOC, documentFileName: 'CON.pdf' }, {}), '_CON.pdf');
  assert.equal(fileNameFor({ ...DOC, documentFileName: 'aux.draft.pdf' }, {}), '_aux.draft.pdf');
  assert.equal(fileNameFor({ ...DOC, documentFileName: 'Lpt¹ .tar.gz' }, {}), '_Lpt¹ .tar.gz');
  assert.equal(fileNameFor({ ...DOC, documentFileName: 'Console.pdf' }, {}), 'Console.pdf');
});

test('fileNameFor cleans the id it falls back to', () => {
  const blank = { ...DOC, documentFileName: '', displayName: '' };
  assert.equal(fileNameFor({ ...blank, id: '../a:b' }, {}), 'ab');
  assert.equal(fileNameFor({ ...blank, id: '..' }, {}), 'document');
});

test('clean drops characters that show as nothing or break the line', () => {
  const hidden = '\u200b\u2060\u2064\u180e\u3164\uffa0\u061c\u2028\u2029\u0085\u009f';
  assert.equal(clean(`Site${hidden}C Report.pdf`), 'SiteC Report.pdf');
});

test('clean keeps the joiners real scripts and emoji are written with', () => {
  const persian = '\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645';
  assert.equal(clean(persian), persian);
  assert.equal(clean('\u{1F469}\u200d\u{1F4BB} notes'), '\u{1F469}\u200d\u{1F4BB} notes');
});
