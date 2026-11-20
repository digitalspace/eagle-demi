'use strict';

// The dry-run lists of a business works plan, sealed in its report, and the count lines stdout carries.

const {
  OVERRIDE_TYPES, TRACK_FROM, compareText, dayOf, daysBetween, overrideBoundaryOf, overrideShown, sameEvent, settledBefore, transitionOf,
  workTypeCodeOf
} = require('../domain/work-model');

const W7_LISTS = ['trackAlive', 'trackCompletedNoDate', 'sameEventChoice', 'afterBoundary', 'sheetWithoutMarker', 'investmentUseTrack'];
const ACTIONS = ['create', 'update', 'tombstone', 'marker', 'addExternalId', 'appendHistory', 'closeHistory'];
const SKIP_REASONS = ['trackAlive', 'afterBoundary'];
const REFUSED_REASONS = ['invalid', 'duplicateKey'];

const actKindOf = work => `${work.actYear}.${workTypeCodeOf(work)}`;
/** `{'<act>.<kind>': N}`, keys sorted so the printed lines keep one order. */
const tallyOf = items => Object.fromEntries(Object.entries(Object.groupBy(items, actKindOf))
  .map(([key, group]) => [key, group.length]).sort(([a], [b]) => compareText(a, b)));

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

/** The override lists of one marked project; returns the sheet works its `hidden` pairs name. */
function overrideLists(marker, trackWorks, sheetWorks, lists) {
  const { projectId } = marker;
  const boundary = boundaryOf(trackWorks);
  lists.boundaries.push({ projectId, boundary: boundary.day, source: boundary.source });
  const sheetById = new Map(sheetWorks.map(work => [work.id, work]));
  const hiddenSheets = [];
  for (const pair of marker.hidden) {
    const track = trackWorks.find(work => work.id === pair.trackWorkId);
    const sheet = sheetById.get(pair.sheetWorkId);
    hiddenSheets.push(sheet);
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
  return hiddenSheets;
}

/** Sheet works a read with track and sheet listed would show, under the markers the load keeps. */
function shownWorks(loaded, markers, trackWorks) {
  return [...Map.groupBy(loaded, work => work.projectId)].flatMap(([projectId, works]) => {
    const marker = markers.find(one => one.projectId === projectId) || null;
    const { shownSheetIds } = overrideShown(works, trackWorks.get(projectId) || [], marker);
    return works.filter(work => shownSheetIds.has(work.id));
  });
}

/** A sheet work told to take its transition day from Track, where Track has no "Project Transitioning FROM" milestone. */
function transitionsMissing(works, trackPublic) {
  return works.filter(work => work.transitionOut && work.transitionOut.dateSource === 'track')
    .filter(work => transitionOf(work.transitionOut, trackPublic.get(work.projectId) || [], work.actYear).source !== 'track')
    .map(work => ({ projectId: work.projectId, workId: work.id, fallbackDate: dayOf(work.transitionOut.date) }));
}

function listsOf({ loaded, markers, trackWorks, trackPublic, report }) {
  const lists = { trackHidden: [], untilTrack: [], trackShownNoSheetMatch: [], trackShownStartedBefore: [], boundaries: [] };
  const hidden = markers.filter(one => one.active === true).flatMap(marker => overrideLists(
    marker, trackWorks.get(marker.projectId) || [], loaded.filter(work => work.projectId === marker.projectId), lists
  ));
  W7_LISTS.forEach((reason) => { lists[reason] = report.filter(one => one.reason === reason); });
  lists.trackTransitionMissing = transitionsMissing(loaded, trackPublic);
  const shown = shownWorks(loaded, markers, trackWorks);
  lists.sheetShown = shown.length;
  lists.transitioned = loaded.filter(work => work.workState === 'transitioned').length;
  lists.byActKind = { works: tallyOf(loaded), shown: tallyOf(shown), hidden: tallyOf(hidden) };
  return lists;
}

/** `name=N` lines for stdout: counts only, never an entry. */
function countLines(plan) {
  const { lists } = plan;
  const count = key => (Array.isArray(lists[key]) ? lists[key].length : lists[key]);
  const actions = Object.groupBy(plan.entries, entry => entry.action);
  // A skipped work's children are listed under its sourceKey too; untilTrack works stay loaded.
  const skipped = plan.report.filter(one => SKIP_REASONS.includes(one.reason) && one.sourceKey && !one.child && !one.untilTrack);
  const tallies = { ...lists.byActKind, skipped: tallyOf(skipped) };
  return [
    ...ACTIONS.map(action => `${action}=${(actions[action] || []).length}`),
    ...['trackHidden', 'sheetShown', 'trackShownNoSheetMatch', ...W7_LISTS, 'untilTrack', 'trackShownStartedBefore', 'trackTransitionMissing']
      .map(key => `${key}=${count(key)}`),
    `reportEntries=${plan.report.length}`,
    `refused=${plan.report.filter(one => REFUSED_REASONS.includes(one.reason)).length}`,
    `transitioned=${lists.transitioned}`,
    ...Object.entries(tallies).flatMap(([name, tally]) => Object.entries(tally).map(([key, n]) => `${name}.${key}=${n}`))
  ];
}

module.exports = { listsOf, countLines };
