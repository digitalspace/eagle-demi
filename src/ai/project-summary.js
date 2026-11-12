'use strict';

/**
 * Stored per-project summary. `facts` are counted by code; `sections` are model prose, each grounded
 * on one source document's chunks, and a section with no source makes no model call. See ADR-013.
 */

const http = require('node:http');
const https = require('node:https');

const config = require('../config');
const { logger } = require('../utils/logger');
// Not destructured: tests replace these module members to keep a run off the network.
const summarizer = require('./summarize');
const iaac = require('./federal-source');
const { PROMPT_VERSION, SHAPES, INSTRUCTIONS, RETRY_INSTRUCTION, systemPrompt } =
  require('./project-summary-prompts');
const { levelOfRead } = require('../helpers/access-sql');
const { ANONYMOUS_LEVEL } = require('../vis/level');

/**
 * The model the cost is priced against, whatever ran. A local Ollama run is priced as the deployed
 * path would be, so local and deployed records stay comparable.
 */
const PRICED_AS = 'gpt-4.1-mini';

// --- Document selection ---

/** A List ObjectId, which is what `type` carries on a `/search` row. */
const LIST_ID = /^[0-9a-f]{24}$/i;

/**
 * The registry type as a label. A `/search` row carries the List id under `type` and the label
 * under `documentType`; pickers compare labels, so an id would match nothing.
 */
const typeOf = doc => {
  if (!doc) return '';
  const type = String(doc.type || '');
  if (type && !LIST_ID.test(type)) return type;
  return String(doc.documentType || '');
};
const nameOf = doc => String((doc && (doc.displayName || doc.documentFileName)) || '');
const dateOf = doc => String((doc && doc.datePosted) || '');

const isType = (doc, type) => typeOf(doc).toLowerCase() === type.toLowerCase();
const nameMatches = (doc, re) => re.test(nameOf(doc));

/** The access every source document must satisfy, and what `sourceAccess` on the record asserts. */
const SOURCE_ACCESS = 'public';

/**
 * Published and public only: the record has no ACL and its read route gates on the project. An API
 * row has no `read` (stripped at the boundary), so it is judged on `isPublished` alone.
 */
function isPublicSource(doc) {
  if (!doc || doc.isDeleted === true) return false;
  if (Array.isArray(doc.read) && levelOfRead(doc.read) !== ANONYMOUS_LEVEL) return false;
  return doc.isPublished === true;
}

/**
 * Either flag means extracted text exists. Narrows sources only: `facts` still counts every public
 * document.
 */
const hasExtractedText = doc =>
  !!doc && (doc.contentExtracted === true || Number(doc.contentPageCount) > 0);

/** Newest by `datePosted`. A row with no date sorts last rather than winning on a blank string. */
function newest(docs) {
  const dated = docs.filter(dateOf);
  const pool = dated.length ? dated : docs;
  return pool.slice().sort((a, b) => dateOf(b).localeCompare(dateOf(a)))[0] || null;
}

function byDateDesc(docs) {
  return docs.slice().sort((a, b) => dateOf(b).localeCompare(dateOf(a)));
}

/** The federal agencies, however a title names them. */
const FEDERAL_AGENCY = new RegExp([
  'canadian\\s+environmental\\s+assessment\\s+agency',
  '\\bceaa\\b',
  'impact\\s+assessment\\s+agency',
  '\\biaac\\b'
].join('|'), 'i');

const DECISION_STATEMENT = /decision\s+statement/i;
const DECISION_WORD = /\bdecision\b/i;

/** Correspondence and public input. A federal decision is never filed as one, whatever it is called. */
const CORRESPONDENCE_TYPE = /\bletters?\b|\be-?mails?\b|\bcomment\s+period/i;

/**
 * Canada's own decision document. An agency name alone is not enough, as many letters cite "(CEAA)":
 * the title must name a decision statement, or an agency and the word "decision".
 */
function isFederalDecision(doc) {
  if (CORRESPONDENCE_TYPE.test(typeOf(doc))) return false;
  const title = nameOf(doc);
  if (DECISION_STATEMENT.test(title)) return true;
  return FEDERAL_AGENCY.test(title) && DECISION_WORD.test(title);
}

/** Advice to a decision maker, never the decision itself. */
const EAO_ADVICE = /recommendations?/i;

/** Amendment paperwork, which is not the original report or application it amends. */
const AMENDMENT_TITLE = /amendment/i;

/** The newest non-amendment match, else the newest match: amendment filings outdate the original. */
const preferOriginal = docs =>
  newest(docs.filter(d => !nameMatches(d, AMENDMENT_TITLE))) || newest(docs);

/** Filed UNDER a submission's volumes, never the text of one. */
const UNDER_VOLUME_TITLE = /\bappendix\b|\bappendices\b|\bannex\b|\bpart\s+\d/i;

/** Filing structure under a big submission (appendix, volume), never the submission itself. */
const isSubsidiary = title => UNDER_VOLUME_TITLE.test(title) || /\bvolume\b/i.test(title);

/** Front matter bound with a submission but carrying none of its text. */
const FRONT_MATTER_TITLE =
  /\bcontents\b|\bconcordance\b|\bdefinitions?\b|\bacronyms?\b|\babbreviations?\b|\bauthorship\b|\bcover\b/i;

/** Volume 1 of a submission filed only in volumes, so such a project still has an application. */
const isMainVolume = title =>
  /\bvolume\s+0*1\b/i.test(title) && !UNDER_VOLUME_TITLE.test(title) && !FRONT_MATTER_TITLE.test(title);

/** A document about another (memo, response, comments), never that document. */
const DERIVATIVE_TITLE = new RegExp([
  '\\bmemos?\\b', '\\bresponses?\\b', '\\bcomments?\\b', '\\bletters?\\b', '\\be-?mails?\\b',
  '\\bnotice\\b', 'news\\s+release', '\\baddend(?:um|a)\\b', '\\bguidelines?\\b'
].join('|'), 'i');

/** A proponent's own study, whatever it calls itself. */
const PROPONENT_STUDY_TITLE =
  /\bstudy\b|\bstudies\b|\boptions\b|\bplan\b|\bhauling\b|\baccomm?odation\b/i;

/** The office, however a title names it. */
const EAO_TITLE = /\beao\b|environmental\s+assessment\s+office/i;

/**
 * A French copy. Markers only, so "French Creek" and "Resume of Conditions" stay English: bare
 * "fr"/"french" must be bracketed, trailing after a dash, or "French version".
 */
const FRENCH_TITLE =
  /\b(sommaire|r[ée]sum[ée]\s+(?:ex[ée]cutif|des\s+conditions)|rapport\s+d['’]?[ée]valuation|version\s+fran[çc]aise|traduction\s+fran[çc]aise|french\s+version)\b|\((?:fr|french|fran[çc]ais)\)|[-–]\s*(?:fr|french)\b/i;

const isFrenchTitle = doc => FRENCH_TITLE.test(nameOf(doc));

/** The English candidates, or every candidate when the registry holds only the French copy. */
const preferEnglish = docs => {
  const english = docs.filter(d => !isFrenchTitle(d));
  return english.length ? english : docs;
};

const ASSESSMENT_REPORT_TITLE = /assessment\s+report/i;

/**
 * The EAO's report on the whole project. Check order matters: amendment out, typed row in,
 * derivative out, then an EAO title beats the proponent-study words.
 */
function isAssessmentReport(doc) {
  const title = nameOf(doc);
  if (AMENDMENT_TITLE.test(title)) return false;
  if (isType(doc, 'Assessment Report')) return true;
  if (DERIVATIVE_TITLE.test(title)) return false;
  if (!ASSESSMENT_REPORT_TITLE.test(title)) return false;
  if (isSubsidiary(title)) return false;
  if (EAO_TITLE.test(title)) return true;
  return /^\s*assessment\s+report\b/i.test(title) && !PROPONENT_STUDY_TITLE.test(title);
}

const assessmentReports = docs => docs.filter(isAssessmentReport);

/**
 * Names itself the application, after at most a "<project> - " prefix. Derivative titles are
 * rejected earlier in `isApplication`, not by capping this prefix.
 */
const APPLICATION_MAIN_TITLE =
  /^\s*(?:[^-]*-\s*)?(?:eis\s*-|environmental\s+impact\s+statement\b|application\s+for\s+an?\s+)/i;

const APPLICATION_TITLE = /\bapplication\b/i;

/** The application itself, not the documents filed beneath or about it. */
function isApplication(doc) {
  const title = nameOf(doc);
  if (DERIVATIVE_TITLE.test(title)) return false;
  if (isSubsidiary(title) && !isMainVolume(title)) return false;
  if (APPLICATION_MAIN_TITLE.test(title)) return true;
  return isType(doc, 'Application Materials') && APPLICATION_TITLE.test(title);
}

/** The source document for each section, by type and title pattern, never by hardcoded id. */
const PICK = {
  scheduleB: docs => newest(docs.filter(d =>
    isType(d, 'Certificate Package') && nameMatches(d, /schedule\s*b/i))),
  scheduleA: docs => newest(docs.filter(d =>
    isType(d, 'Certificate Package') && nameMatches(d, /schedule\s*a/i))),
  certificate: docs => newest(docs.filter(d =>
    isType(d, 'Certificate Package') &&
    nameMatches(d, /certificate/i) &&
    !nameMatches(d, /schedule\s*[ab]/i))),
  amendedCertificate: docs => newest(docs.filter(d => nameMatches(d, /amended\s+certificate/i))),
  // No `preferOriginal` fallback: amendment reports only means no project report.
  assessmentReport: docs => newest(preferEnglish(assessmentReports(docs))),
  // Apart because the timeline reads English first and French last.
  englishAssessmentReport: docs => newest(assessmentReports(docs).filter(d => !isFrenchTitle(d))),
  frenchAssessmentReport: docs => newest(assessmentReports(docs).filter(isFrenchTitle)),
  // A title that names itself the application beats anything else the type sweeps in.
  application: docs => {
    const pool = preferEnglish(docs.filter(isApplication));
    return preferOriginal(pool.filter(d => nameMatches(d, APPLICATION_MAIN_TITLE)))
      || preferOriginal(pool);
  },
  newestInspection: docs => newest(docs.filter(d => isType(d, 'Inspection Record'))),
  amendments: docs => byDateDesc(docs.filter(d => isType(d, 'Amendment Package'))),
  inspections: docs => docs.filter(d => isType(d, 'Inspection Record')),
  // Self-reports have no registry type; only the name identifies them.
  selfReports: docs => byDateDesc(docs.filter(d =>
    nameMatches(d, /self[\s-]?report/i) && nameMatches(d, /compliance|annual/i))),
  // Only a real federal decision; EAO recommendations are advice, not the decision.
  federal: docs => newest(docs.filter(d => isFederalDecision(d) && !nameMatches(d, EAO_ADVICE)))
};

/**
 * Chronology sources, best first. French report last: often only a translated summary. No
 * amendments: the page already puts `facts.amendments` on the timeline.
 */
const TIMELINE_PICKS = [
  PICK.englishAssessmentReport, PICK.certificate, PICK.scheduleA, PICK.frenchAssessmentReport
];

/** The candidates `pool` actually holds, in order, each document once. */
function timelineCandidates(pool) {
  const seen = new Set();
  return TIMELINE_PICKS.map(pick => pick(pool)).filter(doc => {
    if (!doc) return false;
    const id = String(doc.id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** The best candidate, which is what a run with none of them says it was waiting on. */
const pickTimeline = pool => timelineCandidates(pool)[0] || null;

/** The outcomes that earn the next candidate a turn: the model answered, and nothing survived. */
const TIMELINE_FALLBACK_REASONS = ['no_list', 'no_grounded_content', 'empty'];

/** The ceiling on what one timeline costs. A fourth candidate is not worth a fourth document read. */
const TIMELINE_MAX_RUNS = 3;

/** The `role` values `facts.keyDocuments` carries, and the picker behind each. */
const KEY_DOCUMENT_ROLES = [
  ['certificate', PICK.certificate],
  ['scheduleA', PICK.scheduleA],
  ['scheduleB', PICK.scheduleB],
  ['amendedCertificate', PICK.amendedCertificate],
  ['application', PICK.application],
  ['assessmentReport', PICK.assessmentReport]
];

/** The three fields every document reference on the record carries, and nothing else. */
function docRef(doc) {
  return doc
    ? { documentId: String(doc.id), displayName: nameOf(doc), datePosted: dateOf(doc) || null }
    : null;
}

/** What a `not_extracted` section names, so the page can still link the document it is waiting on. */
const sourceRef = doc => ({ documentId: String(doc.id), displayName: nameOf(doc) });

/**
 * The document a section reads, else `not_extracted` (filed, no text yet) or `no_document`.
 * `documents` must already be the public list: `absentSource` is rendered.
 */
function pickSource(pick, extracted, documents) {
  const document = pick(extracted);
  if (document) return { document, absentReason: null, absentSource: null };
  const pending = pick(documents);
  return {
    document: null,
    absentReason: pending ? 'not_extracted' : 'no_document',
    absentSource: pending ? sourceRef(pending) : null
  };
}

/** `facts`: counts, dates and ids from the documents index, never from the model. */
function buildFacts(documents, sourcePool = documents) {
  const inspections = PICK.inspections(documents);
  const selfReports = PICK.selfReports(documents);

  return {
    documentTotal: documents.length,
    amendments: PICK.amendments(documents).map(docRef),
    inspections: { count: inspections.length, latest: docRef(newest(inspections)) },
    selfReports: { count: selfReports.length, latest: docRef(selfReports[0] || null) },
    keyDocuments: KEY_DOCUMENT_ROLES
      .map(([role, pick]) => {
        // The document the sections read wins, so a link and the prose beside it name one file.
        const document = pick(sourcePool) || pick(documents);
        const ref = docRef(document);
        if (!ref) return null;
        return isFrenchTitle(document) ? { role, ...ref, languageFlag: 'fr' } : { role, ...ref };
      })
      .filter(Boolean)
  };
}

// --- Prompting ---

/**
 * One numbered source; `i` is its position in this call, which is what a citation means.
 * The page goes in only when `pageNumbered`: otherwise the number is a passage sequence, not a page.
 */
const sourceLine = (c, i) => {
  const page = c.pageNumbered === true ? `(page ${c.pageNumber ?? 0}) ` : '';
  return `[${i + 1}] ${page}${String(c.content || '').trim()}`;
};

const SOURCE_SEPARATOR = '\n\n';

/** The numbered sources, one per chunk, capped by `projectSummaryMaxChunks`. */
function buildSourceBlock(chunks) {
  return chunks.map(sourceLine).join(SOURCE_SEPARATOR);
}

/** The user half of a section's prompt. Called with no chunks it is the header on its own. */
function userPrompt(document, chunks) {
  return `Sources from "${nameOf(document)}":\n\n${buildSourceBlock(chunks)}`;
}

// --- Model providers ---

/** One JSON completion from the configured provider, as `{content, usage, model, truncated}`. */
async function chatJson(system, user, maxTokens) {
  return config.projectSummaryProvider === 'ollama'
    ? chatOllama(system, user, maxTokens)
    : chatFoundry(system, user, maxTokens);
}

async function chatFoundry(system, user, maxTokens) {
  if (!config.foundryEndpoint || !config.foundryDeployment) {
    throw new Error('FOUNDRY_ENDPOINT/FOUNDRY_DEPLOYMENT is unset');
  }

  const token = await summarizer.getToken();
  const res = await summarizer.foundryChat(summarizer.foundryChatUrl(), token, {
    system, user, maxTokens, jsonObject: true
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`foundry ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  return {
    content: data?.choices?.[0]?.message?.content || '',
    usage: data?.usage || null,
    model: config.foundryDeployment,
    truncated: data?.choices?.[0]?.finish_reason === 'length'
  };
}

/**
 * A JSON POST with no timeout, on `node:http`: `fetch` (undici) fails after 300 s without headers,
 * and Ollama sends none until done. Every way the socket ends must settle the promise, or it hangs.
 */
function postJson(url, payload) {
  const target = new URL(url);
  const client = target.protocol === 'https:' ? https : http;
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const dropped = () =>
      fail(new Error(`${target.host} closed the connection before the reply ended`));

    const req = client.request(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('error', fail);
      res.on('aborted', dropped);
      res.on('end', () => {
        // `end` also fires on a body cut short; `complete` is what says the whole reply arrived.
        if (!res.complete) return dropped();
        if (settled) return;
        settled = true;
        resolve({ status: res.statusCode, body: text });
      });
    });
    req.on('error', fail);
    // Last resort: a destroyed socket does not always reach one of the handlers above.
    req.on('close', dropped);
    req.end(body);
  });
}

/**
 * Ollama's native `/api/chat`, for `think: false` and constrained `format: 'json'`. `num_ctx` is
 * mandatory: the 4k default silently truncates a longer prompt.
 */
async function chatOllama(system, user, maxTokens) {
  const res = await postJson(`${config.ollamaUrl.replace(/\/$/, '')}/api/chat`, {
    model: config.ollamaModel,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    stream: false,
    format: 'json',
    think: false,
    options: {
      temperature: 0,
      num_ctx: config.projectSummaryOllamaCtx,
      num_predict: maxTokens
    }
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`ollama ${res.status}: ${res.body.slice(0, 300)}`);
  }

  const data = JSON.parse(res.body);
  return {
    content: (data && data.message && data.message.content) || '',
    // Mapped to the OpenAI names so `estimateCostCad` prices both providers.
    usage: {
      prompt_tokens: Number(data && data.prompt_eval_count) || 0,
      completion_tokens: Number(data && data.eval_count) || 0
    },
    model: config.ollamaModel,
    // `length`: the reply stopped at `num_predict`, so it is a prefix that will not parse.
    truncated: (data && data.done_reason) === 'length'
  };
}

/**
 * How far the prompt overruns `num_ctx - num_predict`, where Ollama would silently drop its front.
 * Four chars per token is a rough guard against the gross case only.
 *
 * @returns {{estimate: number, excess: number}|null} null when the prompt fits
 */
function contextOverflow(system, user, maxTokens) {
  if (config.projectSummaryProvider !== 'ollama') return null;
  const estimate = Math.ceil((system.length + user.length) / 4);
  const excess = estimate + maxTokens - config.projectSummaryOllamaCtx;
  return excess > 0 ? { estimate, excess } : null;
}

/**
 * Sections split by `fitBatches` and joined by `mergeItemBatches`. `{items}` shapes only: a bare
 * array (nations, timeline) would merge to nothing.
 */
const LIST_SECTIONS = ['conditions', 'federal'];

/**
 * Completion budgets where the default cuts a long list mid-item, which parses as nothing.
 * Separate from `LIST_SECTIONS`: nations needs the budget but must not be batched.
 */
const SECTION_MAX_TOKENS = {
  conditions: 8000, federal: 8000, nations: 8000, timelineEvents: 4000
};

/** Sections whose reply is a list, batched or not: tells `no_list` from a list the gates emptied. */
const LIST_SHAPE_SECTIONS = ['conditions', 'federal', 'timelineEvents', 'nations'];

/** Sections read over the whole document in batches: a chronology has events on the last page. */
const CHUNK_BATCHED_SECTIONS = ['timelineEvents'];

/**
 * Sections narrowed to pages carrying a full date: the timeline accepts only fully dated events,
 * so an undated page is cost with no possible answer.
 */
const DATE_FILTERED_SECTIONS = ['timelineEvents'];

/**
 * How often a truncated chunk-batched batch may be halved: at most eight pieces, so a document
 * that truncates everywhere does not cost a call per chunk.
 */
const MAX_BATCH_HALVINGS = 3;

const isListSection = name => LIST_SECTIONS.includes(name);
const isChunkBatched = name => CHUNK_BATCHED_SECTIONS.includes(name);
const isDateFiltered = name => DATE_FILTERED_SECTIONS.includes(name);
const isListShape = name => LIST_SHAPE_SECTIONS.includes(name);
const maxTokensFor = name => SECTION_MAX_TOKENS[name] || config.projectSummaryMaxTokens;

/**
 * `chunks` in page-order runs that fit `num_ctx - num_predict` less `fixedChars`. `cap` also bounds
 * the count, so the reply fits its budget. An oversized chunk sits alone; `contextOverflow` refuses it.
 */
function fitBatches(chunks, fixedChars, maxTokens, cap = config.projectSummaryBatchChunks) {
  // Only Ollama's window is fixed and silent about overrunning it; Foundry is one call.
  if (config.projectSummaryProvider !== 'ollama') return [chunks];

  const budget = (config.projectSummaryOllamaCtx - maxTokens) * 4 - fixedChars;
  const batches = [];
  let batch = [];
  let size = 0;

  for (const [i, chunk] of chunks.entries()) {
    const cost = sourceLine(chunk, i).length + SOURCE_SEPARATOR.length;
    if (batch.length && (batch.length >= cap || size + cost > budget)) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(chunk);
    size += cost;
  }
  if (batch.length) batches.push(batch);

  return batches;
}

/**
 * Whole-document batches. On Ollama they are sized to the window like list batches, since a
 * fixed count can overflow it; elsewhere `maxChunks` alone bounds them.
 */
function chunkBatches(chunks, fixedChars, maxTokens, maxChunks) {
  return config.projectSummaryProvider === 'ollama'
    ? fitBatches(chunks, fixedChars, maxTokens, maxChunks)
    : sizedBatches(chunks, maxChunks);
}

/** `chunks` in consecutive runs of `size`, in the order they were read. */
function sizedBatches(chunks, size) {
  const step = Math.max(1, size);
  const batches = [];
  for (let i = 0; i < chunks.length; i += step) batches.push(chunks.slice(i, i + step));
  return batches.length ? batches : [chunks];
}

// --- Validation ---

const isStr = v => typeof v === 'string' && v.trim() !== '';
const isStrArray = v => Array.isArray(v) && v.every(isStr);

/**
 * One-based citations that index a source. Out-of-range ones are dropped, never renumbered:
 * mapping a fabricated `[9]` onto source 6 would make an invention resolve.
 */
function validCitations(value, sourceCount) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const raw of value) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= sourceCount) seen.add(n);
  }
  return Array.from(seen).sort((a, b) => a - b);
}

/**
 * Applied to both sides of the grounding check: "50,000" equals "50000", and a date split across
 * a PDF line break still matches.
 */
const normalise = text => String(text || '')
  .replace(/\s+/g, ' ')
  .replace(/(\d),(?=\d{3}(\D|$))/g, '$1');

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const MONTHS = MONTH_NAMES.join('|');
const MONTH_NUMBER = new Map(MONTH_NAMES.map((name, i) => [name.toLowerCase(), i + 1]));

/** Abbreviations and French month names, which federal and bilingual documents use. */
const OTHER_MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sept', 'sep', 'oct', 'nov', 'dec',
  'janvier', 'février', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'aout',
  'septembre', 'octobre', 'novembre', 'décembre', 'decembre'
].join('|');

/** Every month name the corpus writes: English and French, full and abbreviated. */
const ANY_MONTH = `(?:${MONTHS}|${OTHER_MONTHS})`;

/** The suffix a day carries when it is written as an ordinal: "14th", "1st", French "1er". */
const DAY_SUFFIX = '(?:st|nd|rd|th|er)?';

/**
 * Year, month and day together. Invariant: at least as wide as `dateSpellings`, so no page the
 * grounding gate could ground is filtered out before the model sees it.
 */
const FULL_DATE = new RegExp([
  // ISO, and the same three numbers slashed or dotted.
  '\\b\\d{4}[-/.]\\d{2}[-/.]\\d{2}\\b',
  // dd/mm or mm/dd: either order is a full date.
  '\\b\\d{1,2}/\\d{1,2}/\\d{4}\\b',
  // "October 14, 2014", "October 14th, 2014", "Oct. 14 2014", "Oct.14, 2014".
  `\\b${ANY_MONTH}(?:\\.\\s*|\\s+)\\d{1,2}${DAY_SUFFIX}(?:,\\s*|\\s+)\\d{4}\\b`,
  // "14 October 2014", "le 1er janvier 2024", and the legal "14th day of October, 2014".
  `\\b\\d{1,2}${DAY_SUFFIX}\\s+(?:day\\s+of\\s+)?${ANY_MONTH}(?:\\.?,\\s*|\\.?\\s+)\\d{4}\\b`
].join('|'), 'i');

/** Does `text` date anything in full? What `DATE_FILTERED_SECTIONS` narrows their sources to. */
const hasFullDate = text => FULL_DATE.test(String(text || ''));

const pad2 = n => String(n).padStart(2, '0');

/** "14th", "1st". Days only, so 11-13 are the whole irregular case. */
function ordinal(day) {
  const n = Number(day);
  const suffix = n >= 11 && n <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${suffix}`;
}

/** A date token in any spelling `claimTokens` produces, as ISO. Null when it is not a date. */
function isoDate(token) {
  const s = String(token).trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const monthFirst = /^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (monthFirst && MONTH_NUMBER.has(monthFirst[1])) {
    return `${monthFirst[3]}-${pad2(MONTH_NUMBER.get(monthFirst[1]))}-${pad2(monthFirst[2])}`;
  }

  const dayFirst = /^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/.exec(s);
  if (dayFirst && MONTH_NUMBER.has(dayFirst[2])) {
    return `${dayFirst[3]}-${pad2(MONTH_NUMBER.get(dayFirst[2]))}-${pad2(dayFirst[1])}`;
  }

  return null;
}

/**
 * Every spelling of one ISO date a source might use, lowercased. Both slash orders, since a
 * source rarely says which it uses; a different day still fails.
 */
function dateSpellings(iso) {
  const [year, month, day] = iso.split('-');
  const name = MONTH_NAMES[Number(month) - 1];
  if (!name) return [iso];

  const abbr = name.slice(0, 3);
  // Padded and unpadded both, because "October 04" and "October 4" are the same day.
  const days = Number(day) >= 10 ? [day] : [day, String(Number(day))];
  const months = Number(month) >= 10 ? [month] : [month, String(Number(month))];

  const out = [iso, `${year}/${month}/${day}`];
  for (const d of days) {
    const ord = ordinal(d);
    out.push(
      `${name} ${d}, ${year}`, `${name} ${d} ${year}`, `${d} ${name} ${year}`,
      `${name} ${ord}, ${year}`, `${name} ${ord} ${year}`, `${ord} ${name} ${year}`,
      `${abbr} ${d}, ${year}`, `${abbr}. ${d}, ${year}`,
      `${abbr} ${d} ${year}`, `${abbr}. ${d} ${year}`,
      `${d} ${abbr} ${year}`, `${d} ${abbr}. ${year}`,
      // How a certificate, an order and a schedule write their own date of issue.
      `${d} day of ${name}, ${year}`, `${d} day of ${name} ${year}`,
      `${ord} day of ${name}, ${year}`, `${ord} day of ${name} ${year}`
    );
    // Slashes only: a dotted "10.1.2014" is a clause number far more often than a date here.
    for (const m of months) out.push(`${d}/${m}/${year}`, `${m}/${d}/${year}`);
  }
  return out.map(s => s.toLowerCase());
}

/**
 * Every figure and date a claim commits to. Four digits and up: shorter numbers are mostly clause
 * references and prose ("within 30 days").
 */
function claimTokens(text) {
  const s = normalise(text);
  const found = new Set();
  for (const m of s.matchAll(/\d{4,}/g)) found.add(m[0]);
  for (const m of s.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) found.add(m[0]);
  for (const m of s.matchAll(new RegExp(`\\b(?:${MONTHS})\\s+\\d{1,2},?\\s+\\d{4}\\b`, 'gi'))) {
    found.add(m[0].toLowerCase());
  }
  for (const m of s.matchAll(new RegExp(`\\b\\d{1,2}\\s+(?:${MONTHS})\\s+\\d{4}\\b`, 'gi'))) {
    found.add(m[0].toLowerCase());
  }
  return Array.from(found);
}

/**
 * Is every figure and date in `text` in the document(s) it cites? A failing claim is dropped whole.
 * `pool` is every chunk of the source document; without it only the cited chunks count.
 */
function groundedInCitations(text, citations, chunks, pool) {
  return ungroundedToken(text, citations, chunks, pool) === null;
}

/**
 * Every chunk of the cited document(s), not only those the model saw: a figure is often repeated
 * outside the window. Never wider, so no claim grounds on a document it did not cite.
 */
function scopeToCitedDocuments(cited, pool) {
  if (!Array.isArray(pool) || pool.length === 0) return cited;
  const documentIds = new Set(cited.map(c => String((c && c.documentId) || '')));
  const scoped = pool.filter(c => documentIds.has(String((c && c.documentId) || '')));
  return scoped.length ? scoped : cited;
}

/** The first figure or date the cited chunks lack, or null; named so a drop log can show it. */
function ungroundedToken(text, citations, chunks, pool) {
  const tokens = claimTokens(text);
  if (tokens.length === 0) return null;

  const cited = normalise(
    scopeToCitedDocuments(citations.map(n => chunks[n - 1]).filter(Boolean), pool)
      .map(c => c.content || '').join('\n')
  ).toLowerCase();

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (cited.includes(lower)) continue;
    // A date the source spells differently is the same date, so it is grounded.
    const iso = isoDate(lower);
    if (iso && dateSpellings(iso).some(spelling => spellingMatches(cited, spelling))) continue;
    return token;
  }
  return null;
}

/** How much of a dropped claim a log line carries. Enough to find it, never the whole reply. */
const DROP_EXCERPT_MAX = 160;

/**
 * A claim the grounding gate dropped, named by the token that failed.
 *
 * @returns {boolean} true when the claim is grounded and survives
 */
function keepGrounded(section, text, citations, chunks, pool) {
  const token = ungroundedToken(text, citations, chunks, pool);
  if (token === null) return true;
  const where = section ? `${section}: ` : '';
  logger.warn(`[project-summary] ${where}dropped a claim whose "${token}" is in none of the ` +
    `sources it cites: ${String(text).trim().slice(0, DROP_EXCERPT_MAX)}`, { section, token });
  return false;
}

/**
 * `spelling` in `cited`, on a digit boundary for numeric forms: `1/10/2014` is a substring of
 * `11/10/2014`. Month-name spellings delimit themselves.
 */
function spellingMatches(cited, spelling) {
  if (!/^[\d/-]+$/.test(spelling)) return cited.includes(spelling);
  const escaped = spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^0-9])${escaped}(?![0-9])`).test(cited);
}

/** A ```json fence around a good reply; `format: 'json'` does not stop every model adding one. */
const CODE_FENCE = /^\s*```[a-z]*\s*\n?([\s\S]*?)\n?\s*```\s*$/i;

/**
 * JSON object or array, else null. A bare `[]` is an honest "there are none", not a parse failure.
 */
function parseJson(content) {
  const text = String(content || '');
  const fenced = CODE_FENCE.exec(text);
  try {
    const parsed = JSON.parse(fenced ? fenced[1] : text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** The keys a list section's reply may carry its list under, one per list shape. */
const LIST_KEYS = ['items', 'events', 'nations'];

/** The list under `key`, or the reply itself when it is already an array. Null when neither. */
const listOf = (parsed, key) => {
  if (Array.isArray(parsed)) return parsed;
  return parsed && Array.isArray(parsed[key]) ? parsed[key] : null;
};

/**
 * The list a reply declares under any key, or null. Its length is read before the gates, so an
 * empty answer is told apart from one whose every item was dropped.
 */
function replyList(parsed) {
  if (Array.isArray(parsed)) return parsed;
  for (const key of LIST_KEYS) {
    const list = listOf(parsed, key);
    if (list) return list;
  }
  return null;
}

// --- Citation registry ---

/**
 * The record's one citation list, numbered across every section. A chunk is registered only when
 * something cites it.
 */
function citationRegistry() {
  const byChunkId = new Map();
  const entries = [];

  return {
    /** @returns {number} the record-wide source number for this chunk */
    register(chunk, documentName) {
      const key = String(chunk.chunkId);
      if (byChunkId.has(key)) return byChunkId.get(key);
      const n = entries.length + 1;
      byChunkId.set(key, n);
      entries.push({
        n,
        chunkId: key,
        documentId: String(chunk.documentId || ''),
        pageNumber: chunk.pageNumber ?? 0,
        documentName,
        // A non-DEMI source carries its own link: nothing in DEMI resolves an `iaac:` id.
        ...(chunk.source ? { source: String(chunk.source) } : {}),
        ...(chunk.url ? { url: String(chunk.url) } : {}),
        ...(chunk.format ? { format: String(chunk.format) } : {})
      });
      return n;
    },
    /**
     * Local source numbers to record-wide ones. A chunk from a project-wide search carries its own
     * `documentName`, which wins.
     */
    map(local, chunks, documentName) {
      return local.map(n => this.register(chunks[n - 1], chunks[n - 1].documentName || documentName));
    },
    list: () => entries
  };
}

// --- Nations ---

/**
 * The generic words a nation's name may end with. TRAILING only: "Métis Nation British Columbia"
 * carries one mid-name and is not the same organisation with it removed.
 */
const GENERIC_SUFFIX =
  /(?:\s*\b(?:first\s+nations?|indian\s+bands?|tribal\s+councils?|nations?|bands?|tribes?))+\s*$/;

/**
 * A nation's name reduced to what its spellings share. Normalises spelling, never meaning; names
 * it cannot match are logged unmatched, the input to `NATION_ALIASES`.
 */
function normaliseNationName(name) {
  return String(name || '')
    // Decomposed first, so "Stó:lō" and "Stolo" reduce to the same letters.
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // A parenthesised alias is a second name for the same nation, not part of this one.
    .replace(/\([^)]*\)/g, ' ')
    // Removed, not spaced: these sit inside a word ("Scia'new"), and 7 marks a glottal stop.
    .replace(/['‘’`"“”:7]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the\s+/, '')
    .replace(GENERIC_SUFFIX, '')
    .trim();
}

/**
 * Spellings no normalisation joins, keyed normalised. Applied to both sides of the join; add a pair
 * only when `normaliseNationName` alone cannot match it.
 */
const NATION_ALIASES = new Map([
  ['beecher bay', 'scianew'],
  ['sooke', 'tsou ke'],
  ['tsouke', 'tsou ke'],
  ['metis bc', 'metis nation british columbia'],
  ['metis nation bc', 'metis nation british columbia']
]);

/** A normalised name reduced to the one form both spellings of a nation join on. */
const canonicalNationName = key => NATION_ALIASES.get(key) || key;

/** The key a name joins on: normalised, then resolved through the alias table. */
const nationKey = name => canonicalNationName(normaliseNationName(name));

/**
 * Model names joined to Organization rows. Contact details come only from the row, never the
 * model; an unmatched name is kept with `organizationId: null`.
 */
function joinNations(names, organizations) {
  const byName = new Map();
  for (const org of organizations || []) {
    const key = nationKey(org.name);
    if (key && !byName.has(key)) byName.set(key, org);
  }

  return names.map(({ name, citations }) => {
    const match = byName.get(nationKey(name));
    return { name, organizationId: match ? String(match.id) : null, citations };
  });
}

// --- Sections ---

/**
 * One section over a non-empty source set: ask, validate, number citations record-wide.
 *
 * @returns {Promise<{value: any, usage: object|null, model: string|null, documentId: string|null,
 *   reason: string|null}>} `value` null means `reason` says why
 */
async function runSection({ section, document, chunks, registry, projectName, instruction, shape,
  build, maxTokens }) {
  // Null for a section whose sources came from a search across documents rather than from one.
  const documentId = document.id ? String(document.id) : null;

  const maxChunks = config.projectSummaryMaxChunks;
  const listSection = isListSection(section);
  const chunkBatched = isChunkBatched(section);
  // A chunk-batched section reads the whole document; every other one reads its first window.
  const read = chunkBatched ? chunks : chunks.slice(0, maxChunks);
  let used = read;
  if (isDateFiltered(section)) {
    used = read.filter(c => hasFullDate(c.content));
    logger.info(`[project-summary] ${section}: ${used.length} of ${read.length} pages carry a ` +
      'full date', { documentId, dated: used.length, pages: read.length });
    // Same as a reply listing none, so the next timeline candidate gets its turn.
    if (!used.length) {
      return { value: null, usage: null, model: null, documentId, reason: 'empty' };
    }
  }
  const system = systemPrompt(projectName, instruction, shape);
  // What every batch's prompt carries before its sources: the system half, and the user half's header.
  const fixedChars = system.length + userPrompt(document, []).length;
  const batches = listSection
    ? fitBatches(used, fixedChars, maxTokens)
    : chunkBatched ? chunkBatches(used, fixedChars, maxTokens, maxChunks) : [used];

  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  const values = [];
  let model = null;
  let reason = null;
  // Entries the model listed before the gates: empty is an answer, all dropped is a fault.
  let declared = 0;
  let sawList = false;
  const batchLabel = i => (batches.length > 1 ? ` (batch ${i + 1} of ${batches.length})` : '');

  /**
   * One piece of a batch: retried once if not JSON, halved if truncated. `index` stays the batch's.
   *
   * @returns {Promise<boolean>} False when the section is finished — `reason` says why.
   */
  const runPiece = async (piece, index, depth, user = userPrompt(document, piece)) => {
    const ask = async (systemText) => {
      const reply = await chatJson(systemText, user, maxTokens);
      if (reply.usage) {
        usage.prompt_tokens += Number(reply.usage.prompt_tokens) || 0;
        usage.completion_tokens += Number(reply.usage.completion_tokens) || 0;
      }
      if (reply.model) model = reply.model;
      if (reply.truncated) {
        // Numbers in the message: the console format drops metadata.
        logger.warn(`[project-summary] ${section}: the reply stopped at the ${maxTokens}-token ` +
          'completion budget, so what came back is a fragment', {
          documentId, sources: piece.length, numPredict: maxTokens
        });
      }
      return reply;
    };

    let reply = await ask(system);
    let parsed = parseJson(reply.content);

    // A stricter instruction cannot fix truncation; halving gives each half the whole budget.
    if (chunkBatched && reply.truncated && piece.length > 1 && depth < MAX_BATCH_HALVINGS) {
      const half = Math.ceil(piece.length / 2);
      logger.info(`[project-summary] ${section}: batch ${index + 1} of ${batches.length} stopped ` +
        `at the ${maxTokens}-token completion budget; asking its ${piece.length} sources as ` +
        `${half} + ${piece.length - half}`, {
        documentId, batch: index + 1, sources: piece.length, halving: depth + 1
      });
      return await runPiece(piece.slice(0, half), index, depth + 1)
        && await runPiece(piece.slice(half), index, depth + 1);
    }

    if (!parsed) {
      logger.warn(`[project-summary] ${section}: reply did not parse as JSON; asking once more ` +
        'with a stricter instruction', { documentId });
      reply = await ask(systemPrompt(projectName, `${instruction} ${RETRY_INSTRUCTION}`, shape));
      parsed = parseJson(reply.content);
    }

    if (!parsed) {
      logger.warn(`[project-summary] ${section}: rejected a reply that was not JSON`, {
        documentId, sources: piece.length, batch: index + 1, batches: batches.length
      });
      // Fails the whole section: a merged list missing one batch would look complete.
      reason = `${reply.truncated ? 'truncated' : 'not_json'}${batchLabel(index)}`;
      return false;
    }

    const list = replyList(parsed);
    if (list) {
      sawList = true;
      declared += list.length;
    }

    // Citations map through this piece's chunks, so batch 2's `[1]` is not batch 1's source;
    // grounding reads the whole document's `chunks`.
    values.push(
      build(parsed, piece, n => registry.map(n, piece, nameOf(document)), section, chunks));
    return true;
  };

  for (const [index, batch] of batches.entries()) {
    const user = userPrompt(document, batch);

    const overflow = contextOverflow(system, user, maxTokens);
    if (overflow) {
      logger.warn(`[project-summary] ${section}: the prompt is ${overflow.excess} tokens over the ` +
        'context window; section not generated', {
        documentId,
        sources: batch.length,
        estimatedPromptTokens: overflow.estimate,
        numPredict: maxTokens,
        numCtx: config.projectSummaryOllamaCtx
      });
      reason = `context_overflow${batchLabel(index)}`;
      break;
    }

    if (!await runPiece(batch, index, 0, user)) break;
  }

  // Counted on the values, not on `batches`: a halved batch produces one value per piece.
  const value = reason ? null
    : listSection ? mergeItemBatches(values)
      : chunkBatched && values.length > 1 ? mergeTimelineBatches(values)
        : (values[0] || null);
  if (!reason && value === null) {
    // `no_list`: wrong shape. `empty`: the model listed none. `no_grounded_content`: gates dropped all.
    if (!isListShape(section)) reason = 'no_grounded_content';
    else if (!sawList) reason = 'no_list';
    else reason = declared === 0 ? 'empty' : 'no_grounded_content';

    if (sawList && declared > 0) {
      logger.warn(`[project-summary] ${section}: the reply listed ${declared} entries and the ` +
        'citation and grounding gates dropped every one', { documentId, declared });
    }
  }
  return { value, usage, model, documentId, reason };
}

/** The timeline batches as one timeline: one row per date and label, newest first. */
function mergeTimelineBatches(values) {
  const seen = new Set();
  const events = [];
  for (const value of values) {
    for (const event of value || []) {
      const key = `${event.date} ${normalise(event.label).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(event);
    }
  }
  return events.length ? events.sort((a, b) => b.date.localeCompare(a.date)) : null;
}

/** The list batches as one list, renumbered end to end so `n` is contiguous across the section. */
function mergeItemBatches(values) {
  const items = [];
  for (const value of values) {
    for (const item of (value && value.items) || []) items.push({ ...item, n: items.length + 1 });
  }
  return items.length ? { items } : null;
}

/** `{sentence, citations}` — dropped whole if the sentence is ungrounded. */
function buildSentence(parsed, chunks, toGlobal, section, pool) {
  if (!isStr(parsed.sentence)) return null;
  const local = validCitations(parsed.citations, chunks.length);
  if (local.length === 0) return null;
  if (!keepGrounded(section, parsed.sentence, local, chunks, pool)) return null;
  return { sentence: parsed.sentence.trim(), citations: toGlobal(local) };
}

function buildParagraph(parsed, chunks, toGlobal, section, pool) {
  if (!isStr(parsed.paragraph)) return null;
  const local = validCitations(parsed.citations, chunks.length);
  if (local.length === 0) return null;
  if (!keepGrounded(section, parsed.paragraph, local, chunks, pool)) return null;
  return { paragraph: parsed.paragraph.trim(), citations: toGlobal(local) };
}

/**
 * `{items}` for conditions and federal. Items and bullets are dropped one at a time; an item whose
 * bullets all drop is kept, since its title and one-liner were checked on their own.
 */
function buildItems(parsed, chunks, toGlobal, section, pool) {
  const declared = listOf(parsed, 'items');
  if (!declared) return null;

  const items = [];
  for (const raw of declared) {
    if (!raw || typeof raw !== 'object') continue;
    if (!isStr(raw.title) || !isStr(raw.oneLiner)) continue;
    if (raw.bullets !== undefined && !isStrArray(raw.bullets)) continue;

    const local = validCitations(raw.citations, chunks.length);
    if (local.length === 0) continue;
    if (!keepGrounded(section, `${raw.title} ${raw.oneLiner}`, local, chunks, pool)) continue;

    items.push({
      n: items.length + 1,
      category: isStr(raw.category) ? raw.category.trim() : '',
      title: raw.title.trim(),
      oneLiner: raw.oneLiner.trim(),
      bullets: (raw.bullets || []).filter(b => keepGrounded(section, b, local, chunks, pool)),
      citations: toGlobal(local)
    });
  }

  return items.length ? { items } : null;
}

function buildTimeline(parsed, chunks, toGlobal, section, pool) {
  const declared = listOf(parsed, 'events');
  if (!declared) return null;

  const events = [];
  for (const raw of declared) {
    if (!raw || typeof raw !== 'object') continue;
    // An ISO date, strictly. A timeline row merges with the fact rows on the page and sorts
    // against them, so a free-text date would be a row that cannot be placed.
    if (!isStr(raw.date) || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date.trim())) continue;
    if (!isStr(raw.label)) continue;

    const local = validCitations(raw.citations, chunks.length);
    if (local.length === 0) continue;
    if (!keepGrounded(section, `${raw.date} ${raw.label}`, local, chunks, pool)) continue;

    events.push({ date: raw.date.trim(), label: raw.label.trim(), citations: toGlobal(local) });
  }

  return events.length ? events : null;
}

function buildNations(parsed, chunks, toGlobal) {
  const declared = listOf(parsed, 'nations');
  if (!declared) return null;

  const names = [];
  const seen = new Set();
  for (const raw of declared) {
    if (!raw || typeof raw !== 'object' || !isStr(raw.name)) continue;
    const local = validCitations(raw.citations, chunks.length);
    if (local.length === 0) continue;

    const name = raw.name.trim();
    // The join key, so a reply naming one nation twice under two spellings lists it once.
    const key = nationKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    names.push({ name, citations: toGlobal(local) });
  }

  return names.length ? names : null;
}

// --- Generation ---

/** Longest project name quoted into a prompt. Past this it is crowding out the sources. */
const PROMPT_NAME_MAX = 200;

/**
 * Prompt-injection guard for an unconstrained stored name: quotes removed (no escape is safe in
 * every position), whitespace collapsed to one line, length capped.
 */
function sanitisePromptName(name) {
  return String(name || '')
    .replace(/["'`‘’“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PROMPT_NAME_MAX);
}

/** What the nations section searches for, and what a chunk it keeps has to actually say. */
const NATIONS_KEYWORDS = 'First Nation';
const NATIONS_MENTION = /first\s+nations?/i;

/** Document types whose nation names are this project's, read before anything else names one. */
const NATIONS_DOCUMENT_TYPES = ['Decision Materials', 'Order', 'Certificate Package',
  'Assessment Report', 'Application Materials'];

/**
 * Hit documents by type rank, then newest first: decisions and applications speak for this
 * project, while a province-wide roster names every nation.
 */
function orderNationDocuments(documents) {
  const rank = doc => {
    const i = NATIONS_DOCUMENT_TYPES.findIndex(type => isType(doc, type));
    return i === -1 ? NATIONS_DOCUMENT_TYPES.length : i;
  };
  // Sort is stable, so within one rank the date order set up here survives.
  return byDateDesc(documents).sort((a, b) => rank(a) - rank(b));
}

/**
 * The nations source: passages across the project, so `id` is null and each citation names its
 * own document.
 */
const NATIONS_SOURCE = { id: null, displayName: 'passages that name a First Nation' };

// --- Federal ---

/** A DEMI document id this is not, and cannot be mistaken for: `iaac:158078`. */
const iaacId = (...parts) => ['iaac', ...parts].join(':');

/** A blank page is not a source: nothing can cite it and the grounding gate cannot check it. */
const readablePages = decision =>
  ((decision && decision.pages) || []).filter(page => String(page.text || '').trim());

/** A decision statement's pages as chunks, so the prompt and both gates run unchanged. */
function federalChunksFrom(decision) {
  const documentId = iaacId(decision.docId);
  return readablePages(decision)
    .map(page => ({
      // Both names: the citation registry reads `chunkId`.
      id: iaacId(decision.docId, page.page),
      chunkId: iaacId(decision.docId, page.page),
      documentId,
      pageNumber: page.page,
      pageNumbered: true,
      content: page.text,
      source: 'iaac',
      // The file, or the registry page that prints the decision instead of linking a file.
      url: decision.pdfUrl || decision.pageUrl || null,
      // Which of the two `url` is, so the chip labels the link it actually opens.
      format: decision.format || (decision.pdfUrl ? 'pdf' : null)
    }));
}

/** The newest thing the registry lists for a project, which is what a page with no decision links. */
function latestRegistryDocument(documents) {
  const newest = (documents || []).slice()
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0];
  return newest ? { title: newest.title, date: newest.date || null, docId: newest.docId } : null;
}

/** What the page shows about the decision document itself, read or not. */
const decisionFacts = decision => ({
  docId: decision.docId,
  title: decision.title,
  date: decision.date || null,
  pdfUrl: decision.pdfUrl || null,
  // Older statements exist only as a registry page; `format` says which link the reader gets.
  pageUrl: decision.pageUrl || null,
  format: decision.format || null
});

/**
 * The stored `federal` section; `source` says whether items resolve in DEMI. Null means nothing is
 * known: a registry read showing no decision stores that as a reason with facts.
 */
function federalSection(origin, result, source) {
  if (origin !== 'iaac') {
    return result && result.value
      ? { source: 'demi', sourceDocumentId: result.documentId, ...result.value }
      : null;
  }
  // The registry could not be read at all; `sectionErrors.federal` says which failure it was.
  if (!source) return null;

  const facts = {
    status: source.status || null,
    cearId: source.cearId,
    projectUrl: source.projectUrl,
    latest: latestRegistryDocument(source.documents)
  };
  const { decision } = source;
  if (!decision) return { source: 'iaac', facts, items: [], reason: 'no_federal_decision' };
  // Listed but unreadable: `no_federal_decision` here would be a false claim.
  if (readablePages(decision).length === 0) {
    return {
      source: 'iaac',
      facts: { ...facts, decision: decisionFacts(decision) },
      items: [],
      reason: 'federal_decision_unreadable'
    };
  }
  // A decision with no numbered conditions is an outcome, not a failure: keep its facts and link.
  if (result && !result.value && result.reason === 'empty') {
    return {
      source: 'iaac',
      sourceDocumentId: result.documentId,
      facts: {
        ...facts,
        decision: { ...decisionFacts(decision), pageCount: (decision.pages || []).length }
      },
      items: [],
      reason: 'no_conditions'
    };
  }
  if (!result || !result.value) return null;

  return {
    source: 'iaac',
    sourceDocumentId: result.documentId,
    facts: {
      ...facts,
      decision: { ...decisionFacts(decision), pageCount: (decision.pages || []).length }
    },
    ...result.value
  };
}

/**
 * Reasons that describe what the registry holds rather than something that went wrong, so they are
 * logged at INFO. Everything else is a run that could have produced a section and did not.
 */
const QUIET_REASONS = ['no_document', 'not_extracted', 'no_source', 'no_text', 'empty',
  'no_federal_decision'];

/** Every section, so `--section` can name one and the runner can check the name is real. */
const SECTIONS = ['status', 'conditions', 'amendments', 'timelineEvents', 'compliance',
  'nations', 'federal'];

/**
 * Generate one project's summary record. Never writes: the caller stores it, so a dry run matches.
 *
 * @param {string} projectId  DEMI project id
 * @param {object} opts
 * @param {object} opts.sources  a `project-summary-sources` adapter
 * @param {string} [opts.section]  generate only this section; the rest stay null
 * @param {string} [opts.now]  ISO timestamp, for repeatable tests
 * @returns {Promise<object|null>} the record, or null when `summaryEnabled` is off
 */
async function generateProjectSummary(projectId, opts = {}) {
  const { sources, section, now } = opts;
  if (!sources) throw new Error('generateProjectSummary requires a sources adapter');

  // Null, not an all-null record, which would look like a project with nothing to summarise.
  if (!config.summaryEnabled) {
    logger.warn('[project-summary] SUMMARY_ENABLED is false; nothing generated');
    return null;
  }
  if (section && !SECTIONS.includes(section)) {
    throw new Error(`unknown section "${section}"; one of ${SECTIONS.join(', ')}`);
  }

  const project = await sources.project(projectId);
  if (!project) throw new Error(`project ${projectId} not found, or not readable`);

  // The one place documents are narrowed to public; everything downstream picks from this list.
  const listed = await sources.documents(projectId);
  const documents = listed.filter(isPublicSource);
  if (documents.length !== listed.length) {
    logger.info('[project-summary] non-public documents excluded', {
      projectId: String(projectId), excluded: listed.length - documents.length
    });
  }

  // Sources need extracted text; `facts` still counts every public document.
  const extracted = documents.filter(hasExtractedText);
  if (extracted.length !== documents.length) {
    logger.info('[project-summary] documents with no extracted text cannot be sources', {
      projectId: String(projectId), withoutText: documents.length - extracted.length
    });
  }

  const facts = buildFacts(documents, extracted);

  const registry = citationRegistry();
  const projectName = sanitisePromptName(project.name || project.displayName || projectId);

  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  const models = new Set();
  // A reason for every null section, including those that made no model call.
  const sectionErrors = {};
  // The document a `not_extracted` section waits on, so the page can link it.
  const sectionSources = {};
  // Per reason, with document ids: amendments are one call per document.
  const amendmentErrors = new Map();

  /** Record why a section produced nothing, and say it once in the log. */
  const record = (name, reason, documentId, absentSource) => {
    const at = documentId ? `, document ${documentId}` : '';
    const line = `[project-summary] ${name}: nothing generated (${reason}${at})`;
    const meta = { projectId: String(projectId), documentId: documentId ? String(documentId) : null };
    if (QUIET_REASONS.includes(reason)) logger.info(line, meta);
    else logger.warn(line, meta);

    if (name === 'amendments') {
      const ids = amendmentErrors.get(reason) || [];
      if (documentId) ids.push(String(documentId));
      amendmentErrors.set(reason, ids);
      return;
    }
    sectionErrors[name] = reason;
    if (absentSource) sectionSources[name] = absentSource;
  };

  const wanted = name => !section || section === name;

  const source = pick => pickSource(pick, extracted, documents);
  // The newest amendment, else the certificate: status is the project's current standing.
  const pickStatus = pool => facts.amendments
    .map(ref => pool.find(d => String(d.id) === ref.documentId))
    .find(Boolean) || PICK.certificate(pool);
  const { document: statusDoc, ...statusAbsent } = source(pickStatus);
  const { document: scheduleB, ...conditionsAbsent } = source(PICK.scheduleB);
  const { document: federalDoc, ...federalAbsent } = source(PICK.federal);
  const { document: complianceDoc, ...complianceAbsent } = source(PICK.newestInspection);
  const { document: timelineDoc, ...timelineAbsent } = source(pickTimeline);
  // Which candidates run is decided after the reads: one with no chunks costs no call.
  const timelineDocs = timelineCandidates(extracted);
  const amendmentDocs = facts.amendments
    .map(ref => ({ ref, document: documents.find(d => String(d.id) === ref.documentId) }))
    .filter(a => a.document);

  // Every API read happens before the first model call: a workstation run's staff token expires
  // within minutes, and one model call can outlast it.
  const chunksByDocument = new Map();
  const prefetch = async (name, document) => {
    if (!wanted(name) || !document) return;
    const id = String(document.id);
    if (chunksByDocument.has(id)) return;
    const { items } = await sources.chunksForDocument(id);
    chunksByDocument.set(id, items || []);
  };
  const chunksOf = document => chunksByDocument.get(String(document.id)) || [];

  await prefetch('status', statusDoc);
  await prefetch('conditions', scheduleB);
  await prefetch('federal', federalDoc);
  await prefetch('compliance', complianceDoc);
  for (const document of timelineDocs) await prefetch('timelineEvents', document);
  for (const { document } of amendmentDocs) {
    if (hasExtractedText(document)) await prefetch('amendments', document);
  }

  // Few federal decisions are filed in DEMI, so the IAAC registry is the fallback when DEMI has none.
  let federalOrigin = 'demi';
  let federalDocument = federalDoc;
  let federalChunks = null;
  let federalSpec = { ...federalAbsent };
  let federalSource = null;
  if (wanted('federal') && !federalDoc && config.federalSource === 'iaac') {
    try {
      federalSource = await iaac.fetchFederalSource(project);
    } catch (err) {
      logger.warn(`[project-summary] federal: the IAAC registry could not be read: ${err.message}`,
        { projectId: String(projectId) });
      federalSpec = { absentReason: 'federal_source_unavailable', absentSource: null };
    }
    if (federalSource) {
      federalOrigin = 'iaac';
      const { decision } = federalSource;
      if (decision && readablePages(decision).length) {
        federalDocument = { id: iaacId(decision.docId), displayName: decision.title };
        federalChunks = federalChunksFrom(decision);
        federalSpec = { absentReason: null, absentSource: null };
      } else {
        // A listed decision whose PDF could not be read is not a project without a decision.
        federalSpec = {
          absentReason: decision ? 'federal_decision_unreadable' : 'no_federal_decision',
          absentSource: null
        };
      }
    }
  }

  // The search only picks documents (its rows have no chunk text); chunks come from the
  // per-document read, so they can be cited and grounded.
  const nationsChunks = [];
  let nationsAbsent = { absentReason: 'no_source', absentSource: null };
  if (wanted('nations')) {
    const hits = await sources.chunkSearch({
      projectId: String(projectId), keywords: NATIONS_KEYWORDS
    });
    const byId = new Map(documents.map(d => [String(d.id), d]));
    // A hit outside the public list is not a source, however well it ranked.
    const hitDocuments = orderNationDocuments(
      Array.from(new Set(hits.map(hit => String(hit.documentId || ''))), id => byId.get(id))
        .filter(Boolean));
    const extractedHits = hitDocuments.filter(hasExtractedText);

    let contributed = 0;
    for (const document of extractedHits) {
      if (nationsChunks.length >= config.projectSummaryNationChunks) break;
      await prefetch('nations', document);
      // Per document, so one long roster cannot spend the whole budget and leave the rest of the
      // registry unread.
      let taken = 0;
      for (const chunk of chunksOf(document)) {
        if (taken >= config.projectSummaryNationChunksPerDoc) break;
        if (nationsChunks.length >= config.projectSummaryNationChunks) break;
        if (!NATIONS_MENTION.test(String(chunk.content || ''))) continue;
        nationsChunks.push({ ...chunk, documentName: nameOf(document) });
        taken += 1;
      }
      if (taken) contributed += 1;
    }
    // The search named a document and its text is not in DEMI yet: a different state from a project
    // whose documents name no nation, and one the page can link.
    const pending = nationsChunks.length ? null : hitDocuments.find(d => !hasExtractedText(d));
    if (pending) {
      nationsAbsent = { absentReason: 'not_extracted', absentSource: sourceRef(pending) };
    }
    logger.info('[project-summary] nations sources', {
      projectId: String(projectId), documents: hits.length, contributing: contributed,
      chunks: nationsChunks.length
    });
  }

  // The Organization rows the nation names are joined to. Read here, on the same token, rather than
  // after the nations section returns; skipped when that section cannot run at all.
  const organizations = nationsChunks.length ? await sources.organizations() : [];

  /** One section end to end, with its usage folded into the record's totals. */
  const run = async (name, document,
    { chunks, absentReason, absentSource, report = record, ...spec }) => {
    if (!wanted(name)) return null;
    const sourceChunks = chunks || (document ? chunksOf(document) : []);
    if (!document || sourceChunks.length === 0) {
      // No sources means no model call: a model handed nothing answers from its own knowledge, and
      // on a regulatory registry that answer is indistinguishable from a real one.
      report(name, absentReason || (document ? 'no_chunks' : 'no_document'),
        (absentSource && absentSource.documentId) || (document && document.id), absentSource);
      return null;
    }
    const result = await runSection({
      section: name, document, chunks: sourceChunks, registry, projectName,
      maxTokens: maxTokensFor(name), ...spec
    });
    if (result.reason) report(name, result.reason, result.documentId);
    if (result.usage) {
      usage.prompt_tokens += Number(result.usage.prompt_tokens) || 0;
      usage.completion_tokens += Number(result.usage.completion_tokens) || 0;
    }
    if (result.model) models.add(result.model);
    return result;
  };

  const status = await run('status', statusDoc, {
    ...statusAbsent,
    shape: SHAPES.status,
    instruction: INSTRUCTIONS.status,
    build: buildSentence
  });

  const conditions = await run('conditions', scheduleB, {
    ...conditionsAbsent,
    shape: SHAPES.conditions,
    instruction: INSTRUCTIONS.conditions,
    build: buildItems
  });

  // `empty` from a decision that read is a stored outcome (`federalSection`), so it stays out of
  // `sectionErrors`, which the run is judged on.
  const federalReport = (name, reason, documentId, absentSource) => {
    if (reason === 'empty' && federalChunks && federalChunks.length) {
      logger.info('[project-summary] federal: the decision lists no conditions', {
        projectId: String(projectId), documentId: documentId ? String(documentId) : null
      });
      return;
    }
    record(name, reason, documentId, absentSource);
  };

  const federal = await run('federal', federalDocument, {
    ...federalSpec,
    report: federalReport,
    chunks: federalChunks,
    shape: SHAPES.conditions,
    instruction: INSTRUCTIONS.federal,
    build: buildItems
  });

  const nationsResult = await run('nations', NATIONS_SOURCE, {
    chunks: nationsChunks,
    ...nationsAbsent,
    shape: SHAPES.nations,
    instruction: INSTRUCTIONS.nations,
    build: buildNations
  });

  const compliance = await run('compliance', complianceDoc, {
    ...complianceAbsent,
    shape: SHAPES.compliance,
    instruction: INSTRUCTIONS.compliance,
    build: buildParagraph
  });

  // Down the candidate list until one yields events; only the last outcome is recorded, so a
  // fallback that works stores no error.
  const timelineSpec = {
    shape: SHAPES.timeline,
    instruction: INSTRUCTIONS.timelineEvents,
    build: buildTimeline
  };
  const timelineTried = timelineDocs
    .filter(document => chunksOf(document).length)
    .slice(0, TIMELINE_MAX_RUNS);
  let timelineEvents = null;
  if (wanted('timelineEvents')) {
    if (!timelineTried.length) {
      // Nothing readable: `timelineAbsent` says whether the registry holds a candidate at all.
      timelineEvents = await run('timelineEvents', timelineDoc, { ...timelineAbsent, ...timelineSpec });
    } else {
      for (const [index, document] of timelineTried.entries()) {
        if (index > 0) {
          logger.info('[project-summary] timelineEvents: no events from ' +
            `"${nameOf(timelineTried[index - 1])}"; reading "${nameOf(document)}" instead`, {
            projectId: String(projectId), documentId: String(document.id)
          });
        }
        timelineEvents = await run('timelineEvents', document,
          { ...timelineSpec, report: () => {} });
        // What the events were read from, or on total failure the last document tried.
        sectionSources.timelineEvents = sourceRef(document);
        if (!TIMELINE_FALLBACK_REASONS.includes(timelineEvents.reason)) break;
      }
      if (timelineEvents.reason) {
        record('timelineEvents', timelineEvents.reason, timelineEvents.documentId);
      }
    }
  }

  // One call per amendment. Each is its own document, and a single call over all eight would let a
  // sentence about one amendment cite another's chunks.
  const amendments = [];
  if (wanted('amendments')) {
    for (const { ref, document } of amendmentDocs) {
      if (!hasExtractedText(document)) {
        // Quiet `no_text`, not `no_chunks`: an extracted document with no chunks is a real fault,
        // this is not.
        record('amendments', 'no_text', ref.documentId);
        continue;
      }
      const result = await run('amendments', document, {
        shape: SHAPES.amendment,
        instruction: INSTRUCTIONS.amendments,
        build: buildSentence
      });
      if (result && result.value) {
        amendments.push({ documentId: ref.documentId, ...result.value });
      }
    }
    // One entry naming every amendment that produced nothing, and why.
    if (amendmentErrors.size) {
      sectionErrors.amendments = Array.from(amendmentErrors,
        ([reason, ids]) => `${reason}: ${ids.join(', ')}`).join('; ');
    }
  }

  const nations = nationsResult && nationsResult.value
    ? joinNations(nationsResult.value, organizations)
    : null;

  const unmatched = (nations || []).filter(n => !n.organizationId)
    // The form the join actually compared, which is what a new `NATION_ALIASES` entry is keyed on.
    .map(n => ({ name: n.name, normalised: nationKey(n.name) }));
  if (unmatched.length) {
    // The input to the alias table. An unmatched name is not an error — it renders without a
    // contact card — but a growing list of them is the signal that the normalisation needs help.
    logger.info('[project-summary] nation names with no Organization row: ' +
      unmatched.map(u => `${u.name} (${u.normalised})`).join('; '), {
      projectId: String(projectId), unmatched
    });
  }

  const totalUsage = { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens };

  return {
    id: String(projectId),
    projectId: String(projectId),
    eagleId: project.eagleId ? String(project.eagleId) : null,
    generatedAt: now || new Date().toISOString(),
    // What the record may be shown to. The write route refuses a record that does not carry it.
    sourceAccess: SOURCE_ACCESS,
    // What actually ran, which is not necessarily what the cost was priced against.
    model: models.size ? Array.from(models).join(',') : null,
    pricedAs: PRICED_AS,
    promptVersion: PROMPT_VERSION,
    usage: totalUsage,
    estimatedCostCad: summarizer.estimateCostCad(usage) || 0,
    facts,
    sections: {
      status: status ? status.value : null,
      conditions: conditions && conditions.value
        ? { sourceDocumentId: conditions.documentId, ...conditions.value }
        : null,
      amendments: amendments.length ? amendments : null,
      timelineEvents: timelineEvents ? timelineEvents.value : null,
      compliance: compliance && compliance.value
        ? { sourceDocumentId: compliance.documentId, ...compliance.value }
        : null,
      nations,
      federal: federalSection(federalOrigin, federal, federalSource)
    },
    sectionErrors,
    sectionSources,
    citations: registry.list()
  };
}

module.exports = {
  generateProjectSummary,
  SECTIONS,
  PRICED_AS,
  SOURCE_ACCESS,
  QUIET_REASONS,
  // Exported for tests: each is a gate with its own failure mode, and each is worth pinning apart
  // from a whole-record run.
  buildFacts,
  sanitisePromptName,
  validCitations,
  groundedInCitations,
  normaliseNationName,
  joinNations,
  pickSource,
  isFrenchTitle,
  hasFullDate,
  buildItems,
  buildTimeline,
  PICK
};
