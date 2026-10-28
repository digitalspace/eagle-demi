'use strict';

// One assessment per Act a project was under. Pure; the stage rules follow eagle-public's timeline
// (`assessment-stages.ts`, `use-timeline-model.ts`), so both draw the same phases.

const { LEGISLATIONS, EAGLE_DATE_FLOOR, isRegistryYear, yearOf } = require('../domain/project-legislation');
const { redactForAccess } = require('../vis/redact');

const ASSESSMENT_WORK_TYPE = 6;
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;
const POST_DECISION_ROW = 'Post Decision';
const OFF_RAIL_PHASES = ['Other', 'Termination', 'Withdrawal'];
const COMMENT_PERIOD = 'Public comment period';
const CERTIFICATE_NUMBER = /^[A-Z]\d{2}-\d{2}$/;

/** Each Act's phase rows, in process order. */
const STAGE_SETS = Object.freeze({
  1996: ['Pre-Application', 'Application Review', 'Referral', POST_DECISION_ROW],
  2002: ['Pre-EA', 'Pre-Application', 'Evaluation', 'Application Review', 'Referral', POST_DECISION_ROW],
  2018: ['Early Engagement', 'Readiness Decision', 'Process Planning', 'Application Development and Review',
    'Effects Assessment and Recommendation', 'Referral and Decision', POST_DECISION_ROW]
});

/** Stored phase names that differ from the row they belong to, per Act. */
const ROW_ALIASES = Object.freeze({
  // Eagle stores the 2002 names on 1996 projects.
  1996: { 'Pre-EA': 'Pre-Application', Evaluation: 'Application Review' },
  2018: {
    'EAC Application Review': 'Application Development and Review',
    'Effects Assessment & Recommendation': 'Effects Assessment and Recommendation',
    'Effects Assessment': 'Effects Assessment and Recommendation',
    'EAC Decision': 'Referral and Decision',
    Referral: 'Referral and Decision'
  }
});

/** Folds case, punctuation and `&` against `and`, so names match as Track and Eagle write them. */
const normalizeName = (name) =>
  String(name).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

const isPostDecision = (name) => name.startsWith('Post Decision') || name === 'Complete';
const isOffRail = (name) => OFF_RAIL_PHASES.includes(name);

/** The `year` stage row a stored phase name belongs to, or null. */
function stageRowFor(year, name) {
  const aliases = ROW_ALIASES[year] || {};
  const alias = Object.keys(aliases).find(from => normalizeName(from) === normalizeName(name));
  const rowName = isPostDecision(name) ? POST_DECISION_ROW : alias ? aliases[alias] : name;
  return (STAGE_SETS[year] || []).find(row => normalizeName(row) === normalizeName(rowName)) || null;
}

/** Position in the Act's stage order; a phase no row matches ranks last. */
function stageRank(year, stage) {
  const rows = STAGE_SETS[year] || [];
  const index = stage ? rows.indexOf(stage) : -1;
  return index < 0 ? rows.length : index;
}

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

const inForceOf = (year) => timeOf(LEGISLATIONS[year] && LEGISLATIONS[year].inForce);

/** The latest of `years` (ascending) in force at `time`, else the first. */
function actAt(years, time) {
  const inForce = years.filter(year => (inForceOf(year) ?? Infinity) <= time);
  return inForce.length ? inForce[inForce.length - 1] : years.length ? years[0] : null;
}

/** The Act a label such as "2018 Act" names: the exact label, else the whole year in it. */
function actYearOf(label) {
  if (typeof label !== 'string' || !label) return null;
  const exact = Object.keys(LEGISLATIONS).find(year => LEGISLATIONS[year].label === label);
  if (exact) return Number(exact);
  const year = Number((/\b(19|20)\d{2}\b/.exec(label) || [])[0]);
  return isRegistryYear(year) ? year : null;
}

const ascending = (years) => [...new Set(years)].filter(isRegistryYear).sort((a, b) => a - b);

const rowId = (row) => row.id ?? row._id ?? null;

/** The registry years the row lists, else its current block's year. */
function listedYears(view) {
  const listed = (Array.isArray(view.legislationYearList) ? view.legislationYearList : [])
    .map(Number).filter(isRegistryYear);
  if (listed.length) return ascending(listed);
  const current = Number(String(view.currentLegislationYear || '').replace('legislation_', ''));
  const year = isRegistryYear(current) ? current : yearOf(view);
  return year === null ? [] : [year];
}

const worksOf = (view) =>
  (Array.isArray(view.works) ? view.works : []).filter(work => work && typeof work === 'object');

/** The oldest assessment work's phases, else the row's own `phases`. */
function trackPhasesOf(view) {
  const oldest = worksOf(view)
    .filter(work => work.workTypeId === ASSESSMENT_WORK_TYPE && Array.isArray(work.phases) && work.phases.length)
    .sort((a, b) => (timeOf(a.startDate) ?? 0) - (timeOf(b.startDate) ?? 0))[0];
  const phases = oldest ? oldest.phases : Array.isArray(view.phases) ? view.phases : [];
  return phases.filter(phase => phase && typeof phase.name === 'string' && phase.name);
}

/** The years an assessment can be under, and the Act each Track phase or work belongs to. */
function actContext(view) {
  const listed = listedYears(view);
  const currentYear = listed.length ? listed[listed.length - 1] : null;
  // Track holds only the 2018 Act, so a phase that names none belongs there.
  const trackYear = listed.includes(2018) ? 2018 : currentYear;
  const yearOfTrack = (actName) => actYearOf(actName) ?? trackYear;
  const trackPhases = trackPhasesOf(view);
  const blocks = ascending([...listed, ...trackPhases.map(phase => yearOfTrack(phase.eaActName))]);
  return { currentYear, yearOfTrack, trackPhases, blocks };
}

/** First and last posting; a leading run under a tenth of the dates, over two years early, is dropped. */
function documentSpan(times) {
  const sorted = [...times].sort((a, b) => a - b);
  let from = 0;
  for (let i = 1; i < sorted.length && i <= sorted.length / 10; i++) {
    if (sorted[i] - sorted[i - 1] > 2 * YEAR_MS) from = i;
  }
  const kept = sorted.slice(from);
  return {
    startDate: new Date(kept[0]).toISOString(),
    endDate: kept.length > 1 ? new Date(kept[kept.length - 1]).toISOString() : null,
    documentCount: kept.length
  };
}

/**
 * The stored `documentPhases`: one entry per Act and stage row the documents date, then one per
 * comment period (`commentPeriodId`). Callers pass public documents and periods, and the Act blocks.
 */
function datePhasesFromDocuments(documents, periods, phaseRows, years) {
  const blocks = ascending(years || []);
  const rows = new Map((phaseRows || []).filter(row => row && rowId(row) !== null)
    .map(row => [String(rowId(row)), row]));
  const groups = new Map();

  for (const document of documents || []) {
    const time = timeOf(document && document.datePosted);
    const row = document && rows.get(String(document.projectPhaseId));
    const legislation = row ? Number(row.legislation) : NaN;
    if (time === null || !row || !row.name || !Number.isInteger(legislation) || isOffRail(row.name)) continue;
    // A 1996 block files its phases under the 2002 rows.
    const owners = blocks.filter(year => (LEGISLATIONS[year].phaseRowsYear ?? year) === legislation);
    const year = owners.length ? actAt(owners, time) : isRegistryYear(legislation) ? legislation : null;
    if (year === null || time < (inForceOf(year) ?? -Infinity)) continue;
    const stage = stageRowFor(year, row.name);
    const name = stage || row.name;
    if (name === POST_DECISION_ROW) continue;
    const key = `${year}\u0000${name}`;
    const group = groups.get(key) || { legislationYear: year, stage, name, phaseIds: new Set(), times: [] };
    groups.set(key, group);
    group.phaseIds.add(String(document.projectPhaseId));
    group.times.push(time);
  }

  const phases = [...groups.values()]
    .sort((a, b) => a.legislationYear - b.legislationYear ||
      stageRank(a.legislationYear, a.stage) - stageRank(b.legislationYear, b.stage))
    .map(({ legislationYear, stage, name, phaseIds, times }) =>
      ({ legislationYear, stage, name, phaseIds: [...phaseIds], ...documentSpan(times) }));

  const allYears = ascending([...blocks, ...phases.map(phase => phase.legislationYear)]);
  const milestones = (periods || []).flatMap((period) => {
    const start = timeOf(period && period.dateStarted);
    const year = start === null ? null : actAt(allYears, start);
    if (year === null) return [];
    const end = timeOf(period.dateCompleted);
    return [{
      legislationYear: year,
      commentPeriodId: String(rowId(period)),
      label: period.informationLabel || null,
      startDate: new Date(start).toISOString(),
      endDate: end !== null && end >= start ? new Date(end).toISOString() : null
    }];
  });

  return [...phases, ...milestones];
}

/** A list ref as `{ id, name }`; a bare id takes its name from `lists`, else null. */
function refOf(ref, lists) {
  if (ref === null || ref === undefined || ref === '') return null;
  const id = typeof ref === 'object' ? ref._id ?? ref.id ?? null : String(ref);
  const named = typeof ref === 'object' && typeof ref.name === 'string' && ref.name ? ref.name : null;
  const listed = id === null ? null : (lists || []).find(row => row && String(rowId(row)) === String(id));
  return { id: id === null ? null : String(id), name: named ?? (listed && listed.name) ?? null };
}

const refId = (ref) => (ref && typeof ref === 'object' ? ref._id ?? ref.id : ref);

/** Every phase id the row's blocks and assessments name, non-empty strings, once each. */
function phaseIdsOf(view, assessments) {
  const ids = [];
  for (const block of [view, ...Object.keys(LEGISLATIONS).map(year => view[`legislation_${year}`])]) {
    if (!block || typeof block !== 'object') continue;
    ids.push(refId(block.currentPhaseName));
    if (Array.isArray(block.phaseHistory)) ids.push(...block.phaseHistory.map(refId));
  }
  for (const assessment of assessments) {
    for (const phase of assessment.phases) ids.push(...phase.phaseIds);
  }
  return [...new Set(ids.filter(id => typeof id === 'string' && id))];
}

/** The live work, an assessment first, then the newest; null when none is live. */
function activeWorkOf(view) {
  const [work] = worksOf(view)
    .filter(one => one.isActive === true)
    .sort((a, b) => (b.workTypeId === ASSESSMENT_WORK_TYPE) - (a.workTypeId === ASSESSMENT_WORK_TYPE) ||
      (Number(b.trackWorkId) || 0) - (Number(a.trackWorkId) || 0));
  if (!work) return null;
  const open = (Array.isArray(work.phases) ? work.phases : []).find(phase => phase && phase.isCompleted !== true);
  return {
    trackWorkId: work.trackWorkId ?? null,
    eaAct: work.eaAct ?? null,
    workType: work.workType ?? null,
    currentPhase: (open && open.name) || null
  };
}

const BLOCK_MILESTONES = [
  ['Decision date', 'decisionDate'],
  ['180-day review starts', 'review180Start'],
  ['45-day decision period starts', 'review45Start']
];

/**
 * `assessments`, `phaseIds` and `activeWork` from the anonymous view, so a dial removes what it fed.
 * `documentPhases` comes off the raw row: the view drops it, and the pass built it from public rows.
 */
function deriveAssessments(row, { lists } = {}) {
  const view = redactForAccess('projects', row || {}, null);
  const stored = Array.isArray(row && row.documentPhases) ? row.documentPhases : [];
  const { currentYear, yearOfTrack, trackPhases, blocks } = actContext(view);
  const years = ascending([...blocks, ...stored.map(entry => Number(entry.legislationYear))]);
  const transitions = Array.isArray(view.legislationTransitions) ? view.legislationTransitions : [];
  const works = worksOf(view);

  const assessments = years.map((year) => {
    const block = view[`legislation_${year}`] || (year === currentYear ? view : {});
    const track = trackPhases.filter(phase => yearOfTrack(phase.eaActName) === year).map((phase) => {
      const stage = stageRowFor(year, phase.name);
      return { phaseIds: [], stage, stageRank: stageRank(year, stage), name: phase.name,
        startDate: phase.startDate ?? null, endDate: phase.endDate ?? null, source: 'track' };
    });
    const trackStages = new Set(track.map(phase => phase.stage).filter(Boolean));
    const own = stored.filter(entry => Number(entry.legislationYear) === year);
    const documents = own
      .filter(entry => entry.commentPeriodId === undefined && !(entry.stage && trackStages.has(entry.stage)))
      .map(entry => ({ phaseIds: [...(entry.phaseIds || [])], stage: entry.stage ?? null,
        stageRank: stageRank(year, entry.stage), name: entry.name, startDate: entry.startDate,
        endDate: entry.endDate ?? null, source: 'documents', documentCount: entry.documentCount }));

    const milestones = [
      ...BLOCK_MILESTONES.flatMap(([name, field]) => {
        const date = isoOf(block[field]);
        return date ? [{ name, date }] : [];
      }),
      ...own.filter(entry => entry.commentPeriodId !== undefined).map(entry => ({
        name: COMMENT_PERIOD, date: entry.startDate, endDate: entry.endDate ?? null,
        commentPeriodId: entry.commentPeriodId, label: entry.label ?? null
      }))
    ].sort((a, b) => timeOf(a.date) - timeOf(b.date));

    const transition = transitions.find(one => one && Number(one.fromYear) === year);
    return {
      legislationYear: year,
      act: LEGISLATIONS[year].label,
      // Stable sort, Track listed first, so Track wins a tie in rank.
      phases: [...track, ...documents].sort((a, b) => a.stageRank - b.stageRank),
      milestones,
      currentPhase: refOf(block.currentPhaseName, lists),
      decision: refOf(block.eacDecision, lists),
      decisionDate: isoOf(block.decisionDate),
      certificate: null,
      trackWorkIds: works.filter(work => yearOfTrack(work.eaAct) === year)
        .map(work => work.trackWorkId).filter(Number.isFinite),
      transitionDate: (transition && transition.date) || null
    };
  });

  if (typeof view.eaCertificate === 'string' && CERTIFICATE_NUMBER.test(view.eaCertificate)) {
    const issued = assessments.filter(one => one.decision && one.decision.name === 'Certificate Issued');
    const holder = issued[issued.length - 1] || assessments.find(one => one.legislationYear === currentYear);
    if (holder) {
      holder.certificate = { number: view.eaCertificate, signedDate: isoOf(view.eacSigned),
        expiresDate: isoOf(view.eacExpires) };
    }
  }

  return { assessments, phaseIds: phaseIdsOf(view, assessments), activeWork: activeWorkOf(view) };
}

/** The Act blocks `datePhasesFromDocuments` files documents under, from the row's anonymous view. */
const actBlocks = (row) => actContext(redactForAccess('projects', row || {}, null)).blocks;

module.exports = { ASSESSMENT_WORK_TYPE, STAGE_SETS, stageRowFor, actBlocks, datePhasesFromDocuments, deriveAssessments };
