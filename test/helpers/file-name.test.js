'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { clean, fileNameFor, pdfTitleFor } = require('../../src/helpers/file-name');
const { finishes } = require('./finishes');

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

test('clean folds look-alikes of separators, dots and refused characters', async (t) => {
  await t.test('fullwidth dots and backslashes leave no path and no leading dots', () => {
    assert.strictEqual(clean('\uff0e\uff0e\uff3c\uff0e\uff0e\uff3cx.bat'), 'x.bat');
    assert.strictEqual(clean('\uff0e\uff0e\uff0fx.bat'), 'x.bat');
  });

  await t.test('drops the fullwidth forms of the characters Windows refuses', () => {
    assert.strictEqual(clean('a\uff1c\uff1e\uff1a\uff02\uff5c\uff1f\uff0ab'), 'ab');
  });

  await t.test('drops the division and fraction slashes, which NFKC keeps', () => {
    assert.strictEqual(clean('a\u2215b'), 'ab');
    assert.strictEqual(clean('a\u2044b'), 'ab');
  });

  await t.test('leaves other compatibility characters as written', () => {
    assert.strictEqual(clean('\ufb01nal m\u00b2 \u00bd \uff21.pdf'), '\ufb01nal m\u00b2 \u00bd \uff21.pdf');
  });
});

test('clean drops what Japanese and Korean code pages turn into a backslash or colon', () => {
  assert.strictEqual(clean('a\u00a5..\u00a5..\u00a5x.exe'), 'a....x.exe');
  assert.strictEqual(clean('a\u20a9b\u2216c\u2236d'), 'abcd');
});

test('clean collapses a run of whitespace, so padding cannot push the extension out of view', () => {
  assert.strictEqual(clean(`invoice.pdf${' '.repeat(120)}x.exe`), 'invoice.pdf x.exe');
  assert.strictEqual(clean('a \u00a0\u3000 b'), 'a b');
  assert.strictEqual(clean('a\u00a0b'), 'a\u00a0b');
});

test('clean drops fillers, format characters and tags that show as nothing', () => {
  const hidden = '\u115f\u1160\u2800\ufeff\u00ad\u034f\u17b4\u17b5\u180b\u180c\u180d\u180f' +
    '\ufff9\ufffa\ufffb\u{e0001}\u{e0041}\u{e007f}\u{1d173}\u{1d17a}';
  assert.strictEqual(clean(`Site${hidden}C.pdf`), 'SiteC.pdf');
  assert.strictEqual(clean('\u2764\ufe0f notes'), '\u2764\ufe0f notes', 'emoji are written with U+FE0F');
});

test('fileNameFor keeps a name off the console device names', () => {
  assert.strictEqual(fileNameFor({ ...DOC, documentFileName: 'CONIN$.txt' }, {}), '_CONIN$.txt');
  assert.strictEqual(fileNameFor({ ...DOC, documentFileName: 'conout$' }, {}), '_conout$');
});

test('clean is linear in a long inner run of spaces or dots', () => {
  const module = require.resolve('../../src/helpers/file-name');
  assert.ok(finishes(module, "m.clean('a' + ' '.repeat(400000) + 'b')"));
  assert.ok(finishes(module, "m.clean('a' + '.'.repeat(400000) + 'b')"));
});
