'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { logger } = require('../../src/utils/logger');
const finder = require('../../src/scripts/find-public-under-closed');

const EAGLE = '5c0f1f0b2a2b3c4d5e6f7a8b';
const TWIN = `eagle-${EAGLE}`;
const PUBLIC = ['public', 'sysadmin'];
const CLOSED = ['sysadmin'];

const trackRow = (read) => ({ id: '1234', eagleId: EAGLE, read, sources: { track: true } });
const twinRow = (read) => ({ id: TWIN, eagleId: EAGLE, read, sources: {} });
const update = (id, projectId = EAGLE) => ({ id, projectId, read: PUBLIC });

test('find-public-under-closed', async (t) => {
  await t.test("a closed twin's updates follow its public Track row: not flagged", () => {
    const flagged = finder.closedUpdateParents([update('u1')], [twinRow(CLOSED), trackRow(PUBLIC)], new Set());

    assert.deepStrictEqual([...flagged], []);
  });

  await t.test('updates under a closed Track row are flagged on that row, not its twin', () => {
    const flagged = finder.closedUpdateParents([update('u1')], [twinRow(PUBLIC), trackRow(CLOSED)], new Set());

    assert.deepStrictEqual([...flagged], [['1234', ['u1']]]);
  });

  await t.test('an id a notification owns is skipped', () => {
    const rows = [trackRow(CLOSED)];

    const flagged = finder.closedUpdateParents([update('u1')], rows, new Set([EAGLE]));

    assert.deepStrictEqual([...flagged], []);
  });

  await t.test('a twin with a Track row repairs with {updates:false}; a lone twin with none', () => {
    const lone = { id: 'eagle-aaaaaaaaaaaaaaaaaaaaaaaa', eagleId: 'aaaaaaaaaaaaaaaaaaaaaaaa', read: CLOSED, sources: {} };
    const findings = finder.buildFindings({
      projectRows: [twinRow(CLOSED), trackRow(PUBLIC), lone],
      closedDocs: new Map([[TWIN, ['d1']], [lone.id, ['d2']]]),
      updateParents: new Map()
    });

    assert.deepStrictEqual(findings.map(f => [f.projectId, f.twin, f.options]), [
      [TWIN, true, { updates: false }],
      [lone.id, true, {}]
    ]);
  });

  await t.test('documents are read from closed partitions only; exit 1 when found, 0 when clean', async (t) => {
    t.mock.method(logger, 'info', () => {});
    const partitions = [];
    const query = async (container, spec, options) => {
      if (container === 'projects') return { items: [{ id: '1234', eagleId: EAGLE, read: CLOSED, tracked: true }, { id: '99', read: PUBLIC }] };
      if (container === 'documents') {
        partitions.push(options.partitionKey);
        return { items: [{ id: 'd1' }] };
      }
      return { items: container === 'updates' ? [update('u1')] : [] };
    };

    const findings = await finder.find({ query });

    assert.deepStrictEqual(partitions, ['1234']);
    assert.deepStrictEqual(findings, [
      { projectId: '1234', eagleId: EAGLE, twin: false, options: {}, documents: ['d1'], updates: ['u1'] }
    ]);
    assert.strictEqual(finder.report(findings), 1);
    assert.strictEqual(finder.report([]), 0);
  });
});
