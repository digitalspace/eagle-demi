'use strict';

// One assessment per Act a project was under. Pure; the stage rules follow eagle-public's timeline
// (`assessment-stages.ts`, `use-timeline-model.ts`), so both draw the same phases.

const { LEGISLATIONS, EAGLE_DATE_FLOOR, isRegistryYear, yearOf } = require('../domain/project-legislation');
const {
  normalizeName, phaseIdOf, phaseHistoryIds, entryForTrackCode, entryForEagleId, entryForName
} = require('../domain/phase-catalog');
const { redactForAccess } = require('../vis/redact');
const { TRACK_ACT_YEAR, actYearOf } = require('./assessment-work');
const { worksOf, trackPhasesOf, activeWorkOf } = require('./track-derived');
/** Built from other fields by `deriveAssessments` and the dating pass; no caller writes them. */
const DERIVED_FIELDS = Object.freeze(['documentPhases', 'assessments', 'phaseIds', 'activeWork']);
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

/** The latest of `years` (ascending) the project was under at `time` (`startOf` each), else the first. */
function actAt(years, time, startOf) {
  const begun = years.filter(year => (startOf(year) ?? Infinity) <= time);
  return begun.length ? begun[begun.length - 1] : years.length ? years[0] : null;
}

const ascending = (years) => [...new Set(years)].filter(isRegistryYear).sort((a, b) => a - b);

const rowId = (row) => row.id ?? row._id ?? null;

const transitionsOf = (view) =>
  (Array.isArray(view.legislationTransitions) ? view.legislationTransitions : []).filter(Boolean);

/** The registry years the row lists, else its current block's year. */
function listedYears(view) {
  const listed = (Array.isArray(view.legislationYearList) ? view.legislationYearList : [])
    .map(Number).filter(isRegistryYear);
  if (listed.length) return ascending(listed);
  const current = Number(String(view.currentLegislationYear || '').replace('legislation_', ''));
  const year = isRegistryYear(current) ? current : yearOf(view);
  return year === null ? [] : [year];
}

/** The years an assessment can be under, and the Act each Track phase or work belongs to. */
function actContext(view) {
  const listed = listedYears(view);
  const currentYear = listed.length ? listed[listed.length - 1] : null;
  // A phase that names no Act belongs to the Track Act, else to the current block the row has.
  const trackYear = listed.includes(TRACK_ACT_YEAR) ? TRACK_ACT_YEAR : currentYear;
  const yearOfTrack = (actName) => actYearOf(actName) ?? trackYear;
  const trackPhases = trackPhasesOf(view, yearOfTrack);
  const blocks = ascending([...listed, ...trackPhases.map(one => one.year)]);
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
 * comment period (`commentPeriodId`). Callers pass public documents and periods, and `actBlocks`.
 */
function datePhasesFromDocuments(documents, periods, phaseRows, acts) {
  const blocks = ascending((acts || []).map(act => Number(act && act.year)));
  const transitions = new Map((acts || []).filter(act => act && timeOf(act.start) !== null)
    .map(act => [Number(act.year), timeOf(act.start)]));
  // A transition dated before its Act was in force is bad data; the Act still begins no earlier.
  const startOf = (year) => transitions.has(year)
    ? Math.max(transitions.get(year), inForceOf(year) ?? -Infinity)
    : inForceOf(year);
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
    const year = owners.length ? actAt(owners, time, startOf) : isRegistryYear(legislation) ? legislation : null;
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
    const year = start === null ? null : actAt(allYears, start, startOf);
    if (year === null || start < (inForceOf(year) ?? -Infinity)) return [];
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

/** A list ref as `{ id, name }`; a bare id takes its name from `lists`, else from `kept` of the same id. */
function refOf(ref, lists, kept) {
  if (ref === null || ref === undefined || ref === '') return null;
  const id = phaseIdOf(ref);
  const named = typeof ref === 'object' && typeof ref.name === 'string' && ref.name ? ref.name : null;
  const listed = id === null ? null : (lists || []).find(row => row && String(rowId(row)) === id);
  const known = kept && id !== null && kept.id === id && typeof kept.name === 'string' ? kept.name : null;
  return { id, name: named ?? (listed && listed.name) ?? known };
}

/** Every phase id the row's blocks and assessments name, non-empty strings, once each. */
function phaseIdsOf(view, assessments) {
  const ids = [];
  for (const block of [view, ...Object.keys(LEGISLATIONS).map(year => view[`legislation_${year}`])]) {
    if (!block || typeof block !== 'object') continue;
    ids.push(phaseIdOf(block.currentPhaseName), ...phaseHistoryIds(block.phaseHistory));
  }
  for (const assessment of assessments) {
    for (const phase of assessment.phases) ids.push(...phase.phaseIds);
  }
  return [...new Set(ids.filter(id => typeof id === 'string' && id))];
}

/** One Act's stored documents phases. */
const documentEntries = (year, own) => own.filter(entry => entry.commentPeriodId === undefined)
  .map(entry => ({ phaseIds: [...(entry.phaseIds || [])], stage: entry.stage ?? null,
    stageRank: stageRank(year, entry.stage), name: entry.name, startDate: entry.startDate,
    endDate: entry.endDate ?? null, source: 'documents', documentCount: entry.documentCount }));

const trackEntry = (year, phase, stage) => ({ phaseIds: [], stage, stageRank: stageRank(year, stage),
  name: phase.name, startDate: phase.startDate ?? null, endDate: phase.endDate ?? null, source: 'track' });

/** Documents listed first, so Eagle wins a tie; a Track phase on a stage documents date is dropped. */
function datedPhases(documents, track) {
  const documentStages = new Set(documents.map(phase => phase.stage).filter(Boolean));
  return [...documents, ...track.filter(phase => !(phase.stage && documentStages.has(phase.stage)))];
}

const finiteOr = (value, fallback) => (Number.isFinite(value) ? value : fallback);

/** Stage rank, then catalog order, then start date; NaN from two missing values ties. */
const bySequence = (a, b) => a.stageRank - b.stageRank || finiteOr(a.order, Infinity) - finiteOr(b.order, Infinity) ||
  (timeOf(a.startDate) ?? Infinity) - (timeOf(b.startDate) ?? Infinity) || 0;

const catalogDocument = (catalog, year, phase) => {
  const entry = entryForName(catalog, year, phase.name) ||
    phase.phaseIds.map(id => entryForEagleId(catalog, year, id)).find(Boolean);
  return { ...phase, catalogId: entry ? entry.catalogId : null, name: entry ? entry.name : phase.name,
    order: entry ? entry.order ?? null : null, trackWorkId: null };
};

/** A Track phase by its Track code, then its name; one the catalog lacks keeps Track's name and sort order. */
function catalogTrack(catalog, year, { phase, work }) {
  const entry = entryForTrackCode(catalog, year, phase.phaseCodeId) || entryForName(catalog, year, phase.name);
  const code = phase.phaseCodeId ?? null;
  return { ...trackEntry(year, phase, entry ? entry.stage ?? null : null),
    catalogId: entry ? entry.catalogId : code === null ? null : `track-${code}`,
    name: entry ? entry.name : phase.name,
    order: entry ? entry.order ?? null : phase.sortOrder ?? null,
    trackWorkId: work ? work.trackWorkId ?? null : null };
}

/** One undated entry per `phaseHistory` id, less those whose stage, else catalog id, a dated phase holds. */
function eagleEntries(catalog, year, block, lists, dated) {
  return [...new Set(phaseHistoryIds(block.phaseHistory))].flatMap((id) => {
    const entry = entryForEagleId(catalog, year, id);
    const stage = entry ? entry.stage ?? null : null;
    const catalogId = entry ? entry.catalogId : id;
    if (dated.some(phase => (stage ? phase.stage === stage : phase.catalogId === catalogId))) return [];
    return [{ phaseIds: [id], catalogId, stage, stageRank: stageRank(year, stage),
      order: entry ? entry.order ?? null : null, name: entry ? entry.name : refOf(id, lists).name,
      startDate: null, endDate: null, source: 'eagle', trackWorkId: null }];
  });
}

/**
 * `current` is the phase the block's current phase names, by id, else by name, else the first open Track
 * phase; before it is `done`, after it `planned`. With none, the current phase's catalog place splits them.
 */
function markStatus(phases, { catalog, year, currentPhase, completed }) {
  const id = currentPhase ? currentPhase.id : null;
  const entry = entryForEagleId(catalog, year, id) || entryForName(catalog, year, currentPhase && currentPhase.name);
  let at = phases.findIndex(phase => (entry && phase.catalogId === entry.catalogId) || phase.phaseIds.includes(id));
  if (at < 0) at = phases.findIndex(phase => phase.source === 'track' && !completed.has(phase));
  const place = entry && { stageRank: stageRank(year, entry.stage ?? null), order: entry.order, startDate: null };
  const split = at >= 0 ? at : place ? phases.filter(phase => bySequence(phase, place) <= 0).length : 0;
  phases.forEach((phase, index) => {
    if (index === at) phase.status = 'current';
    else if (phase.source === 'eagle') phase.status = 'undated';
    else phase.status = completed.has(phase) || index < split ? 'done' : 'planned';
  });
  return phases;
}

/** One Act's phase sequence: catalog names, Eagle's history beside the dated phases, and a status each. */
function sequenceOf(year, { own, track, block, catalog, lists, currentPhase }) {
  const completed = new Set();
  const trackPhases = track.map((one) => {
    const phase = catalogTrack(catalog, year, one);
    if (one.phase.isCompleted === true) completed.add(phase);
    return phase;
  });
  const dated = datedPhases(documentEntries(year, own).map(phase => catalogDocument(catalog, year, phase)), trackPhases);
  const phases = [...dated, ...eagleEntries(catalog, year, block, lists, dated)].sort(bySequence);
  return markStatus(phases, { catalog, year, currentPhase, completed });
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
function deriveAssessments(row, { lists, previous, worksForDerive, catalog } = {}) {
  const source = row || {};
  const view = redactForAccess('projects', { ...source, works: worksForDerive ?? source.works }, null);
  const stored = Array.isArray(row && row.documentPhases) ? row.documentPhases : [];
  const { currentYear, yearOfTrack, trackPhases, blocks } = actContext(view);
  const trackOf = (year) => trackPhases.filter(one => one.year === year);
  const years = ascending([...blocks, ...stored.map(entry => Number(entry.legislationYear))]);
  const transitions = transitionsOf(view);
  const kept = lists ? [] : (Array.isArray(previous) ? previous : []).filter(Boolean);
  const works = worksOf(view);

  const assessments = years.map((year) => {
    const block = view[`legislation_${year}`] || (year === currentYear ? view : {});
    const own = stored.filter(entry => Number(entry.legislationYear) === year);
    const before = kept.find(one => Number(one.legislationYear) === year) || {};
    const currentPhase = refOf(block.currentPhaseName, lists, before.currentPhase);
    const phases = catalog
      ? sequenceOf(year, { own, track: trackOf(year), block, catalog, lists, currentPhase })
      : datedPhases(documentEntries(year, own),
        trackOf(year).map(({ phase }) => trackEntry(year, phase, stageRowFor(year, phase.name))))
        .sort((a, b) => a.stageRank - b.stageRank);

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

    const transition = transitions.find(one => Number(one.fromYear) === year);
    return {
      legislationYear: year,
      act: LEGISLATIONS[year].label,
      phases,
      milestones,
      currentPhase,
      decision: refOf(block.eacDecision, lists, before.decision),
      decisionDate: isoOf(block.decisionDate),
      certificate: null,
      trackWorkIds: works.filter(work => yearOfTrack(work.eaAct) === year)
        .map(work => work.trackWorkId).filter(Number.isFinite),
      transitionDate: (transition && transition.date) || null
    };
  });

  if (typeof view.eaCertificate === 'string' && CERTIFICATE_NUMBER.test(view.eaCertificate)) {
    const issued = assessments.filter(one => one.decision && one.decision.name === 'Certificate Issued');
    // A decision known only by id may be the issuing one; its block is a better guess than the current Act.
    const unnamed = assessments.filter(one => one.decision && one.decision.id && one.decision.name === null);
    const holder = issued[issued.length - 1] || unnamed[unnamed.length - 1] ||
      assessments.find(one => one.legislationYear === currentYear);
    if (holder) {
      holder.certificate = { number: view.eaCertificate, signedDate: isoOf(view.eacSigned),
        expiresDate: isoOf(view.eacExpires) };
    }
  }

  const current = assessments.find(one => one.legislationYear === currentYear);
  return { assessments, phaseIds: phaseIdsOf(view, assessments), activeWork: activeWorkOf(view, current) };
}

/**
 * The Act blocks `datePhasesFromDocuments` files documents under, from the row's anonymous view, each
 * as `{ year, start }`: `start` is the date of the transition into it, else null for the in-force date.
 */
function actBlocks(row) {
  const view = redactForAccess('projects', row || {}, null);
  const transitions = transitionsOf(view);
  return actContext(view).blocks.map((year) => {
    const into = transitions.find(one => Number(one.toYear) === year);
    return { year, start: (into && into.date) || null };
  });
}

module.exports = { DERIVED_FIELDS, actBlocks, datePhasesFromDocuments, deriveAssessments };
