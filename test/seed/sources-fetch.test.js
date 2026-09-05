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

test('fetchTrackWorkPhases reads one work list then one phase call per assessment work', async () => {
  const { fetchTrackWorkPhases } = require('../../src/seed/sources');
  const { get, paths } = fakeTrack({
    works: [work(11, 207, ASSESSMENT), work(12, 207, AMENDMENT), work(13, 354, ASSESSMENT)],
    phasesByWork: { 11: [phaseRow()], 13: [phaseRow()] }
  });

  const byProject = await fetchTrackWorkPhases('track-token', get);

  assert.deepStrictEqual(paths,
    ['/api/v1/works', '/api/v1/works/11/phases', '/api/v1/works/13/phases'],
    'the work list is read once and the amendment work is never asked about');
  assert.deepStrictEqual([...byProject.keys()], ['207', '354'], 'keyed by TRACK project id');
});

test('fetchTrackWorkPhases maps a phase to the public shape, dates as ISO', async () => {
  const { fetchTrackWorkPhases } = require('../../src/seed/sources');
  const { get } = fakeTrack({
    works: [work(11, 207, ASSESSMENT)],
    phasesByWork: { 11: [phaseRow()] }
  });

  const [phase] = (await fetchTrackWorkPhases('track-token', get)).get('207');

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

test('fetchTrackWorkPhases sorts by sort order and keeps an unfinished phase open', async () => {
  const { fetchTrackWorkPhases } = require('../../src/seed/sources');
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

  const phases = (await fetchTrackWorkPhases('track-token', get)).get('207');

  assert.deepStrictEqual(phases.map(p => p.name),
    ['Early Engagement', 'Process Planning', 'Application Review']);
  assert.strictEqual(phases[2].endDate, null, 'a phase still running has no end date');
  assert.strictEqual(phases[2].isCompleted, false);
});

test('fetchTrackWorkPhases prefers the live assessment work, then the most recent', async () => {
  const { fetchTrackWorkPhases } = require('../../src/seed/sources');
  const { get, paths } = fakeTrack({
    works: [
      work(11, 207, ASSESSMENT, { is_active: false }),
      work(21, 207, ASSESSMENT, { is_active: true }),
      work(31, 354, ASSESSMENT, { is_active: false }),
      work(41, 354, ASSESSMENT, { is_active: false })
    ],
    phasesByWork: { 21: [phaseRow()], 41: [phaseRow()] }
  });

  await fetchTrackWorkPhases('track-token', get);

  assert.deepStrictEqual(paths.slice(1),
    ['/api/v1/works/21/phases', '/api/v1/works/41/phases'],
    'one call per project: the active work, else the highest work id');
});

test('one work whose phases fail does not cost the other projects theirs', async () => {
  const { fetchTrackWorkPhases } = require('../../src/seed/sources');
  const { get } = fakeTrack({
    works: [work(11, 207, ASSESSMENT), work(13, 354, ASSESSMENT)],
    phasesByWork: { 13: [phaseRow()] },
    fail: (workId) => workId === 11
  });

  const byProject = await fetchTrackWorkPhases('track-token', get);

  assert.deepStrictEqual([...byProject.keys()], ['354']);
});

test('loadTrackWorkPhases yields an empty map with no reader client, and never throws', async () => {
  const { loadTrackWorkPhases } = require('../../src/seed/sources');
  const byProject = await loadTrackWorkPhases();

  assert.ok(byProject instanceof Map);
  assert.strictEqual(byProject.size, 0, 'the checked-in export carries no phases');
});
