'use strict';

// The dry-run lists of a business works plan, sealed in its report, and the count lines stdout carries.

const {
  OVERRIDE_TYPES, TRACK_FROM, compareText, dayOf, daysBetween, hiddenByOverride, overrideBoundaryOf, sameEvent,
  settledBefore, transitionOf, untilTrackHidden, workTypeCodeOf
} = require('../domain/work-model');

const W7_LISTS = ['trackAlive', 'trackCompletedNoDate', 'sameEventChoice', 'afterBoundary', 'sheetWithoutMarker', 'investmentUseTrack'];
const ACTIONS = ['create', 'update', 'tombstone', 'marker', 'addExternalId', 'appendHistory'];

const daysApart = (a, b) => (dayOf(a) && dayOf(b) ? Math.abs(daysBetween(dayOf(a), dayOf(b))) : null);

/** As sameEvent measures it: the nearer of the start and decision days, with no window. */
function gapOf(sheet, track) {
  const gaps = [daysApart(sheet.startDate, track.startDate), daysApart(sheet.decisionDate, track.decisionDate)].filter(gap => gap !== null);
  return gaps.length ? Math.min(...gaps) : null;
}

const trackItem = (projectId, track) => ({
  projectId, workId: track.id, type: workTypeCodeOf(track), startDate: dayOf(track.startDate), decisionDate: dayOf(track.decisionDate)
});

/** `B` and what set it: `2025`, or the Track work overrideBoundaryOf's own test picks on its own. */
function boundaryOf(trackWorks) {
  const day = overrideBoundaryOf(trackWorks);
  const setter = day === TRACK_FROM ? null : trackWorks.find(work => overrideBoundaryOf([work]) === day);
  return { day, source: setter ? setter.id : '2025' };
}

/** The override lists of one marked project. */
function overrideLists(marker, trackWorks, sheetWorks, lists) {
  const { projectId } = marker;
  const boundary = boundaryOf(trackWorks);
  lists.boundaries.push({ projectId, boundary: boundary.day, source: boundary.source });
  const sheetById = new Map(sheetWorks.map(work => [work.id, work]));
  for (const pair of marker.hidden) {
    const track = trackWorks.find(work => work.id === pair.trackWorkId);
    const sheet = sheetById.get(pair.sheetWorkId);
    const gap = (sameEvent(sheet, track) || { gap: gapOf(sheet, track) }).gap;
    lists.trackHidden.push({ ...trackItem(projectId, track), sheetWorkId: pair.sheetWorkId, sourceKey: sheet.sourceKey, gap });
  }
  lists.untilTrack.push(...marker.untilTrack.map(sheetWorkId => ({ projectId, sheetWorkId })));
  const paired = new Set(marker.pairedTrackWorkIds);
  for (const track of trackWorks.filter(work => OVERRIDE_TYPES.includes(workTypeCodeOf(work)))) {
    if (settledBefore(track, boundary.day) && !paired.has(track.id)) {
      const near = sheetWorks.filter(work => workTypeCodeOf(work) === workTypeCodeOf(track))
        .map(work => ({ sheetWorkId: work.id, gap: gapOf(work, track) }))
        .filter(one => one.gap !== null).sort((a, b) => a.gap - b.gap)[0] || null;
      lists.trackShownNoSheetMatch.push({ ...trackItem(projectId, track), nearest: near });
    } else if (dayOf(track.startDate) && dayOf(track.startDate) < boundary.day && !settledBefore(track, boundary.day)) {
      lists.trackShownStartedBefore.push(trackItem(projectId, track));
    }
  }
}

/** Sheet works a read with track and sheet listed would show, by works-derive.js's withOverride rules. */
function shownCount(loaded, markers, trackWorks) {
  const byProject = Map.groupBy(loaded, work => work.projectId);
  let shown = 0;
  for (const [projectId, works] of byProject) {
    const marker = markers.find(one => one.projectId === projectId) || null;
    const track = trackWorks.get(projectId) || [];
    const sheet = [...works].sort((a, b) => compareText(a.id, b.id));
    const replaced = untilTrackHidden(sheet, track, marker);
    shown += sheet.filter(work => !replaced.has(work.id) && !hiddenByOverride(work, marker, overrideBoundaryOf(track), [])).length;
  }
  return shown;
}

/** A sheet work told to take its transition day from Track, where Track has no "Project Transitioning FROM" milestone. */
function transitionsMissing(works, trackPublic) {
  return works.filter(work => work.transitionOut && work.transitionOut.dateSource === 'track')
    .filter(work => transitionOf(work.transitionOut, trackPublic.get(work.projectId) || [], work.actYear).source !== 'track')
    .map(work => ({ projectId: work.projectId, workId: work.id, fallbackDate: dayOf(work.transitionOut.date) }));
}

function listsOf({ loaded, markers, trackWorks, trackPublic, report }) {
  const lists = { trackHidden: [], untilTrack: [], trackShownNoSheetMatch: [], trackShownStartedBefore: [], boundaries: [] };
  for (const marker of markers) {
    overrideLists(marker, trackWorks.get(marker.projectId) || [], loaded.filter(work => work.projectId === marker.projectId), lists);
  }
  W7_LISTS.forEach((reason) => { lists[reason] = report.filter(one => one.reason === reason); });
  lists.trackTransitionMissing = transitionsMissing(loaded, trackPublic);
  lists.sheetShown = shownCount(loaded, markers, trackWorks);
  return lists;
}

/** `name=N` lines for stdout: counts only, never an entry. */
function countLines(plan) {
  const { lists } = plan;
  const count = key => (Array.isArray(lists[key]) ? lists[key].length : lists[key]);
  const actions = Object.groupBy(plan.entries, entry => entry.action);
  return [
    ...ACTIONS.map(action => `${action}=${(actions[action] || []).length}`),
    ...['trackHidden', 'sheetShown', 'trackShownNoSheetMatch', ...W7_LISTS, 'untilTrack', 'trackShownStartedBefore', 'trackTransitionMissing']
      .map(key => `${key}=${count(key)}`),
    `reportEntries=${plan.report.length}`
  ];
}

module.exports = { listsOf, countLines };
