'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { listsOf, countLines } = require('../../src/scripts/works-import-lists');
const { PROJECT, trackWork } = require('../helpers/works-import-fakes');

const sheet = (n, actYear, workTypeCode, fields) => ({ id: `sheet-${n}`, projectId: PROJECT, source: 'sheet', actYear, workTypeCode, ...fields });
const loaded = [
  sheet(1, 1996, 'assessment', { workState: 'transitioned' }),
  sheet(2, 2002, 'assessment', { workState: 'transitioning' }),
  sheet(3, 2002, 'amendment', { decisionDate: '2020-03-01' }),
  sheet(4, 1996, 'amendment', { decisionDate: '2010-05-01' }),
  sheet(5, 2002, 'amendment', { decisionDate: '2026-02-01' })
];
const trackWorks = new Map([[PROJECT, [trackWork(43, { decisionDate: '2020-03-01' }), trackWork(44, { decisionDate: '2010-05-01' })]]]);
const marker = {
  projectId: PROJECT, active: true, untilTrack: [], pairedTrackWorkIds: ['track-43', 'track-44'],
  hidden: [{ trackWorkId: 'track-43', sheetWorkId: 'sheet-3' }, { trackWorkId: 'track-44', sheetWorkId: 'sheet-4' }]
};
const skip = (reason, sourceKey, actYear, workTypeCode, extra) => ({ reason, source: 'override', projectId: PROJECT, sourceKey, actYear, workTypeCode, ...extra });
const report = [
  skip('trackAlive', '9:amendment:1', 2002, 'amendment'),
  skip('trackAlive', '9:amendment:1', 2002, 'amendment', { child: 'decision:1' }),
  skip('afterBoundary', '10:substantial-start:1', 1996, 'substantial-start', { closed: 'after' }),
  skip('afterBoundary', '11:amendment:1', 2002, 'amendment', { closed: 'after', untilTrack: true }),
  { reason: 'invalid', sourceKey: '12:amendment:1' },
  { reason: 'duplicateKey', sourceKey: '13:amendment:1' },
  { reason: 'noPhase', sourceKey: '14:amendment:1' }
];

const lines = countLines({ entries: [], report, lists: listsOf({ loaded, markers: [marker], trackWorks, trackPublic: new Map(), report }) });
const valueOf = name => Number(lines.find(line => line.startsWith(`${name}=`)).split('=')[1]);
const withPrefix = prefix => lines.filter(line => line.startsWith(prefix));

test('count lines tally loaded, shown and hidden works by Act and kind, and the hidden lines sum to trackHidden', () => {
  assert.deepEqual(withPrefix('works.'), ['works.1996.amendment=1', 'works.1996.assessment=1', 'works.2002.amendment=2', 'works.2002.assessment=1']);
  assert.deepEqual(withPrefix('shown.'), ['shown.1996.amendment=1', 'shown.1996.assessment=1', 'shown.2002.amendment=1', 'shown.2002.assessment=1']);
  assert.deepEqual(withPrefix('hidden.'), ['hidden.1996.amendment=1', 'hidden.2002.amendment=1']);
  const hiddenSum = withPrefix('hidden.').reduce((sum, line) => sum + Number(line.split('=')[1]), 0);
  assert.equal(hiddenSum, valueOf('trackHidden'));
  assert.equal(valueOf('transitioned'), 1);
});

test('skipped counts only whole works the override skips, and refused counts invalid and duplicate keys', () => {
  assert.deepEqual(withPrefix('skipped.'), ['skipped.1996.substantial-start=1', 'skipped.2002.amendment=1']);
  assert.equal(valueOf('refused'), 2);
});
