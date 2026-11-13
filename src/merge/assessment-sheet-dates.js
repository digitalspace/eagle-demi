'use strict';

// Dates on one Act's block: Eagle's own, and on a 1996 or 2002 block the sheet's, which win over Eagle's.
// Pure; assessments.js builds the blocks.

const { EAGLE_DATE_FLOOR } = require('../domain/project-legislation');
const { TRACK_ACT_YEAR, isTrackWork } = require('./assessment-work');

const COMMENT_PERIOD = 'Public comment period';
const BLOCK_MILESTONES = [
  ['Decision date', 'decisionDate'],
  ['180-day review starts', 'review180Start'],
  ['45-day decision period starts', 'review45Start']
];
const FROM_SHEET = Object.freeze({ dateSource: 'sheet' });

/** A date's time in ms, or null for none: Eagle writes a cleared date as the epoch. */
function timeOf(value) {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) || time < EAGLE_DATE_FLOOR ? null : time;
}

const isoOf = (value) => {
  const time = timeOf(value);
  return time === null ? null : new Date(time).toISOString();
};

/** The sheet's own start and end, an end before the start dropped; null when the sheet start is unknown. */
function sheetSpan(startDate, endDate) {
  const start = timeOf(startDate);
  if (start === null) return null;
  const end = timeOf(endDate);
  return { startDate, endDate: end !== null && end >= start ? endDate : null };
}

/**
 * The block's dated phases from documents and `{entry, work}` work phases; Eagle wins a tie, and a work phase
 * on a stage documents date is dropped. A sheet phase there with a known start lends its start and end.
 */
function datedPhases(year, documents, phases) {
  const sheet = year < TRACK_ACT_YEAR
    ? phases.filter(({ work }) => work && !isTrackWork(work)).map(({ entry }) => entry) : [];
  const lent = documents.map((phase) => {
    const known = phase.stage ? sheet.filter(one => one.stage === phase.stage && timeOf(one.startDate) !== null) : [];
    const span = known.length ? sheetSpan(known[0].startDate, known[known.length - 1].endDate) : null;
    return span ? { ...phase, ...span, ...FROM_SHEET } : phase;
  });
  const documentStages = new Set(documents.map(phase => phase.stage).filter(Boolean));
  const entries = phases.map(({ entry }) => entry);
  return [...lent, ...entries.filter(phase => !(phase.stage && documentStages.has(phase.stage)))];
}

/**
 * Eagle's block and comment period milestones, then the sheet's other dated ones. A sheet milestone whose
 * `links` name an Eagle one lends it its dates; the sheet decision gives way to Eagle's decision date.
 */
function milestonesOf(block, own, sheetMilestones) {
  const used = new Set();
  const lend = (key, value) => {
    const linked = sheetMilestones.filter(m => m.links && m.links[key] === value);
    linked.forEach(m => used.add(m));
    return linked.find(m => timeOf(m.actualDate) !== null) ?? null;
  };
  const eagle = BLOCK_MILESTONES.flatMap(([name, field]) => {
    const sheet = lend('blockField', field);
    const date = sheet ? sheet.actualDate : isoOf(block[field]);
    return date ? [{ name, date, ...(sheet ? FROM_SHEET : {}) }] : [];
  });
  const periods = own.filter(entry => entry.commentPeriodId !== undefined).map((entry) => {
    const sheet = lend('commentPeriodId', entry.commentPeriodId);
    const span = sheet ? sheetSpan(sheet.actualDate, sheet.endDate) : { startDate: entry.startDate, endDate: entry.endDate ?? null };
    return { name: COMMENT_PERIOD, date: span.startDate, endDate: span.endDate, commentPeriodId: entry.commentPeriodId,
      label: entry.label ?? null, ...(sheet ? FROM_SHEET : {}) };
  });
  const decided = isoOf(block.decisionDate) !== null;
  const added = sheetMilestones.filter(m => !used.has(m) && !(decided && m.code === 'decision'))
    .map(m => ({ name: m.name, span: sheetSpan(m.actualDate, m.endDate) })).filter(({ span }) => span)
    .map(({ name, span }) => ({ name, date: span.startDate, endDate: span.endDate, ...FROM_SHEET }));
  return [...eagle, ...periods, ...added].sort((a, b) => timeOf(a.date) - timeOf(b.date));
}

module.exports = { datedPhases, isoOf, milestonesOf, timeOf };
