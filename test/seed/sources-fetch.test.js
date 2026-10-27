'use strict';

/**
 * `fetchJson` is stubbed by every other seed test, so its own contract is only covered here: the
 * caller's headers reach `fetch`. The Track team feed is unauthorised without them.
 *
 * `loadTrackProjects` is covered here for the same reason — every other test injects it, so the
 * choice between the live feed and the checked-in export is only made for real in this file.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { fetchJson, loadTrackProjects } = require('../../src/seed/sources');

test('fetchJson passes the caller headers to fetch', async (t) => {
  const calls = [];
  t.mock.method(global, 'fetch', async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ items: [] }) };
  });

  const body = await fetchJson('https://track.example/api/v1/projects/team-members',
    { Authorization: 'Bearer track-token' });

  assert.deepStrictEqual(body, { items: [] });
  assert.strictEqual(calls.length, 1, 'one attempt, no retry');
  assert.strictEqual(calls[0].url, 'https://track.example/api/v1/projects/team-members');
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer track-token');
});

test('loadTrackProjects reads the checked-in export when no reader client is configured', async () => {
  const projects = await loadTrackProjects();

  assert.ok(projects.length > 300, `${projects.length} rows from the offline fixture`);
  assert.ok(projects.every(p => p.track_project_id), 'the flat shape the merge reads');
});

test('loadTrackProjects prefers the live feed once TRACK_API_BASE and the client are set', async (t) => {
  for (const [key, value] of Object.entries({
    TRACK_API_BASE: 'https://track.example', TRACK_CLIENT_ID: 'demi-track-reader',
    TRACK_CLIENT_SECRET: 'not-a-real-secret'
  })) {
    const held = process.env[key];
    process.env[key] = value;
    t.after(() => { if (held === undefined) delete process.env[key]; else process.env[key] = held; });
  }
  // config caches process.env at require time, so the module has to be re-read with them set.
  delete require.cache[require.resolve('../../src/config')];
  delete require.cache[require.resolve('../../src/seed/sources')];
  t.after(() => {
    delete require.cache[require.resolve('../../src/config')];
    delete require.cache[require.resolve('../../src/seed/sources')];
  });
  const sources = require('../../src/seed/sources');

  const urls = [];
  t.mock.method(global, 'fetch', async (url) => {
    urls.push(String(url));
    return String(url).endsWith('/token')
      ? { ok: true, json: async () => ({ access_token: 'track-token' }) }
      : { ok: true, json: async () => [{ id: 207, name: 'Nicomen', project_state: { name: 'Closed' } }] };
  });

  const projects = await sources.loadTrackProjects();

  assert.deepStrictEqual(projects.map(p => p.track_project_id), [207], 'the feed, not the 382-row file');
  assert.strictEqual(projects[0].project_state_name, 'Closed', 'and mapped to the flat shape');
  assert.ok(urls.some(u => u.endsWith('/api/v1/projects')), urls.join(', '));
});

/**
 * Track work phases. The fixtures are shaped like the real responses: `GET /works` is
 * `WorkResponseSchema` (`include_fk`, so `project_id` and `work_type_id` ride alongside the nested
 * objects) and `GET /works/<id>/phases` is `WorkPhaseAdditionalInfoResponseSchema` — a `work_phase`
 * wrapper with the phase code nested under it. Nothing here reaches Track; no credential for it
 * exists outside Azure.
 */
const ASSESSMENT = 6;
const AMENDMENT = 7;

const work = (id, projectId, workTypeId, over = {}) => ({
  id,
  project_id: projectId,
  work_type_id: workTypeId,
  work_type: { id: workTypeId, name: workTypeId === ASSESSMENT ? 'Assessment' : 'Amendment' },
  project: { id: projectId, name: `Project ${projectId}` },
  is_active: true,
  ...over
});

const phaseRow = (workPhase = {}) => ({
  work_phase: {
    id: 900,
    name: 'Early Engagement',
    start_date: '2021-05-03T00:00:00+00:00',
    end_date: '2021-11-08T00:00:00+00:00',
    number_of_days: 90,
    legislated: true,
    sort_order: 1,
    is_completed: true,
    is_suspended: false,
    visibility: 'REGULAR',
    responsibility_notes: 'internal note',
    work_id: 11,
    phase_id: 5,
    phase: {
      id: 5,
      name: 'Early Engagement (phase code)',
      number_of_days: 90,
      legislated: true,
      sort_order: 1,
      ea_act_id: 3,
      ea_act: { id: 3, name: '2018 Act' },
      work_type_id: ASSESSMENT,
      work_type: { id: ASSESSMENT, name: 'Assessment' },
      color: '#123456',
      visibility: 'REGULAR'
    },
    ...workPhase
  },
  total_number_of_days: 90,
  days_left: 0,
  days_taken: 189
});

/** `get` answers by URL and records the path, so the call plan itself is what the tests assert. */
function fakeTrack({ works = [], phasesByWork = {}, fail = () => false } = {}) {
  const paths = [];
  const get = async (url, headers) => {
    paths.push(url.slice(url.indexOf('/api/v1')));
    assert.strictEqual(headers.Authorization, 'Bearer track-token', url);
    if (url.endsWith('/api/v1/works')) return works;
    const match = url.match(/\/works\/(\d+)\/phases$/);
    if (!match) throw new Error(`unexpected call: ${url}`);
    if (fail(Number(match[1]))) throw new Error('HTTP 500 Server Error');
    return phasesByWork[match[1]] || [];
  };
  return { get, paths };
}

test('fetchTrackWorks reads one work list then one phase call per assessment work', async () => {
  const { fetchTrackWorks } = require('../../src/seed/sources');
  const { get, paths } = fakeTrack({
    works: [work(11, 207, ASSESSMENT), work(12, 207, AMENDMENT), work(13, 354, ASSESSMENT)],
    phasesByWork: { 11: [phaseRow()], 13: [phaseRow()] }
  });

  const { phases: byProject } = await fetchTrackWorks('track-token', get);

  assert.deepStrictEqual(paths,
    ['/api/v1/works', '/api/v1/works/11/phases', '/api/v1/works/13/phases'],
    'the work list is read once and the amendment work is never asked about');
  assert.deepStrictEqual([...byProject.keys()], ['207', '354'], 'keyed by TRACK project id');
});

test('fetchTrackWorks maps a phase to the public shape, dates as ISO', async () => {
  const { fetchTrackWorks } = require('../../src/seed/sources');
  const { get } = fakeTrack({
    works: [work(11, 207, ASSESSMENT)],
    phasesByWork: { 11: [phaseRow()] }
  });

  const [phase] = (await fetchTrackWorks('track-token', get)).phases.get('207');

  assert.deepStrictEqual(phase, {
    // The work's own name wins over the phase code's: Track lets a work rename its phase.
    name: 'Early Engagement',
    eaActId: 3,
    eaActName: '2018 Act',
    workType: 'Assessment',
    startDate: '2021-05-03T00:00:00.000Z',
    endDate: '2021-11-08T00:00:00.000Z',
    numberOfDays: 90,
    legislated: true,
    sortOrder: 1,
    isCompleted: true
  }, 'exactly the listed fields — internal notes, ids and day counts stay in Track');
});

test('fetchTrackWorks sorts by sort order and keeps an unfinished phase open', async () => {
  const { fetchTrackWorks } = require('../../src/seed/sources');
  const { get } = fakeTrack({
    works: [work(11, 207, ASSESSMENT)],
    phasesByWork: {
      11: [
        phaseRow({ name: 'Application Review', sort_order: 3, end_date: null, is_completed: false }),
        phaseRow(),
        phaseRow({ name: 'Process Planning', sort_order: 2 })
      ]
    }
  });

  const phases = (await fetchTrackWorks('track-token', get)).phases.get('207');

  assert.deepStrictEqual(phases.map(p => p.name),
    ['Early Engagement', 'Process Planning', 'Application Review']);
  assert.strictEqual(phases[2].endDate, null, 'a phase still running has no end date');
  assert.strictEqual(phases[2].isCompleted, false);
});

test('fetchTrackWorks prefers the live assessment work, then the most recent', async () => {
  const { fetchTrackWorks } = require('../../src/seed/sources');
  const { get, paths } = fakeTrack({
    works: [
      work(11, 207, ASSESSMENT, { is_active: false }),
      work(21, 207, ASSESSMENT, { is_active: true }),
      work(31, 354, ASSESSMENT, { is_active: false }),
      work(41, 354, ASSESSMENT, { is_active: false })
    ],
    phasesByWork: { 21: [phaseRow()], 41: [phaseRow()] }
  });

  await fetchTrackWorks('track-token', get);

  assert.deepStrictEqual(paths.slice(1),
    ['/api/v1/works/21/phases', '/api/v1/works/41/phases'],
    'one call per project: the active work, else the highest work id');
});

test('one work whose phases fail does not cost the other projects theirs', async () => {
  const { fetchTrackWorks } = require('../../src/seed/sources');
  const { get } = fakeTrack({
    works: [work(11, 207, ASSESSMENT), work(13, 354, ASSESSMENT)],
    phasesByWork: { 13: [phaseRow()] },
    fail: (workId) => workId === 11
  });

  const { phases: byProject } = await fetchTrackWorks('track-token', get);

  assert.deepStrictEqual([...byProject.keys()], ['354']);
});

// Events mirror `EventResponseSchema` (fk columns plus nested `event_configuration`). Staff text
// is seeded on purpose, so the key-set test fails if any of it leaks through.
const SUBSTANTIAL_START = 10;
const STARTED = 'Project is Substantially Started';

const event = (id, over = {}, configuration = {}) => ({
  id,
  name: `Milestone ${id}`,
  description: 'staff description',
  notes: 'staff note',
  reason: 'staff reason',
  decision_maker_id: 77,
  anticipated_date: '2024-01-10T00:00:00+00:00',
  actual_date: '2024-01-12T00:00:00+00:00',
  number_of_days: 0,
  outcome_id: null,
  is_active: true,
  event_configuration_id: configuration.id ?? 500,
  event_configuration: {
    id: 500, name: `Milestone ${id}`, event_position: 'INTERMEDIATE', visibility: 'MANDATORY',
    event_type_id: 22, sort_order: id, ...configuration
  },
  ...over
});

const trackWork = (id, projectId, workTypeId, over = {}) => work(id, projectId, workTypeId, {
  title: `Work ${id}`,
  simple_title: 'Simple',
  ea_act: { id: 3, name: '2018 Act' },
  start_date: '2023-02-01T00:00:00+00:00',
  work_state: 'IN_PROGRESS',
  work_decision_date: null,
  anticipated_decision_date: '2025-06-01T00:00:00+00:00',
  status_notes: 'staff status note',
  issue_notes: 'staff issue note',
  epic_description: 'staff description',
  work_lead: { id: 9, first_name: 'Staff', last_name: 'Lead' },
  ...over
});

/** Answers every works-pull route by URL and records the path, like `fakeTrack`. */
function fakeTrackWorks({
  works = [], phasesByWork = {}, eventsByPhase = {}, outcomesByConfiguration = {}, failEvents = () => false
} = {}) {
  const paths = [];
  const get = async (url) => {
    const pathOnly = url.slice(url.indexOf('/api/v1'));
    paths.push(pathOnly);
    if (pathOnly === '/api/v1/works') return works;
    const phases = pathOnly.match(/^\/api\/v1\/works\/(\d+)\/phases$/);
    if (phases) return phasesByWork[phases[1]] || [];
    const events = pathOnly.match(/^\/api\/v1\/milestones\/workphases\/(\d+)\/events$/);
    if (events && failEvents(Number(events[1]))) throw new Error('HTTP 401 Unauthorized');
    if (events) return eventsByPhase[events[1]] || [];
    const outcomes = pathOnly.match(/^\/api\/v1\/outcome-configurations\/\?configuration_id=(\d+)$/);
    if (outcomes) return outcomesByConfiguration[outcomes[1]] || [];
    throw new Error(`unexpected call: ${url}`);
  };
  return { get, paths };
}

const pullWorks = (track, opts = {}) => {
  const { fetchTrackWorks } = require('../../src/seed/sources');
  return fetchTrackWorks('track-token', track.get, { works: true, ...opts });
};

test('a mirrored work carries the contract keys and no staff field', async () => {
  const track = fakeTrackWorks({
    works: [trackWork(11, 207, AMENDMENT)],
    phasesByWork: { 11: [phaseRow({ id: 901 })] },
    eventsByPhase: { 901: [event(1)] }
  });

  const [row] = (await pullWorks(track)).works.get('207');

  assert.deepStrictEqual(Object.keys(row).sort(), [
    'anticipatedDecisionDate', 'decisionDate', 'eaAct', 'isActive', 'milestones', 'outcome', 'phases',
    'startDate', 'title', 'trackWorkId', 'workState', 'workType', 'workTypeId'
  ]);
  assert.deepStrictEqual(Object.keys(row.milestones[0]).sort(), [
    'actualDate', 'anticipatedDate', 'eventType', 'name', 'numberOfDays', 'outcome', 'position'
  ]);
});

test('types 4 and 14 are not mirrored and type 10 is', async () => {
  const track = fakeTrackWorks({
    works: [trackWork(11, 207, 4), trackWork(12, 207, 14), trackWork(13, 207, SUBSTANTIAL_START)]
  });

  const { works } = await pullWorks(track);

  assert.deepStrictEqual(works.get('207').map(w => w.workTypeId), [SUBSTANTIAL_START]);
  assert.deepStrictEqual(track.paths.filter(p => /\/works\/1[12]\//.test(p)), [],
    'an excluded work costs Track no request');
});

test('an event whose configuration is HIDDEN is dropped', async () => {
  const track = fakeTrackWorks({
    works: [trackWork(11, 207, AMENDMENT)],
    phasesByWork: { 11: [phaseRow({ id: 901 })] },
    eventsByPhase: { 901: [event(1, { name: 'Shown' }), event(2, { name: 'Hidden' }, { visibility: 'HIDDEN' })] }
  });

  const [row] = (await pullWorks(track)).works.get('207');

  assert.deepStrictEqual(row.milestones.map(m => m.name), ['Shown']);
});

test('the work outcome is the END milestone with an outcome in the last phase', async () => {
  const track = fakeTrackWorks({
    works: [trackWork(11, 207, SUBSTANTIAL_START)],
    phasesByWork: { 11: [phaseRow({ id: 902, sort_order: 2 }), phaseRow({ id: 901, sort_order: 1 })] },
    eventsByPhase: {
      901: [event(1, {}, { event_position: 'END' })],
      902: [
        event(2, { outcome_id: 31 }, { id: 600, event_position: 'END' }),
        event(3, {}, { event_position: 'END' })
      ]
    },
    outcomesByConfiguration: { 600: [{ id: 30, name: 'Project is Not Substantially Started' }, { id: 31, name: STARTED }] }
  });

  const [row] = (await pullWorks(track)).works.get('207');

  assert.strictEqual(row.outcome, STARTED);
  assert.deepStrictEqual(row.milestones.map(m => m.outcome), [null, STARTED, null]);
});

test('one failed events read leaves that project out and the others intact', async () => {
  const track = fakeTrackWorks({
    works: [trackWork(11, 207, AMENDMENT), trackWork(13, 354, AMENDMENT)],
    phasesByWork: { 11: [phaseRow({ id: 901 })], 13: [phaseRow({ id: 903 })] },
    eventsByPhase: { 903: [event(1)] },
    failEvents: (workPhaseId) => workPhaseId === 901
  });

  const { works, stats } = await pullWorks(track);

  assert.deepStrictEqual([...works.keys()], ['354']);
  assert.strictEqual(stats.failures, 1);
});

test('a project reached after the works budget is left out, so its stored works stay', async () => {
  const track = fakeTrackWorks({
    works: [trackWork(11, 207, AMENDMENT), trackWork(13, 354, AMENDMENT)]
  });
  // Each clock read is six minutes on: the start, 207's check at +6, 354's at +12.
  let clock = 0;
  const now = () => (clock += 6 * 60 * 1000);

  const { works, stats } = await pullWorks(track, { now });

  assert.deepStrictEqual([...works.keys()], ['207']);
  assert.strictEqual(stats.budgetHit, true);
});

test('with the flag on the assessment phases are read once for both passes', async () => {
  const track = fakeTrackWorks({ works: [trackWork(11, 207, ASSESSMENT)], phasesByWork: { 11: [phaseRow()] } });

  const { phases, works } = await pullWorks(track);

  assert.strictEqual(track.paths.filter(p => p === '/api/v1/works/11/phases').length, 1);
  assert.strictEqual(phases.get('207').length, 1);
  assert.strictEqual(works.get('207')[0].phases.length, 1);
});

test('with the flag off only the assessment phases are read and works stays empty', async () => {
  const track = fakeTrackWorks({
    works: [trackWork(11, 207, ASSESSMENT), trackWork(12, 207, AMENDMENT)],
    phasesByWork: { 11: [phaseRow()] }
  });

  const { works } = await pullWorks(track, { works: false });

  assert.deepStrictEqual(track.paths, ['/api/v1/works', '/api/v1/works/11/phases']);
  assert.strictEqual(works.size, 0);
});

/**
 * Rate limiting. eagle-api answers 200 requests a minute, and a comment sweep spends that inside a
 * minute, so what the fetch helper does with a 429 decides whether the sweep finishes. Waits go
 * through the injected `sleep`, so none of these tests costs wall-clock time.
 */
const throttled = (headers = {}) => ({ status: 429, ok: false, headers: new Headers(headers) });
const served = (body) => ({ status: 200, ok: true, headers: new Headers(), json: async () => body });

/** Answers with each response in turn, repeating the last, and records the calls and the waits. */
function fetchSequence(t, responses) {
  const calls = [];
  const waits = [];
  t.mock.method(global, 'fetch', async (url) => {
    calls.push(String(url));
    return responses[Math.min(calls.length - 1, responses.length - 1)];
  });
  return { calls, waits, sleep: async (ms) => { waits.push(ms); } };
}

const COMMENT_URL = 'https://eagle.example/api/public/comment?period=59d&count=true';

test('a 429 carrying retry-after waits that long and then succeeds', async (t) => {
  const { calls, waits, sleep } = fetchSequence(t, [
    throttled({ 'retry-after': '2', 'ratelimit-policy': '200;w=60' }),
    served([{ _id: 'c1' }])
  ]);

  const body = await fetchJson(COMMENT_URL, undefined, { sleep });

  assert.deepStrictEqual(body, [{ _id: 'c1' }], 'the retry is what the caller gets back');
  assert.deepStrictEqual(waits, [2000], "the server's own retry-after, in ms, over the window");
  assert.strictEqual(calls.length, 2, 'the throttled request is re-sent, not abandoned');
});

test('a 429 without retry-after waits the window the rate-limit headers name', async (t) => {
  const { waits, sleep } = fetchSequence(t, [
    throttled({ 'ratelimit-reset': '12', 'ratelimit-policy': '200;w=60' }),
    throttled({ 'ratelimit-policy': '200;w=60' }),
    served([])
  ]);

  await fetchJson(COMMENT_URL, undefined, { sleep });

  assert.deepStrictEqual(waits, [12000, 60000],
    'seconds left in the window first, the window length when that is missing');
});

test('five 429s are waited out on the 5/15/60 ladder and the sixth throws', async (t) => {
  const { calls, waits, sleep } = fetchSequence(t, [throttled()]);

  await assert.rejects(
    fetchJson(COMMENT_URL, undefined, { sleep }),
    /still throttled after 5 waits/,
    'a run that stays throttled fails loudly rather than reporting a short read');

  assert.deepStrictEqual(waits, [5000, 15000, 60000, 60000, 60000],
    'the fallback ladder, because a bare 429 names no window');
  assert.strictEqual(calls.length, 6, 'the first request plus five retries');
});

test('a non-429 failure keeps the three short attempts it always had', async (t) => {
  const { calls, waits, sleep } = fetchSequence(t, [
    { status: 500, ok: false, statusText: 'Server Error', headers: new Headers() }
  ]);

  await assert.rejects(
    fetchJson(COMMENT_URL, undefined, { sleep }),
    /after 3 attempts: HTTP 500 Server Error/);

  assert.deepStrictEqual(waits, [1000, 2000], 'the 1s/2s retry, not the rate-limit ladder');
  assert.strictEqual(calls.length, 3, 'the rate-limit budget is not spent on ordinary failures');
});

test('retry-after wins over ratelimit-reset when a 429 carries both', async (t) => {
  const { waits, sleep } = fetchSequence(t, [
    throttled({ 'retry-after': '2', 'ratelimit-reset': '12', 'ratelimit-policy': '200;w=60' }),
    served([])
  ]);

  await fetchJson(COMMENT_URL, undefined, { sleep });

  assert.deepStrictEqual(waits, [2000],
    "the server's own instruction, not the seconds left in the window");
});

test('a ratelimit-reset of 0 still waits a second rather than retrying at once', async (t) => {
  const { waits, sleep } = fetchSequence(t, [
    throttled({ 'ratelimit-reset': '0', 'ratelimit-policy': '200;w=60' }),
    served([])
  ]);

  await fetchJson(COMMENT_URL, undefined, { sleep });

  assert.deepStrictEqual(waits, [1000], 'the floor, so the retry budget is not spent on nothing');
});

test('a retry-after far past the cap waits the cap and asks again', async (t) => {
  const { waits, sleep } = fetchSequence(t, [
    throttled({ 'retry-after': '999' }),
    served([])
  ]);

  await fetchJson(COMMENT_URL, undefined, { sleep });

  assert.deepStrictEqual(waits, [120000], 'one bad header cannot park a nightly run for an hour');
});
