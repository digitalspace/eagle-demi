'use strict';

// Places the child rows of the business works sheets (interruptions, Section 13 variations, comment periods)
// on the works business-works-map.js built. Pure.

const { appliedToPhaseOf, entryFor, skips2018 } = require('./works-catalog');
const { childIdOf, dayOf, daysBetween, workRangeOf } = require('./work-model');
const { LAST_SHEET_DAY, isLater, milestoneOf, refOf } = require('./business-works-assessment');
const { commentPeriodIdFor, eagleItemIdFor } = require('./business-works-compare');

const isAssessment = (work) => work.workTypeCode === 'assessment';
const startOf = (work) => workRangeOf(work).start ?? '';

/** The latest-starting work whose range holds `day`. */
function holderOf(works, day) {
  const holds = works.filter((work) => {
    const { start, end } = workRangeOf(work);
    return (!start || start <= day) && (!end || day <= end);
  });
  return holds.sort((a, b) => startOf(a).localeCompare(startOf(b))).at(-1) || null;
}

/** The phases holding `day`; a phase with no start date starts at the latest date before it. */
function phasesHolding(work, day) {
  let floor = null;
  const found = [];
  for (const phase of work.phases) {
    const start = dayOf(phase.startDate) || floor;
    const end = dayOf(phase.endDate);
    if (!isLater(start, day) && !(end && end < day)) found.push(phase);
    floor = [floor, start, end].filter(Boolean).sort().at(-1) || null;
  }
  return found;
}

const phaseHolding = (work, day) => phasesHolding(work, day).at(-1) || work.phases.at(-1) || null;

/** The `named` phase when it holds `day`, else the phase holding `day`, listed `placedByDate`; null when the work has no phases. */
function placedPhase(work, named, day, list) {
  if (named && phasesHolding(work, day).includes(named)) return named;
  const phase = phaseHolding(work, day);
  if (phase) list('placedByDate', { sourceKey: work.sourceKey, phase: phase.name, ...(named && { named: named.name }) });
  else list('noPhase', { sourceKey: work.sourceKey });
  return phase;
}

const nextN = (work, code) => work.phases.flatMap(phase => [...phase.milestones, ...phase.interruptions])
  .filter(child => child.id.startsWith(`${code}:`)).length + 1;

/** `{start, end}` of a dated child row before 2025, else null with the reason listed. */
function childDays(row, [startKey, endKey], list) {
  const start = dayOf(row[startKey]);
  const end = endKey ? dayOf(row[endKey]) : null;
  if (!start) list('noDate');
  else if (isLater(start, LAST_SHEET_DAY)) list('afterTrackFrom');
  else if (end && end < start) list('endBeforeStart');
  else return { start, end };
  return null;
}

function attachInterruption(ctx, { project, list, noWork }, row, tabKind) {
  if (skips2018(ctx.catalog, 'appliedTo', row.appliedTo)) return list('act2018');
  const days = childDays(row, ['startDate', 'endDate'], list);
  const type = days && entryFor(ctx.catalog, 'interruptionTypes', row.type);
  if (days && !type) list('unknownInterruptionType');
  const work = type && holderOf(project.works.filter(isAssessment), days.start);
  if (type && !work) list(noWork);
  const catalogId = work && appliedToPhaseOf(ctx.catalog, row.appliedTo, work.actYear);
  const phase = work && placedPhase(work, catalogId && work.phases.find(one => one.catalogId === catalogId), days.start, list);
  if (!phase) return undefined;
  const interruption = {
    id: childIdOf(type.code, nextN(work, type.code)), kind: type.kind || tabKind, typeCode: type.code,
    legalSection: type.legalSection ?? null, startDate: days.start, endDate: days.end,
    days: days.end ? Math.max(0, daysBetween(days.start, days.end)) : null, links: { eagleItemId: null },
    sourceRef: { sheet: refOf(row.ref) }
  };
  interruption.links.eagleItemId = eagleItemIdFor(ctx.eagleItems.get(project.projectId), interruption, list);
  return phase.interruptions.push(interruption);
}

function attachVariation(ctx, { project, list, noWork }, row) {
  const days = childDays(row, ['date'], list);
  const work = days && holderOf(project.works.filter(isAssessment), days.start);
  if (days && !work) list(noWork);
  const phase = work && placedPhase(work, work.phases.find(one => one.name === 'Pre-Application'), days.start, list);
  if (!phase) return undefined;
  const n = nextN(work, 'order-variation');
  return phase.milestones.push({ ...milestoneOf(ctx, 'order-variation', 'INTERIOR', { day: days.start }, { n }), sourceRef: { sheet: refOf(row.ref) } });
}

function attachCommentPeriod(ctx, { project, list, noWork }, row) {
  if (skips2018(ctx.catalog, 'commentPeriodTypes', row.type)) return list('act2018');
  const days = childDays(row, ['startDate', 'endDate'], list);
  const type = days && entryFor(ctx.catalog, 'commentPeriodTypes', row.type);
  if (days && !type) list('unknownCommentPeriodType');
  const work = type && holderOf(project.works, days.start);
  if (type && !work) list(noWork);
  const phase = work && phaseHolding(work, days.start);
  if (work && !phase) list('noPhase', { sourceKey: work.sourceKey });
  if (!phase) return undefined;
  const options = { n: nextN(work, 'comment-period'), endDate: days.end, name: type.name };
  const milestone = { ...milestoneOf(ctx, 'comment-period', 'INTERIOR', { day: days.start }, options), sourceRef: { sheet: refOf(row.ref) } };
  milestone.links.commentPeriodId = commentPeriodIdFor(ctx.eagleItems.get(project.projectId), days.start, list);
  return phase.milestones.push(milestone);
}

module.exports = { attachCommentPeriod, attachInterruption, attachVariation, isAssessment };
