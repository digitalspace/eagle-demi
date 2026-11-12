'use strict';

// Zip entries are STORED, so the uploaded bytes hold each entry name as plain text.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const projects = require('../../src/repositories/projects');

const worker = require('../../src/jobs/bulk-download');

const { PROJECT, doc, job, harness, readyPatch } = require('./bulk-download-harness');

test('the bulk download worker', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a long project folder cut short does not end in a dot or space', async (tt) => {
    const docs = [doc('d1')];
    const { uploads, zipText } = harness(tt, { row: job(docs), docs });
    // The 100-character cut lands just after ". ", which Windows drops when it extracts.
    tt.mock.method(projects, 'listByIds',
      async () => [{ id: PROJECT.id, name: `${'A'.repeat(98)}. Phase 2` }]);

    await worker.run('job-1');

    assert.ok(zipText([...uploads.keys()][0]).includes(`${'A'.repeat(98)}/d1.pdf`),
      'a folder ending in a dot or space extracts under a different name than the zip lists');
  });

  await t.test('a project folder cut short never keeps half of a character', async (tt) => {
    const docs = [doc('d1')];
    const { uploads, zipText } = harness(tt, { row: job(docs), docs });
    tt.mock.method(projects, 'listByIds', async () => [{ id: PROJECT.id, name: `${'A'.repeat(99)}\u{1F4C4}` }]);

    await worker.run('job-1');

    assert.ok(zipText([...uploads.keys()][0]).includes(`${'A'.repeat(99)}/d1.pdf`));
  });

  await t.test('a project named errors.txt does not collide with the error list', async (tt) => {
    const docs = [doc('d1')];
    const { uploads, zipText } = harness(tt, { row: job(docs), docs });
    tt.mock.method(projects, 'listByIds', async () => [{ id: PROJECT.id, name: 'Errors.TXT' }]);

    await worker.run('job-1');

    assert.match(zipText([...uploads.keys()][0]), /Errors\.TXT \(project\)\/d1\.pdf/);
  });

  await t.test('fullwidth dots and backslashes cannot climb out of the folder', async (tt) => {
    const docs = [doc('d1', { documentFileName: '\uff0e\uff0e\uff3c\uff0e\uff0e\uff3cx.bat', fileExt: 'bat' })];
    const { uploads, zipText } = harness(tt, { row: job(docs), docs });

    await worker.run('job-1');

    const text = zipText([...uploads.keys()][0]);
    assert.match(text, /Site C Clean Energy\/x\.bat/);
    assert.doesNotMatch(text, /\uff0e|\uff3c/);
  });

  await t.test('a name written decomposed and one precomposed are one name to a Mac', async (tt) => {
    const docs = [doc('d1', { documentFileName: 'r\u00e9port.pdf' }), doc('d2', { documentFileName: 're\u0301port.pdf' })];
    const { uploads, zipText } = harness(tt, { row: job(docs), docs });

    await worker.run('job-1');

    assert.match(zipText([...uploads.keys()][0]), /port \(2\)\.pdf/);
  });

  await t.test('a long project label cut short does not end in a dot or space', async (tt) => {
    const docs = [doc('d1')];
    const { patches } = harness(tt, { row: job(docs), docs });
    tt.mock.method(projects, 'listByIds',
      async () => [{ id: PROJECT.id, name: `${'A'.repeat(98)}. Phase 2` }]);

    await worker.run('job-1');

    assert.strictEqual(readyPatch(patches).label, 'A'.repeat(98),
      'the label names the downloaded zip, and a trailing dot or space is lost on save');
  });

  await t.test('a project label cut short never keeps half of a character', async (tt) => {
    const docs = [doc('d1')];
    const { patches } = harness(tt, { row: job(docs), docs });
    tt.mock.method(projects, 'listByIds', async () => [{ id: PROJECT.id, name: `${'A'.repeat(99)}\u{1F4C4}` }]);

    await worker.run('job-1');

    assert.strictEqual(readyPatch(patches).label, 'A'.repeat(99));
  });
});
