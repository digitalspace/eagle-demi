'use strict';

/**
 * The increment check against real `pdf-title/titler.py` output (fixtures written by it from the
 * titler's own test builders) and against hand-built hostile increments.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { originalScanner, checkTail } = require('../../src/helpers/pdf-tail');

const DIR = path.join(__dirname, '..', 'fixtures', 'pdf-title');
const CASES = ['classic-xmp', 'classic-info', 'xrefstream-xmp', 'xrefstream-noinfo'];

function load(name) {
  return {
    original: fs.readFileSync(path.join(DIR, `${name}.original.pdf`)),
    titled: fs.readFileSync(path.join(DIR, `${name}.titled.pdf`))
  };
}

function factsOf(original, chunk = 97) {
  const scan = originalScanner();
  for (let i = 0; i < original.length; i += chunk) scan.push(original.subarray(i, i + chunk));
  return scan.result();
}

/** A classic increment after `original` with these object bodies and trailer, offsets correct. */
function classicTail(original, bodies, trailer) {
  let text = '';
  const offsets = new Map();
  for (const [num, body] of bodies) {
    offsets.set(num, original.length + Buffer.byteLength(text, 'latin1'));
    text += `${num} 0 obj\n${body}\nendobj\n`;
  }
  const xrefAt = original.length + Buffer.byteLength(text, 'latin1');
  text += 'xref\n';
  for (const [num, offset] of [...offsets].sort((a, b) => a[0] - b[0])) {
    text += `${num} 1\n${String(offset).padStart(10, '0')} 00000 n\r\n`;
  }
  text += `trailer\n<< ${trailer} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(text, 'latin1');
}

test('real titler output passes', async (t) => {
  for (const name of CASES) {
    await t.test(name, () => {
      const { original, titled } = load(name);
      assert.ok(titled.subarray(0, original.length).equals(original));
      assert.equal(checkTail(titled.subarray(original.length), original.length, factsOf(original)), null);
    });
  }

  await t.test('the scan does not depend on where chunks split', () => {
    const { original, titled } = load('xrefstream-xmp');
    for (const chunk of [1, 7, 64, 4096]) {
      assert.equal(checkTail(titled.subarray(original.length), original.length, factsOf(original, chunk)), null, chunk);
    }
  });
});

test('hostile increments are refused', async (t) => {
  const { original } = load('classic-info');
  const facts = factsOf(original);
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

  await t.test('an original whose last trailer cannot be read refuses everything', () => {
    const tail = classicTail(original, [[1, info]], trailer);
    assert.equal(checkTail(tail, original.length, { error: 'original-trailer-unreadable' }), 'original-trailer-unreadable');
    assert.equal(factsOf(Buffer.from('%PDF-1.4\nno trailer here\n')).error, 'original-no-startxref');
  });
});
