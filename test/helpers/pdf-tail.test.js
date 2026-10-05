'use strict';

/**
 * The increment check against real `pdf-title/titler.py` output (fixtures written by it from the
 * titler's own test builders) and against hand-built hostile increments.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkTail } = require('../../src/helpers/pdf-tail');
const { readOriginal } = require('../../src/helpers/pdf-original');
const { fixture, classicTail, classicPdf } = require('./pdf-build');

const CASES = ['classic-xmp', 'classic-info', 'xrefstream-xmp', 'xrefstream-noinfo'];

function load(name, titled = 'titled', ext = '.pdf') {
  return { original: fixture(`${name}.original${ext}`), titled: fixture(`${name}.${titled}${ext}`) };
}

const readFacts = (original) => readOriginal(async (offset, length) => original.subarray(offset, offset + length), original.length);

test('real titler output passes', async (t) => {
  const shapes = [
    ...CASES.map(name => [name]),
    ['classic-info', 'retitled'],
    ['objstm-xmp'],
    ['linearized-large', 'titled', '.pdf.gz']
  ];
  for (const [name, titledAs = 'titled', ext] of shapes) {
    await t.test(`${name} ${titledAs}`, async () => {
      const { original, titled } = load(name, titledAs, ext);
      assert.ok(titled.subarray(0, original.length).equals(original));
      const facts = await readFacts(original);
      assert.ok(!facts.error, facts.error);
      assert.equal(checkTail(titled.subarray(original.length), original.length, facts), null);
    });
  }
});

test('facts not in the structural reader\'s shape are refused', async () => {
  const { original, titled } = load('classic-xmp');
  const facts = await readFacts(original);
  const tail = titled.subarray(original.length);
  const [num, gen] = facts.metadata;
  // The retired text scan's shape, naming the right object, still fails closed.
  const old = { ...facts, metadataObjects: [`${num} ${gen}`] };
  delete old.metadata;
  assert.equal(checkTail(tail, original.length, old), 'original-unscanned');
  assert.equal(checkTail(tail, original.length, null), 'original-unscanned');
  assert.equal(checkTail(tail, original.length, facts), null);
});

test('a fake metadata header after a literal endstream cannot make a page XMP (N9)', async () => {
  // The content stream has an indirect /Length, and its data holds `endstream` and then a
  // metadata header for object 4, the page.
  const decoy = 'BT ET\n% endstream\n4 0 obj\n<< /Type /Metadata /Subtype /XML /Length 0 >>\nstream\n\nendstream\nendobj\n';
  const original = classicPdf([
    [1, '<< /Title (Old) >>'],
    [2, '<< /Type /Catalog /Pages 3 0 R >>'],
    [3, '<< /Type /Pages /Kids [4 0 R] /Count 1 >>'],
    [4, '<< /Type /Page /Parent 3 0 R /MediaBox [0 0 200 200] /Contents 5 0 R >>'],
    [5, `<< /Length 6 0 R >>\nstream\n${decoy}\nendstream`],
    [6, String(decoy.length + 1)]
  ], '/Size 7 /Root 2 0 R /Info 1 0 R');
  const facts = await readFacts(original);
  assert.equal(facts.metadata, null);
  const xmp = '<< /Type /Metadata /Subtype /XML /Length 5 >>\nstream\n<x/>\n\nendstream';
  const tail = classicTail(original, [[1, '<< /Title (New) >>'], [4, xmp]], `/Size 7 /Root 2 0 R /Info 1 0 R /Prev ${facts.prev}`);
  assert.equal(checkTail(tail, original.length, facts), 'tail-xmp-number');
});

test('hostile increments are refused', async (t) => {
  const { original } = load('classic-info');
  const facts = await readFacts(original);
  const trailer = `/Size ${facts.size} /Root ${facts.root.join(' ')} R /Info 1 0 R /Prev ${facts.prev}`;
  const info = '<< /Title (Site C Report) /Producer (x) >>';
  const check = (tail) => checkTail(tail, original.length, facts);

  await t.test('the hand-built control passes, so each refusal below is its own', () => {
    assert.equal(check(classicTail(original, [[1, info]], trailer)), null);
  });

  const cases = {
    'a page object added': [[[1, info], [9, '<< /Type /Page /Parent 2 0 R /Contents 10 0 R >>']], /tail-forbidden:Contents|tail-info/],
    'OpenAction in the Info dictionary': [[[1, '<< /Title (x) /OpenAction 5 0 R >>']], /tail-forbidden:OpenAction/],
    'JavaScript as a name value': [[[1, '<< /Title (x) /S /JavaScript >>']], /tail-forbidden:JavaScript/],
    'a hex-escaped JS key': [[[1, '<< /Title (x) /#4A#53 (app.alert(1)) >>']], /tail-forbidden:JS/],
    'a URI inside an array': [[[1, '<< /Title (x) /K [/URI] >>']], /tail-forbidden:URI/],
    'an Info value that is a reference': [[[1, '<< /Title (x) /Author 4 0 R >>']], /tail-info/],
    'an Info value that is a dictionary': [[[1, '<< /Title (x) /Pages << /Count 1 >> >>']], /tail-info/],
    'an Info without a title': [[[1, '<< /Producer (x) >>']], /tail-info/],
    'two Info dictionaries': [[[1, info], [9, info]], /tail-info/],
    'the Info revised under another number': [[[2, info]], /tail-info-number|tail-info-ref/],
    'a filtered stream': [[[1, info], [9, '<< /Type /Metadata /Subtype /XML /Filter /FlateDecode /Length 1 >>\nstream\nx\nendstream']], /tail-forbidden:Filter/],
    'an object stream': [[[1, info], [9, '<< /Type /ObjStm /N 1 /First 4 /Length 1 >>\nstream\nx\nendstream']], /tail-forbidden:ObjStm/],
    'an XMP stream on a number that was not metadata': [[[1, info], [2, '<< /Type /Metadata /Subtype /XML /Length 1 >>\nstream\nx\nendstream']], /tail-xmp-number/],
    'a stream of another type': [[[1, info], [9, '<< /Length 1 >>\nstream\nx\nendstream']], /tail-object/]
  };
  for (const [label, [bodies, reason]] of Object.entries(cases)) {
    await t.test(label, () => {
      assert.match(String(check(classicTail(original, bodies, trailer))), reason);
    });
  }

  await t.test('a trailer naming another root', () => {
    assert.equal(check(classicTail(original, [[1, info]], trailer.replace(`/Root ${facts.root.join(' ')} R`, '/Root 1 0 R'))), 'tail-root');
  });

  await t.test('a trailer with a wrong /Prev', () => {
    assert.equal(check(classicTail(original, [[1, info]], trailer.replace(`/Prev ${facts.prev}`, '/Prev 9'))), 'tail-prev');
  });

  await t.test('an extra trailer key such as /Encrypt', () => {
    assert.equal(check(classicTail(original, [[1, info]], `${trailer} /Encrypt 7 0 R`)), 'tail-trailer');
  });

  await t.test('an xref entry pointing back into the original', () => {
    const tail = classicTail(original, [[1, info]], trailer);
    const text = tail.toString('latin1');
    const entry = String(original.length).padStart(10, '0');
    const moved = Buffer.from(text.replace(`${entry} 00000 n`, '0000000009 00000 n'), 'latin1');
    assert.equal(check(moved), 'tail-xref');
  });

  await t.test('bytes after %%EOF', () => {
    assert.equal(check(Buffer.concat([classicTail(original, [[1, info]], trailer), Buffer.from('3 0 obj\n<< >>\nendobj\n')])), 'tail-trailing-bytes');
  });

  await t.test('a trailer /Size that does not cover the new numbers', () => {
    const bodies = [[1, info], [facts.size + 3, '<< /Title (x) >>']];
    assert.match(String(check(classicTail(original, bodies, trailer))), /tail-info|tail-size/);
    const fresh = { ...facts, info: null };
    const newInfo = classicTail(original, [[facts.size + 3, info]], trailer.replace('/Info 1 0 R', `/Info ${facts.size + 3} 0 R`));
    assert.equal(checkTail(newInfo, original.length, fresh), 'tail-size');
  });

  await t.test('an xref generation that differs from the object\'s', () => {
    const tail = classicTail(original, [[1, info]], trailer);
    const bent = Buffer.from(tail.toString('latin1').replace(' 00000 n', ' 00001 n'), 'latin1');
    assert.equal(check(bent), 'tail-xref');
  });

  await t.test('a comment after %%EOF', () => {
    assert.equal(check(Buffer.concat([classicTail(original, [[1, info]], trailer), Buffer.from('% note\n')])), 'tail-trailing-bytes');
  });

  await t.test('an original the reader refused refuses everything', () => {
    const tail = classicTail(original, [[1, info]], trailer);
    assert.equal(checkTail(tail, original.length, { error: 'original-no-startxref' }), 'original-no-startxref');
  });
});

test('an xref stream may not take a number the original uses', async () => {
  const { original, titled } = load('xrefstream-noinfo');
  const facts = await readFacts(original);
  const tail = titled.subarray(original.length).toString('latin1');
  const xrefNum = Number(/(\d+) 0 obj\n<< \/Type \/XRef/.exec(tail)[1]);
  assert.ok(xrefNum >= facts.size, 'the titler takes a fresh number');
  // Same bytes, but the original is told its numbers reach past the xref stream's.
  assert.equal(checkTail(titled.subarray(original.length), original.length, { ...facts, size: xrefNum + 1 }), 'tail-object-number');
});
