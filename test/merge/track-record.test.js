'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  STATUS, applyWork, applyNewWork, applyPhase, applyEvent, removePhase, removeEvent, removeWork
} = require('../../src/merge/track-record');
const { workDocOf, publicWorksOf } = require('../../src/seed/track-mappers');

const AT = 1762675200000;
const LATER = AT + 1000;
const PROJECT = 'p-1';

const fixture = (name) => structuredClone(require(`../fixtures/track-records/${name}.json`));
const nestedWork = () => fixture('new_work_two_phases').work;

/** The nested work as the per-record bodies Track sends for it, all read at `pushedAt`. */
function recordsOf(work, pushedAt = AT) {
  const { phases, ...own } = work;
  return [
    { kind: 'work', body: { pushedAt, work: own } },
    ...phases.map(({ events: _events, ...phase }) => ({ kind: 'phase', body: { pushedAt, phase } })),
    ...phases.flatMap(wp => wp.events.map(event => ({ kind: 'event', body: { pushedAt, event } })))
  ];
}

const APPLY = {
  work: (doc, body) => applyWork(doc, body, { projectId: PROJECT }),
  phase: applyPhase,
  event: applyEvent
};

/** Seeded, so a failing order replays. */
function shuffled(items, seed) {
  const out = [...items];
  let state = seed;
  const next = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Applies records in turn; a PARENT_NOT_FOUND one goes to the back, as Track retries it. */
function deliver(records, doc = null) {
  const queue = [...records];
  let current = doc;
  for (let budget = records.length * records.length; queue.length && budget > 0; budget--) {
    const { kind, body } = queue.shift();
    const result = APPLY[kind](current, body);
    if (result.status === STATUS.PARENT_NOT_FOUND) queue.push({ kind, body });
    else current = result.doc;
  }
  assert.deepStrictEqual(queue, [], 'every record found its parent');
  return current;
}

const contentOf = ({ pushStamps: _stamps, updatedAt: _updatedAt, ...doc }) => doc;

const stored = () => applyNewWork(null, { pushedAt: AT, work: nestedWork() }, { projectId: PROJECT }).doc;

for (const seed of [1, 7, 42]) {
  test(`records applied one at a time in shuffled order (seed ${seed}) build the nightly's document`, () => {
    const doc = deliver(shuffled(recordsOf(nestedWork()), seed));

    assert.deepStrictEqual(contentOf(doc), contentOf(workDocOf(nestedWork(), { projectId: PROJECT })));
  });
}

test('a nested new-work POST builds the nightly\'s document and stamps every record it holds', () => {
  const doc = stored();

  assert.deepStrictEqual(contentOf(doc), contentOf(workDocOf(nestedWork(), { projectId: PROJECT })));
  assert.deepStrictEqual(Object.keys(doc.pushStamps).sort(), ['event:4001', 'event:4002', 'event:4003',
    'event:4004', 'event:4005', 'phase:3001', 'phase:3002', 'work']);
});

test('a plain work PUT changes the work and keeps its phases with their milestones', () => {
  const work = { ...fixture('work').work, work_state: 'COMPLETED' };

  const { status, doc } = applyWork(stored(), { pushedAt: LATER, work });

  assert.strictEqual(status, STATUS.APPLIED);
  assert.strictEqual(doc.workState, 'COMPLETED');
  assert.deepStrictEqual(doc.phases, stored().phases);
});

test('an event PUT moves the work outcome when it decides the last phase', () => {
  const decision = nestedWork().phases.flatMap(p => p.events).find(e => e.id === 4005);

  const { doc } = applyEvent(stored(), { pushedAt: LATER, event: { ...decision, outcome_name: 'Terminated' } });

  assert.strictEqual(doc.outcome, 'Terminated');
});

test('a phase PUT carries its suspension and keeps its milestones', () => {
  const { phase } = fixture('phase');
  Object.assign(phase, { is_suspended: true, suspended_date: '2024-03-01T08:00:00+00:00' });

  const { doc } = applyPhase(stored(), { pushedAt: LATER, phase });
  const [first] = doc.phases;

  assert.deepStrictEqual([first.isSuspended, first.suspendedDate], [true, '2024-03-01T08:00:00.000Z']);
  assert.deepStrictEqual(first.milestones.map(m => m.trackEventId), [4001, 4003]);
});

test('a record older than the stored one changes nothing', () => {
  const before = applyPhase(stored(), { pushedAt: LATER, phase: fixture('phase').phase }).doc;
  const older = { ...fixture('phase').phase, name: 'Renamed earlier' };

  const result = applyPhase(before, { pushedAt: AT, phase: older });

  assert.strictEqual(result.status, STATUS.STALE);
  assert.strictEqual(result.doc, before);
});

test('a removed event is not brought back by an older PUT', () => {
  const { event } = fixture('event');
  const removed = removeEvent(stored(), { pushedAt: LATER, eventId: event.id }).doc;

  const result = applyEvent(removed, { pushedAt: AT, event });

  assert.strictEqual(result.status, STATUS.STALE);
  assert.ok(!result.doc.phases[0].milestones.some(m => m.trackEventId === event.id));
});

test('a removed phase takes its milestones and no older PUT brings either back', () => {
  const removed = removePhase(stored(), { pushedAt: LATER, phaseId: 3001 }).doc;

  assert.deepStrictEqual(removed.phases.map(p => p.trackPhaseId), [3002]);
  assert.strictEqual(applyPhase(removed, { pushedAt: AT, phase: fixture('phase').phase }).status, STATUS.STALE);
  assert.strictEqual(applyEvent(removed, { pushedAt: AT, event: fixture('event').event }).status,
    STATUS.PARENT_NOT_FOUND);
  const restored = applyPhase(removed, { pushedAt: LATER + 1, phase: fixture('phase').phase }).doc;
  assert.strictEqual(applyEvent(restored, { pushedAt: AT, event: fixture('event').event }).status, STATUS.STALE,
    'its milestones keep a stamp after the phase comes back');
});

test('a nested POST over a stored work drops the phases it no longer holds', () => {
  const work = nestedWork();
  work.phases = work.phases.filter(wp => wp.id === 3001);

  const { doc } = applyNewWork(stored(), { pushedAt: LATER, work });

  assert.deepStrictEqual(doc.phases.map(p => p.trackPhaseId), [3001]);
});

test('a phase for a work DEMI lacks is refused as PARENT_NOT_FOUND', () => {
  const result = applyPhase(null, { pushedAt: AT, phase: fixture('phase').phase });

  assert.deepStrictEqual(result, { status: STATUS.PARENT_NOT_FOUND, doc: null });
});

test('an event under a phase DEMI lacks is refused as PARENT_NOT_FOUND', () => {
  const work = applyWork(null, fixture('work'), { projectId: PROJECT }).doc;

  assert.strictEqual(applyEvent(work, fixture('event')).status, STATUS.PARENT_NOT_FOUND);
});

test('a deleted work is a tombstone: no child lands under it and no older PUT revives it', () => {
  const tombstone = removeWork(stored(), { pushedAt: LATER, workId: 2001, workTypeId: 6 }).doc;

  assert.strictEqual(tombstone.deleted, true);
  assert.strictEqual(applyPhase(tombstone, fixture('phase')).status, STATUS.PARENT_NOT_FOUND);
  assert.strictEqual(applyWork(tombstone, fixture('work')).status, STATUS.STALE);
  assert.deepStrictEqual(publicWorksOf([tombstone], {}), []);
});
