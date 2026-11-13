'use strict';

// Builds the assessment and post-decision works of one business register project, 1996 and 2002
// Acts only. Pure; business-works-map.js joins the sheets and calls in here.

const { LEGISLATIONS } = require('./project-legislation');
const { entryForName, normalizeName } = require('./phase-catalog');
const { certificateKindOf, entryFor } = require('./works-catalog');
const { TRACK_FROM, childIdOf, dayOf, newWorkId, sourceKeyOf } = require('./work-model');

const UNKNOWN_DAY = LEGISLATIONS[1996].inForce;
const SPLIT_DAY = LEGISLATIONS[2002].inForce;
const LAST_SHEET_DAY = '2024-12-31';
const UNKNOWN_FIELDS = Object.freeze(['intakeDate', 'determinationDate', 'decisionDate']);
const WORK_SCHEMA_VERSION = 1;
const PHASE_START = Object.freeze({
  'Pre-EA': 'intakeDate', 'Pre-Application': 'determinationDate', Evaluation: 'start30',
  'Application Review': 'start180', Referral: 'start45'
});
// [milestone code, register field, phase, position, project block field it stands for]
const MILESTONES = Object.freeze([
  ['intake', 'intakeDate', 'Pre-EA', 'START'], ['determination', 'determinationDate', 'Pre-EA', 'END'],
  ['s11-order', 's11Order', 'Pre-Application', 'INTERIOR'], ['draft-air', 'draftAir', 'Pre-Application', 'INTERIOR'],
  ['air-accepted', 'airAccepted', 'Pre-Application', 'INTERIOR'], ['evaluation-start', 'start30', 'Evaluation', 'START'],
  ['review-start', 'start180', 'Application Review', 'START', 'review180Start'],
  ['referral-start', 'start45', 'Referral', 'START', 'review45Start'], ['decision', 'decisionDate', 'Referral', 'END']
]);
const POST_DECISION_PHASE = Object.freeze({
  amendment: 'Post Decision - Amendment', 'eac-extension': 'Post Decision - Extension',
  'substantial-start': 'Post Decision - Substantial Start'
});
const OUTCOME_STATES = Object.freeze({ withdrawn: 'withdrawn', terminated: 'terminated' });
const OPEN_STATES = Object.freeze(['in-progress', 'suspended']);

const oneLine = (text) => (typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '');
const keyOf = (text) => normalizeName(oneLine(text));
const slugOf = (name) => keyOf(name).replace(/ /g, '-');
const refOf = ({ file, sheet, row, slot }) => ({ file, sheet, row, slot: slot ?? null });
const isLater = (day, than) => Boolean(day) && day > than;

/** `{day, unknown}`; the sheets write the 1996 Act's in-force day in these columns when the date is unknown. */
const datedOf = (row, field) => (UNKNOWN_FIELDS.includes(field) && row[field] === UNKNOWN_DAY
  ? { day: null, unknown: true } : { day: dayOf(row[field]), unknown: false });
const setDay = (item, key, { day, unknown }) => Object.assign(item, { [key]: day },
  unknown ? { undated: { ...item.undated, [key]: { notAfter: UNKNOWN_DAY } } } : {});

function phaseOf(ctx, actYear, name) {
  const entry = entryForName(ctx.phaseCatalog, actYear, name);
  return {
    id: slugOf(name), catalogId: entry ? entry.catalogId ?? null : null, name, sourceName: name,
    startDate: null, endDate: null, isCompleted: false, sortOrder: 0, milestones: [], interruptions: []
  };
}

function milestoneOf(ctx, code, position, when, { n, blockField = null, endDate = null, name } = {}) {
  const entry = entryFor(ctx.catalog, 'milestoneTypes', code);
  return setDay({
    id: childIdOf(code, n), code, name: name || (entry ? entry.name : code), position, endDate,
    links: { commentPeriodId: null, blockField }
  }, 'actualDate', when);
}

/** The Act of a register row and how it was set, by the plan's evidence order; null when nothing tells. */
function actOf(ctx, row) {
  const determination = keyOf(row.determinationType);
  if (['pre eao', 'pre 2002 act'].includes(determination)) return { actYear: 1996, actBasis: 'determination-type' };
  if (/^s 10 1 [abc]\b/.test(determination)) return { actYear: 2002, actBasis: 'determination-type' };
  if (determination === 'ipd accepted') return { actYear: 2018, actBasis: 'determination-type' };
  const intake = entryFor(ctx.catalog, 'intakeTypes', row.intakeType);
  if (intake && intake.acts.length === 1) return { actYear: intake.acts[0], actBasis: 'intake-type' };
  if (certificateKindOf(ctx.catalog, row.decision) === 'PAC') return { actYear: 1996, actBasis: 'decision-type' };
  const day = datedOf(row, 'determinationDate').day || datedOf(row, 'intakeDate').day;
  if (!day) return null;
  const actYear = day < SPLIT_DAY ? 1996 : day < LEGISLATIONS[2018].inForce ? 2002 : 2018;
  return { actYear, actBasis: 'in-force-date' };
}

/** Outcomes first, then work states; a label in neither is `unknown`. */
function decisionOf(ctx, label) {
  if (!oneLine(label)) return {};
  const outcome = entryFor(ctx.catalog, 'outcomes', label);
  if (outcome) {
    const certificateKind = outcome.code === 'certificate-issued' ? certificateKindOf(ctx.catalog, label) : null;
    return { outcomeCode: outcome.code, outcome: outcome.name, certificateKind, workState: OUTCOME_STATES[outcome.code] || 'completed' };
  }
  const state = entryFor(ctx.catalog, 'workStates', label);
  return state ? { workState: state.code } : { unknown: true };
}

function assessmentPhases(ctx, row, actYear) {
  const phases = new Map();
  const phase = (name) => phases.get(name) || phases.set(name, phaseOf(ctx, actYear, name)).get(name);
  for (const [name, field] of Object.entries(PHASE_START)) {
    const when = datedOf(row, field);
    if (when.day || when.unknown) setDay(phase(name), 'startDate', when);
  }
  for (const [code, field, name, position, blockField] of MILESTONES) {
    const when = datedOf(row, field);
    if (when.day || when.unknown) phase(name).milestones.push(milestoneOf(ctx, code, position, when, { blockField }));
  }
  const ordered = Object.keys(PHASE_START).filter(name => phases.has(name)).map(name => phases.get(name));
  ordered.forEach((one, i) => {
    one.sortOrder = i;
    one.endDate = i + 1 < ordered.length ? ordered[i + 1].startDate : datedOf(row, 'decisionDate').day;
    one.isCompleted = Boolean(one.endDate);
  });
  if (keyOf(row.far) === 'yes') ordered.push({ ...phaseOf(ctx, actYear, 'Further Assessment'), sortOrder: ordered.length });
  return ordered;
}

/** Phases starting on or after `day` go `later`; milestones after `lastDay` in kept phases are `dropped`. */
function cutPhases(phases, day, lastDay) {
  const kept = [];
  const later = [];
  let side = kept;
  for (const phase of phases) {
    const start = dayOf(phase.startDate);
    if (start) side = start >= day ? later : kept;
    side.push(phase);
  }
  const dropped = [];
  for (const phase of kept) {
    dropped.push(...phase.milestones.filter(one => isLater(dayOf(one.actualDate), lastDay)));
    phase.milestones = phase.milestones.filter(one => !isLater(dayOf(one.actualDate), lastDay));
    if (isLater(dayOf(phase.endDate), lastDay)) Object.assign(phase, { endDate: null, isCompleted: false });
  }
  return { kept, later, dropped };
}

const milestonesOf = (phases) => phases.flatMap(phase => phase.milestones);

/** Cuts `phases` on `day` and ends the last kept one there with an `act-transition` END; lists kept milestones after `day`. */
function endOnTransition(ctx, phases, day, list) {
  const { kept, later, dropped } = cutPhases(phases, day, day);
  dropped.forEach(one => list('afterTransition', { milestone: one.code }));
  const last = kept.at(-1);
  if (last) {
    const held = milestonesOf(kept).filter(one => one.code === 'act-transition').length;
    Object.assign(last, { endDate: day, isCompleted: true });
    last.milestones.push(milestoneOf(ctx, 'act-transition', 'END', { day }, { n: held ? held + 1 : undefined }));
  }
  return { kept, later };
}

function baseWork(ctx, { projectId, number, kind, slot, type, actYear, actBasis, title, ref }) {
  return {
    id: newWorkId('sheet'), projectId, source: 'sheet', owner: 'sheet', sourceKey: sourceKeyOf(number, kind, slot),
    sourceRef: { sheet: refOf(ref) }, provenance: { batchId: ctx.batchId }, schemaVersion: WORK_SCHEMA_VERSION,
    workTypeCode: type.code, workType: type.name, actYear, actBasis, eaAct: LEGISLATIONS[actYear].label, title,
    startDate: null, decisionDate: null, isActive: true, workState: 'in-progress', outcomeCode: null, outcome: null
  };
}

/** One part per Act the row spans: two when it moved to the 2002 Act on its in-force day, else one. */
function partsOf(ctx, row, act, list) {
  const capped = cutPhases(assessmentPhases(ctx, row, act.actYear), TRACK_FROM, LAST_SHEET_DAY);
  [...capped.dropped, ...milestonesOf(capped.later)].forEach(one => list('afterTrackFrom', { milestone: one.code }));
  const intake = datedOf(row, 'intakeDate');
  const intakeBefore = intake.unknown || (intake.day && intake.day < SPLIT_DAY);
  const splitRule = act.actYear === 1996 && intakeBefore && keyOf(row.determinationType) === 'pre 2002 act' &&
    row.determinationDate === SPLIT_DAY;
  const pac = certificateKindOf(ctx.catalog, row.decision) === 'PAC';
  if (splitRule && !pac) {
    const { kept, later } = endOnTransition(ctx, capped.kept, SPLIT_DAY, list);
    later.forEach(phase => Object.assign(phase, { catalogId: phaseOf(ctx, 2002, phase.name).catalogId }));
    if (later[0]) later[0].milestones.unshift(milestoneOf(ctx, 'act-transition', 'START', { day: SPLIT_DAY }, { n: 1 }));
    return [
      { ...act, phases: kept, start: intake, out: { toActYear: 2002, date: SPLIT_DAY, dateSource: 'sheet' } },
      { actYear: 2002, actBasis: 'transition', phases: later, start: { day: SPLIT_DAY }, in: { fromActYear: 1996, date: SPLIT_DAY } }
    ];
  }
  const decided = datedOf(row, 'decisionDate');
  if (splitRule) list('pac-1996');
  else if (act.actYear === 1996 && intakeBefore && !decided.unknown && !(decided.day && decided.day < SPLIT_DAY)) {
    list('open-across-2002');
    if (row.timeline2002) list('sheet-2002-on-1996-work');
  }
  return [{ ...act, phases: capped.kept, start: intake }];
}

/** Applies a 2002-to-2018 Transition Order to the 2002 part; a dated order before 2025 cuts it. */
function applyTransition(ctx, part, transition, list) {
  const day = dayOf(transition.date);
  if (!day) {
    part.out = { toActYear: 2018, date: null, dateSource: 'none' };
  } else if (day < TRACK_FROM) {
    const { kept, later } = endOnTransition(ctx, part.phases, day, list);
    milestonesOf(later).forEach(one => list('afterTransition', { milestone: one.code }));
    part.phases = kept;
    part.out = { toActYear: 2018, date: day, dateSource: 'sheet' };
  } else {
    part.out = { toActYear: 2018, date: day, dateSource: 'track' };
  }
}

function assessmentWorks(ctx, row, base, act, list) {
  const type = entryFor(ctx.catalog, 'workTypes', 'assessment');
  if (!type) {
    list('unknownWorkType', { code: 'assessment' });
    return [];
  }
  const parts = partsOf(ctx, row, act, list);
  const transition = ctx.transitions.get(row.id);
  const to2018 = parts.find(part => part.actYear === 2002);
  if (transition && to2018) applyTransition(ctx, to2018, transition, list);
  if (transition && !to2018) list('transitionNoWork');
  const decision = decisionOf(ctx, row.decision);
  if (decision.unknown) list('unknownDecision', { field: 'decision' });
  return parts.map((part, i) => {
    const work = baseWork(ctx, { ...base, ...part, kind: 'register', slot: `assessment-${part.actYear}`, type });
    setDay(work, 'startDate', part.start);
    const holds = part.phases.some(phase => phase.milestones.some(one => one.code === 'decision'));
    const undecided = !row.decisionDate && i === parts.length - 1 && !part.out;
    if (holds || undecided) {
      if (holds) setDay(work, 'decisionDate', datedOf(row, 'decisionDate'));
      const { unknown: _unknown, ...fields } = decision;
      const open = !fields.workState || OPEN_STATES.includes(fields.workState);
      Object.assign(work, fields, { isActive: !holds && open });
      if (holds && fields.workState && open) list('decisionLabelIsState', { field: 'decision', code: fields.workState });
      if (holds && open) work.workState = 'completed';
    }
    if (part.out) Object.assign(work, { transitionOut: part.out, workState: 'transitioned', isActive: false });
    if (part.in) work.transitionIn = part.in;
    work.phases = part.phases;
    return work;
  });
}

/** The latest certificate issued before `day`; an unknown decision date counts as before any day. */
function certificateFor(certificates, day) {
  const before = certificates.filter(one => one.unknown || (day && one.day && one.day < day));
  return before.sort((a, b) => String(a.day ?? '').localeCompare(String(b.day ?? ''))).at(-1) || null;
}

function postDecisionWork(ctx, project, spec, list) {
  const startDay = spec.startDay || spec.decisionDay;
  if (isLater(startDay, LAST_SHEET_DAY)) return list('afterTrackFrom');
  const certificate = certificateFor(project.certificates, startDay);
  if (!certificate) return list('no-certificate');
  if (certificate.actYear === 2018) return list('onCertificate2018');
  const type = entryFor(ctx.catalog, 'workTypes', spec.code);
  if (!type) return list('unknownWorkType', { code: spec.code });
  const work = baseWork(ctx, {
    ...project.base, ...spec, type, actYear: certificate.actYear, actBasis: 'certificate',
    title: `${project.base.title} - ${type.name}${spec.kind === 'register' ? '' : ` ${spec.slot}`}`
  });
  const phase = { ...phaseOf(ctx, certificate.actYear, POST_DECISION_PHASE[spec.code]), startDate: startDay || null };
  Object.assign(phase, { endDate: spec.decisionDay || null, isCompleted: Boolean(spec.decisionDay) });
  const state = oneLine(spec.status) ? entryFor(ctx.catalog, 'workStates', spec.status) : null;
  if (oneLine(spec.status) && !state) list('unknownAmendmentStatus', { field: 'status' });
  const workState = state ? state.code : spec.decisionDay ? 'completed' : 'in-progress';
  Object.assign(work, {
    startDate: startDay || null, decisionDate: spec.decisionDay || null, isActive: OPEN_STATES.includes(workState),
    workState, phases: [phase], ...spec.extra
  });
  return project.works.push(work);
}

function registerPostDecision(ctx, project, row, list) {
  const started = dayOf(row.substantialStartDate);
  if (started && !ctx.substantialStart) list('substantialStartUndecided');
  if (started && ctx.substantialStart && ctx.substantialStart(row)) {
    postDecisionWork(ctx, project, { kind: 'register', slot: 'substantial-start', code: 'substantial-start', startDay: started, decisionDay: started, ref: row.ref }, list);
  }
  const extended = dayOf(row.extensionDate);
  if (extended) {
    postDecisionWork(ctx, project, {
      kind: 'register', slot: 'eac-extension', code: 'eac-extension', startDay: extended, decisionDay: extended, ref: row.ref,
      extra: { newExpiryDate: dayOf(row.extensionExpiry) }
    }, list);
  }
}

module.exports = {
  LAST_SHEET_DAY, UNKNOWN_DAY, UNKNOWN_FIELDS,
  actOf, assessmentWorks, datedOf, isLater, keyOf, milestoneOf, oneLine, postDecisionWork, refOf, registerPostDecision
};
