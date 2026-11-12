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

  await t.test('rows whose works the container composes the same pass with mismatch=0', async () => {
    worksContainer(t, [workDocs()]);
    const lines = logged(t);

    const code = await run({ projects: projectsOf() });

    assert.strictEqual(code, 0);
    assert.deepStrictEqual(lines, ['[works-parity] projects=1 failures=0 mismatch=0']);
  });

  await t.test('one work that differs names its project, counts mismatch=1 and exits 1', async () => {
    const moved = trackWorks();
    moved[1].work_state = 'IN_PROGRESS';
    worksContainer(t, [workDocs(moved)]);
    const lines = logged(t);

    const code = await run({ projects: projectsOf() });

    assert.strictEqual(code, 1);
    assert.deepStrictEqual(lines, ['[works-parity] mismatch id=207', '[works-parity] projects=1 failures=0 mismatch=1']);
  });
});
