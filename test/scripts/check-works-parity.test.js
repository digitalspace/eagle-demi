'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { run } = require('../../src/scripts/check-works-parity');
const { logger } = require('../../src/utils/logger');
const { trackWorks, storedRow, workDocs, worksContainer } = require('../helpers/track-works-fixtures');

/** The rows the run lists: project 207 with its Track works, and an Eagle-only row with none. */
const projectsOf = () => ({ listVisible: async () => ({ items: [storedRow(), { id: 'eagle-1', read: ['staff'] }] }) });

function logged(t) {
  const lines = [];
  for (const level of ['info', 'warn', 'error']) t.mock.method(logger, level, (msg) => { lines.push(msg); });
  return lines;
}

test('check-works-parity', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('rows whose works the container composes the same pass with storedMismatch=0', async () => {
    worksContainer(t, [workDocs()]);
    const lines = logged(t);

    const code = await run({ projects: projectsOf(), workProjectIds: async () => ['207', '207'] });

    assert.strictEqual(code, 0);
    assert.deepStrictEqual(lines, ['[works-parity] projects=1 failures=0 storedMismatch=0 orphaned=0']);
  });

  await t.test('parity storedMismatch counts a stored works copy that differs from the composed works', async () => {
    const moved = trackWorks();
    moved[1].work_state = 'IN_PROGRESS';
    worksContainer(t, [workDocs(moved)]);
    const lines = logged(t);

    const code = await run({ projects: projectsOf(), workProjectIds: async () => [] });

    assert.strictEqual(code, 1);
    assert.deepStrictEqual(lines, ['[works-parity] storedMismatch id=207',
      '[works-parity] projects=1 failures=0 storedMismatch=1 orphaned=0']);
  });

  await t.test('a live work whose project has no row counts as orphaned and does not fail the run', async () => {
    worksContainer(t, [workDocs()]);
    const lines = logged(t);

    const code = await run({ projects: projectsOf(), workProjectIds: async () => ['207', 'gone-1', 'gone-1'] });

    assert.strictEqual(code, 0);
    assert.deepStrictEqual(lines, ['[works-parity] projects=1 failures=0 storedMismatch=0 orphaned=2']);
  });
});
