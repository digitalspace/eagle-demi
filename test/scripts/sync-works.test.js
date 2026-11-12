'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../../src/config');
const { syncWorkDocs } = require('../../src/scripts/sync-works');
const { workDocOf } = require('../../src/seed/track-mappers');
const { fakeWorks, useWorks } = require('../helpers/track-sync-fakes');

const PULL_START = 1762675200000;
const NOW = '2026-11-10T00:00:00.000Z';
const nestedWork = () => structuredClone(require('../fixtures/track-records/new_work_two_phases.json').work);
const storedDoc = (pushStamps, over = {}) =>
  ({ ...workDocOf(nestedWork(), { projectId: '207', pushStamps, updatedAt: NOW }), ...over });

const writeOn = (t) => {
  const held = config.worksWrite;
  config.worksWrite = true;
  t.after(() => { config.worksWrite = held; });
};
const sync = (works, opts = {}) => syncWorkDocs('207', works, { pushedAt: PULL_START, live: true, now: NOW, ...opts });

test('with WORKS_WRITE off the container is never called', async (t) => {
  const fake = useWorks(t, fakeWorks());

  await sync([nestedWork()]);

  assert.deepStrictEqual(fake.calls, []);
});

test('a work Track returns is saved as its document', async (t) => {
  writeOn(t);
  const fake = useWorks(t, fakeWorks());

  const counts = await sync([nestedWork()]);

  assert.strictEqual(counts.written, 1);
  assert.deepStrictEqual(fake.saved.map(doc => [doc.id, doc.projectId]), [['track-2001', '207']]);
});

test('a document a push stamped after the pull started is left alone and counted stale', async (t) => {
  writeOn(t);
  const fake = useWorks(t, fakeWorks([storedDoc({ work: PULL_START + 1 }, { simpleTitle: 'Pushed' })]));

  const counts = await sync([nestedWork()]);

  assert.strictEqual(counts.stale, 1);
  assert.deepStrictEqual(fake.saved, []);
});

test('a rewrite keeps the stored push stamps', async (t) => {
  writeOn(t);
  const stamps = { work: PULL_START - 1, 'phase:3001': PULL_START - 2 };
  const fake = useWorks(t, fakeWorks([storedDoc(stamps, { simpleTitle: 'Older title' })]));

  await sync([nestedWork()]);

  assert.deepStrictEqual(fake.saved[0].pushStamps, stamps);
  assert.strictEqual(fake.saved[0].simpleTitle, 'North Pit');
});

test('a document equal to Track\'s work is not written again', async (t) => {
  writeOn(t);
  const fake = useWorks(t, fakeWorks([storedDoc({ work: PULL_START - 1 }, { updatedAt: '2026-01-01T00:00:00.000Z' })]));

  const counts = await sync([nestedWork()]);

  assert.strictEqual(counts.unchanged, 1);
  assert.deepStrictEqual(fake.saved, []);
});

test('a stored work Track no longer returns is tombstoned with its stamps', async (t) => {
  writeOn(t);
  const fake = useWorks(t, fakeWorks([storedDoc({ work: PULL_START - 1 })]));

  await sync([]);

  assert.deepStrictEqual(fake.saved, [{ id: 'track-2001', projectId: '207', deleted: true, pushStamps: { work: PULL_START - 1 } }]);
});

test('a missing work a push stamped after the pull started is kept and counted stale', async (t) => {
  writeOn(t);
  const fake = useWorks(t, fakeWorks([storedDoc({ work: PULL_START + 1 })]));

  const counts = await sync([]);

  assert.strictEqual(counts.stale, 1);
  assert.deepStrictEqual(fake.saved, []);
});

test('a dry run reads the container and writes nothing', async (t) => {
  writeOn(t);
  const fake = useWorks(t, fakeWorks());

  const counts = await sync([nestedWork()], { live: false });

  assert.strictEqual(counts.written, 1);
  assert.deepStrictEqual(fake.saved, []);
});
