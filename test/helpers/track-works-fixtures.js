'use strict';

// Project 207 as Track holds it: nested works, the row the nightly stores from them, and their work documents.

const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const phaseCatalog = require('../../src/domain/phase-catalog');
const { mergeTrackProject } = require('../../src/merge/project');
const { trackWorkToPublic, phaseEventsOf, workDocOf } = require('../../src/seed/track-mappers');
const { PROJECT_EAGLE_ID, PUBLIC_ACL } = require('./eagle-mirror-fixtures');

const ACT_2018 = { id: 3, name: '2018 Environmental Assessment Act' };
const TRANSITION = 'Project Transitioning FROM the EA Act (2002)';

const trackPhase = (id, name, sortOrder, dates, events = []) => ({
  id, phase_id: id + 10, name, sort_order: sortOrder, ...dates, events,
  phase: { id: id + 10, name, ea_act_id: ACT_2018.id, ea_act: ACT_2018, work_type: { name: 'Assessment' } }
});

/** Track's nested works for project 207: an active Assessment with a transition milestone, and a closed work. */
const trackWorks = () => [
  {
    id: 31, project_id: 207, work_type_id: 6, work_type: { id: 6, name: 'Assessment' }, simple_title: 'Wind',
    title: 'Nicomen Wind Energy - Assessment - Wind', ea_act: ACT_2018, ea_act_id: ACT_2018.id,
    start_date: '2025-01-10', is_active: true, work_state: 'IN_PROGRESS',
    phases: [
      trackPhase(501, 'Early Engagement', 1, { start_date: '2025-01-10', end_date: '2025-06-01', is_completed: true }, [
        { id: 901, name: TRANSITION, actual_date: '2025-01-10',
          event_configuration: { name: TRANSITION, event_position: 'START', sort_order: 1 } }
      ]),
      trackPhase(502, 'Readiness Decision', 2, { start_date: '2099-06-02', is_completed: false })
    ]
  },
  {
    id: 40, project_id: 207, work_type_id: 5, work_type: { id: 5, name: 'Exemption Order' }, simple_title: 'Road',
    title: 'Nicomen Wind Energy - Exemption Order - Road', ea_act: ACT_2018, ea_act_id: ACT_2018.id,
    start_date: '2020-03-01', is_active: false, work_state: 'COMPLETED', phases: []
  }
];

const eagleDoc = () => ({
  _id: PROJECT_EAGLE_ID, read: [...PUBLIC_ACL],
  currentLegislationYear: 'legislation_2002', legislationYearList: [2002, 2018],
  legislation_2002: { name: 'Nicomen Wind Energy', legislationYear: 2002, legislation: '2002 Environmental Assessment Act' },
  legislation_2018: { name: 'Nicomen Wind Energy', legislationYear: 2018, legislation: '2018 Environmental Assessment Act' }
});

const TRACK = { track_project_id: 207, name: 'Nicomen Wind Energy', epic_guid: PROJECT_EAGLE_ID };

/** The row as the nightly stores it, `works` and `phases` included unless `bare`. */
function storedRow({ bare = false } = {}) {
  const works = trackWorks().map(work => trackWorkToPublic(work, phaseEventsOf(work)));
  const phases = phaseEventsOf(trackWorks()[0]).map(p => p.phase);
  return { ...mergeTrackProject(TRACK, eagleDoc(), bare ? {} : { phases, works }), _etag: '"0x1"' };
}

const workDocs = (works = trackWorks()) => works.map(work => workDocOf(work, { projectId: '207' }));

/** The works container answering each read with the next list in `reads`, the last one kept. */
function worksContainer(t, reads) {
  let read = 0;
  t.mock.method(cosmos, 'query', async (name) => {
    assert.strictEqual(name, 'works');
    return { items: reads[Math.min(read++, reads.length - 1)], continuationToken: undefined };
  });
  t.mock.method(phaseCatalog, 'load', async () => ({}));
}

module.exports = { trackWorks, eagleDoc, storedRow, workDocs, worksContainer };
