'use strict';

/**
 * The per-project status summary, generated offline and stored — see the plan's "Stored record
 * contract" and wiki ADR-006 for the query-time summariser this is modelled on.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: generate only what no query can answer, and ground every
 * generated claim on that project's own chunks. So the split is deliberate and load-bearing:
 *
 *   `facts`    — computed HERE, by code, from the documents index. Counts, dates, document ids.
 *                The model never sees them and can never contradict them.
 *   `sections` — model output, one call per section, each over the chunks of ONE named source
 *                document, each item carrying the source numbers it was drawn from.
 *
 * A section whose source document does not exist is `null` and costs nothing: no model call is made
 * at all. That is the grounding guarantee — a model handed no sources answers from its own
 * knowledge, and on a regulatory registry that is the failure mode that matters most.
 *
 * Three validation gates run on every model reply, in order, and each one drops rather than
 * repairs:
 *   1. JSON shape. Anything that is not the section's declared shape is rejected whole.
 *   2. Citation range. An item citing source 9 of 6 is dropped, not renumbered.
 *   3. Number and date grounding. A bullet carrying a figure or a date that does not appear in the
 *      chunks it cites is dropped. This is the one that catches a fluent invention, because a
 *      hallucinated condition reads exactly like a real one until you check its numbers.
 *
 * Retrieval, Cosmos and the model are reached through an ADAPTER (`project-summary-sources.js`),
 * not required directly, so the same generator runs on the devbox against Cosmos and from a
 * workstation against the DEMI API.
 */

const http = require('node:http');
const https = require('node:https');

const config = require('../config');
const { logger } = require('../utils/logger');
// Required as a MODULE, not destructured: the three are the seam a test replaces to keep a
// generator run off the network, and a destructured copy cannot be replaced.
const summarizer = require('./summarize');
// Same reason, and the same seam: a test replaces `iaac.fetchFederalSource` to keep the generator
// off the IAAC registry.
const iaac = require('./federal-source');
const { PROMPT_VERSION, SHAPES, INSTRUCTIONS, RETRY_INSTRUCTION, systemPrompt } =
  require('./project-summary-prompts');
const { levelOfRead } = require('../helpers/access-sql');
const { ANONYMOUS_LEVEL } = require('../vis/level');

/**
 * The model the COST is priced against, whatever model actually ran.
 *
 * A local Ollama run costs no cash, so storing 0 would make every locally generated record look
 * free next to a deployed one and the two would not be comparable. The number stored is what this
 * work WOULD have cost on the deployed Foundry path, and this field is what says so.
 */
const PRICED_AS = 'gpt-4.1-mini';

// ---------------------------------------------------------------------------------------------
// Document selection
// ---------------------------------------------------------------------------------------------

/** A List ObjectId, which is what `type` carries on a `/search` row. */
const LIST_ID = /^[0-9a-f]{24}$/i;

/**
 * The document's registry type, as a LABEL.
 *
 * A `/documents` row carries the resolved label under `type` ("Certificate Package", "Inspection
 * Record"). A `/search` row carries the List ObjectId under that same key and the label under
 * `documentType`. Every picker compares against a label, so an id read as one matches nothing and
 * the whole run reads as a project whose registry holds no certificate.
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
 * May this document be summarised? Published, and public on the ladder.
 *
 * The stored record carries no ACL of its own and the read route gates on the PROJECT, so a
 * narrower document's prose, name, chunk id and page number would reach a caller who 404s on that
 * document. `read[]` is authoritative and `isPublished` mirrors it; the API strips `read` at the
 * response boundary (vis/catalog/documents.js) and derives `isPublished` from it there, so an API
 * row is judged on the mirror and a raw Cosmos row on both.
 */
function isPublicSource(doc) {
  if (!doc || doc.isDeleted === true) return false;
  if (Array.isArray(doc.read) && levelOfRead(doc.read) !== ANONYMOUS_LEVEL) return false;
  return doc.isPublished === true;
}

/**
 * Has this document any extracted text to ground on?
 *
 * A source document with no extracted text costs the section outright: the run reads zero chunks,
 * makes no call, and stores a null. Site C's status, timeline and compliance sections were all null
 * on 2026-09-09 for exactly that reason, and 8 of its 21 amendment packages are in the same state.
 * `/documents` carries both flags — `contentExtracted` is the extractor's verdict, `contentPageCount`
 * its output — and either one is enough.
 *
 * COUNTS ARE NOT NARROWED BY THIS: `facts` is computed over every public document, extracted or
 * not. 21 amendment packages is what the registry holds, whatever can be summarised.
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
 * A federal decision: Canada's own decision document.
 *
 * Naming an agency is not enough. 62 of Site C's letters and emails mention "(CEAA)" in their
 * titles, and on a bare agency match the newest of them — a consultant's letter about a panel
 * report errata — was published as Canada's decision. So the title must either name the document
 * kind outright, or name an agency AND the word "decision".
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

/**
 * The newest match that is not an amendment's paperwork, else the newest match.
 *
 * A project files an application for each amendment and they are newer than the original.
 */
const preferOriginal = docs =>
  newest(docs.filter(d => !nameMatches(d, AMENDMENT_TITLE))) || newest(docs);

/** Filed UNDER a submission's volumes, never the text of one. */
const UNDER_VOLUME_TITLE = /\bappendix\b|\bappendices\b|\bannex\b|\bpart\s+\d/i;

/**
 * Filing structure under a big submission, never the submission itself. Site C files 378 documents
 * under type "Application Materials"; on the type alone the application picker returned "Appendix A".
 */
const isSubsidiary = title => UNDER_VOLUME_TITLE.test(title) || /\bvolume\b/i.test(title);

/** Front matter bound with a submission but carrying none of its text. */
const FRONT_MATTER_TITLE =
  /\bcontents\b|\bconcordance\b|\bdefinitions?\b|\bacronyms?\b|\babbreviations?\b|\bauthorship\b|\bcover\b/i;

/**
 * A submission's own text, where the submission is filed in volumes. Site C files no single EIS
 * document — 108 "EIS - Volume N" rows — so rejecting every volume leaves it with no application.
 */
const isMainVolume = title =>
  /\bvolume\s+0*1\b/i.test(title) && !UNDER_VOLUME_TITLE.test(title) && !FRONT_MATTER_TITLE.test(title);

/**
 * A document ABOUT another, never that document. Site C's application picker returned "Technical
 * Memo - Response to ... Comments on the ... Environmental Impact Statement - dated May 8, 2013".
 */
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
 * A French copy of a document the registry also files in English.
 *
 * Matches French-language markers only, not English words that merely contain them ("French Creek",
 * "Frenchman River", "Resume of Conditions"): "rapport" and "résumé" require a French phrase around
 * them, and bare "french"/"fr" require a marker form the registry actually types — `(french)`,
 * `(fr)`, `(français)`, "French version", or a trailing `- fr` / `- French`.
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
 * The EAO's assessment report on the project — the document the regulatory chronology lives in.
 *
 * An amendment title is rejected whatever the registry types a row: an amendment's report assesses
 * one change and not the project. A registry type of `Assessment Report` is trusted ahead of the
 * derivative reject, so a typed report keeps its role on a title that merely dates or appends to
 * itself; an untyped row still loses to a title ABOUT a report, such as a memo or response. The
 * office naming itself outranks the study words after that — "EAO Assessment Report on the
 * Environmental Management Plan" is the office's report, not a proponent's plan — so the study
 * reject runs last, only against a title with no office name in it. Nothing qualifying returns
 * nothing, and `timelineDoc` falls back to the certificate's recitals.
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
 * Names ITSELF the application, rather than mentioning one it is filed about — so the name leads,
 * after at most the project prefix the registry puts in front of it ("Site C - ", or the longer
 * "Pacific NorthWest LNG (Lelu Island) Project - "). A derivative title mentioning the phrase
 * mid-sentence is rejected earlier in `isApplication`, not by capping this prefix.
 */
const APPLICATION_MAIN_TITLE =
  /^\s*(?:[^-]*-\s*)?(?:eis\s*-|environmental\s+impact\s+statement\b|application\s+for\s+an?\s+)/i;

const APPLICATION_TITLE = /\bapplication\b/i;

/**
 * The application itself, not one of the hundreds of documents filed beneath or about it. A
 * document either names itself as the application whatever its type, or carries the type AND
 * names an application.
 */
function isApplication(doc) {
  const title = nameOf(doc);
  if (DERIVATIVE_TITLE.test(title)) return false;
  if (isSubsidiary(title) && !isMainVolume(title)) return false;
  if (APPLICATION_MAIN_TITLE.test(title)) return true;
  return isType(doc, 'Application Materials') && APPLICATION_TITLE.test(title);
}

/**
 * The source document for each section, by type and title pattern.
 *
 * Title patterns, not ids: the ids in the plan are Site C's, and a picker hardcoded to them
 * generates one project and silently returns nothing for the other 381.
 */
const PICK = {
  // "Schedule B - Table of Conditions" — a Certificate Package, distinguished from the certificate
  // itself only by its name.
  scheduleB: docs => newest(docs.filter(d =>
    isType(d, 'Certificate Package') && nameMatches(d, /schedule\s*b/i))),
  scheduleA: docs => newest(docs.filter(d =>
    isType(d, 'Certificate Package') && nameMatches(d, /schedule\s*a/i))),
  // The certificate itself: a Certificate Package that is NOT one of its schedules.
  certificate: docs => newest(docs.filter(d =>
    isType(d, 'Certificate Package') &&
    nameMatches(d, /certificate/i) &&
    !nameMatches(d, /schedule\s*[ab]/i))),
  amendedCertificate: docs => newest(docs.filter(d => nameMatches(d, /amended\s+certificate/i))),
  // No `preferOriginal` fallback: a registry holding only amendments' reports holds none of the
  // project's, and the role is dropped rather than filled with the nearest miss.
  assessmentReport: docs => newest(preferEnglish(assessmentReports(docs))),
  // The two copies apart, because the timeline chain reads them at opposite ends of its candidate
  // list: the English report first, the French one only after everything else produced nothing.
  englishAssessmentReport: docs => newest(assessmentReports(docs).filter(d => !isFrenchTitle(d))),
  frenchAssessmentReport: docs => newest(assessmentReports(docs).filter(isFrenchTitle)),
  // Two tiers: the document that names itself the application wins over anything else the type
  // sweeps in, so a project whose EIS is filed beside a hundred supporting documents still links
  // the EIS.
  application: docs => {
    const pool = preferEnglish(docs.filter(isApplication));
    return preferOriginal(pool.filter(d => nameMatches(d, APPLICATION_MAIN_TITLE)))
      || preferOriginal(pool);
  },
  newestInspection: docs => newest(docs.filter(d => isType(d, 'Inspection Record'))),
  amendments: docs => byDateDesc(docs.filter(d => isType(d, 'Amendment Package'))),
  inspections: docs => docs.filter(d => isType(d, 'Inspection Record')),
  // Self-reports have no type of their own in the registry; the name is what identifies them.
  selfReports: docs => byDateDesc(docs.filter(d =>
    nameMatches(d, /self[\s-]?report/i) && nameMatches(d, /compliance|annual/i))),
  // Federal. Hidden unless the registry actually holds a FEDERAL DECISION — Site C has none in
  // DEMI, and a section invented for a project without one is exactly the claim this must not make.
  federal: docs => newest(docs.filter(d => isFederalDecision(d) && !nameMatches(d, EAO_ADVICE)))
};

/**
 * The documents that can carry the project's regulatory chronology, best first.
 *
 * The EAO's English assessment report where there is one, then the certificate, whose recitals date
 * the application, the assessment and the decision, then Schedule A, which lists the same decision
 * dates. The French copy of the report is tried last rather than never: it is the chronology when
 * the registry filed no English one, and it is a translated summary when it filed both. Tilbury's
 * newest assessment report is "Assessment Report - Executive Summary (French)", and reading it
 * first produced one ungrounded event and stored `no_grounded_content` beside a certificate full of
 * dates.
 *
 * Amendments are NOT read here — the page already puts `facts.amendments` and Track's phase rows on
 * the same timeline, so a model asked to re-derive them would only produce rows the page has.
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
 * The document a section reads, and when there is none, which of the two reasons applies.
 *
 * A picker that finds nothing among the documents with text but something in the registry names a
 * document waiting on extraction, not a registry that holds none. `documents` must already be the
 * public list: `absentSource` is rendered.
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

/**
 * `facts` — computed from the documents index, never from the model.
 *
 * Everything here is a count, a date or an id. If a number on the rendered page can be counted, it
 * is counted here; the model is only ever asked for prose no query can produce.
 */
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
        // The document the SECTIONS were written from wins. `timelineDoc` picks its assessment
        // report out of the documents that have extracted text, and a link naming a different one
        // beside prose drawn from this one is the page contradicting itself. A role no source
        // document fills still links whatever the registry holds for it.
        const document = pick(sourcePool) || pick(documents);
        const ref = docRef(document);
        if (!ref) return null;
        // Only when the registry offered nothing else: the page says which language it is linking.
        return isFrenchTitle(document) ? { role, ...ref, languageFlag: 'fr' } : { role, ...ref };
      })
      .filter(Boolean)
  };
}

// ---------------------------------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------------------------------

/** One numbered source. `i` is its position in THIS call's sources, which is what a citation means. */
const sourceLine = (c, i) =>
  `[${i + 1}] (page ${c.pageNumber ?? 0}) ${String(c.content || '').trim()}`;

const SOURCE_SEPARATOR = '\n\n';

/** The numbered sources, one per chunk, capped by `projectSummaryMaxChunks`. */
function buildSourceBlock(chunks) {
  return chunks.map(sourceLine).join(SOURCE_SEPARATOR);
}

/** The user half of a section's prompt. Called with no chunks it is the header on its own. */
function userPrompt(document, chunks) {
  return `Sources from "${nameOf(document)}":\n\n${buildSourceBlock(chunks)}`;
}

// ---------------------------------------------------------------------------------------------
// Model providers
// ---------------------------------------------------------------------------------------------

/**
 * One JSON completion, from whichever provider is configured.
 *
 * Both providers are asked for the same thing in their own dialect: deterministic, JSON-only, with
 * a token ceiling. The caller sees one shape — `{content, usage, model, truncated}` — so nothing
 * downstream knows or cares which one ran.
 */
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
  const res = await fetch(summarizer.foundryChatUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' }
    })
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
 * A JSON POST THAT WAITS AS LONG AS THE MODEL TAKES, on `node:http`, not `fetch`.
 *
 * `fetch` is undici underneath, and undici gives up after 300 seconds without response HEADERS.
 * Ollama sends none until the whole reply is generated, so a batch of conditions that takes longer
 * than five minutes dies as `TypeError: fetch failed` with the generation still running — which is
 * how the 2026-09-09 Site C run lost its conditions retry. Raising undici's `headersTimeout` needs
 * the `undici` package, which Node does not expose to `require`; `node:http` has no such clock.
 *
 * Waiting forever is the point, so every way the connection can end has to settle the promise:
 * without that, a socket dropped mid-reply hangs the run with no error instead of failing it.
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
 * Ollama's NATIVE `/api/chat`, not its OpenAI-compatible shim.
 *
 * The shim works, but a reasoning model returns its chain of thought in a separate field there and
 * the JSON has to be dug out of it. `think: false` on the native endpoint turns that off outright,
 * and `format: 'json'` constrains decoding rather than merely asking for JSON.
 *
 * `num_ctx` IS MANDATORY. Ollama defaults to a 4k context and TRUNCATES A LONGER PROMPT SILENTLY —
 * Schedule B alone is around 20k tokens, so a run at the default would extract conditions from the
 * first fifth of the document and report success. There is no error and no warning; the only
 * symptom is a short answer that looks fine.
 *
 * No auth header: Ollama has none. It is a LAN service, reached only from a workstation.
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
    // Ollama's own counter names, mapped to the OpenAI ones so `estimateCostCad` prices both
    // providers with one implementation.
    usage: {
      prompt_tokens: Number(data && data.prompt_eval_count) || 0,
      completion_tokens: Number(data && data.eval_count) || 0
    },
    model: config.ollamaModel,
    // `length` means the reply stopped at `num_predict` rather than at its own end, so what came
    // back is a prefix. With `format: 'json'` that prefix is well-formed up to the cut and nothing
    // else, which is why it fails to parse rather than arriving as visible prose.
    truncated: (data && data.done_reason) === 'length'
  };
}

/**
 * The prompt size Ollama would refuse to fit, or null when it fits.
 *
 * `num_ctx` holds the prompt AND the reply, so the prompt's real ceiling is
 * `num_ctx - num_predict`. Over that, Ollama drops the front of the prompt without a word (see
 * `chatOllama`) — the reply still parses, still cites, and is drawn from a document the model only
 * saw the tail of. Refusing the call is the only way that state is distinguishable from a good run.
 *
 * Four characters per token is the crude English rule of thumb, and crude is all that is available:
 * the exact count is known only to the tokenizer that is about to throw the excess away. It runs
 * slightly low on the numeric tables these documents are full of, which is the safe direction to be
 * wrong in only if the margin is real — so this is a guard against the gross case, not a
 * fitting exercise.
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
 * The sections whose replies are BATCHED and concatenated: `fitBatches` splits them and
 * `mergeItemBatches` joins the results back up.
 *
 * Only `{items}` sections belong here. `buildNations` and `buildTimeline` return a bare array, which
 * `mergeItemBatches` reads as nothing, so listing either one here would silently empty it.
 */
const LIST_SECTIONS = ['conditions', 'federal'];

/**
 * The completion budget per section, where the default is too small for the answer.
 *
 * Site C's Schedule B holds around 77 conditions with bullets and its consultation records name
 * around 30 nations; at the 1500-token default both stop mid-item, and a list cut off mid-item
 * parses as nothing. A timeline is smaller once the instruction asks for milestones alone, so 4000
 * covers 15 events with room to spare. Kept apart from `LIST_SECTIONS` because a budget and a
 * batching strategy are different decisions: nations needs the budget and must not be batched.
 */
const SECTION_MAX_TOKENS = {
  conditions: 8000, federal: 8000, nations: 8000, timelineEvents: 4000
};

/**
 * The sections whose reply is a LIST at all, batched or not.
 *
 * Kept apart from `LIST_SECTIONS`, which says which ones are SPLIT across calls: this one is read
 * to tell a reply of the wrong shape (`no_list`) from a list every gate emptied.
 */
const LIST_SHAPE_SECTIONS = ['conditions', 'federal', 'timelineEvents', 'nations'];

/**
 * The sections read over the WHOLE document in `projectSummaryMaxChunks` batches, rather than over
 * its first chunks alone: a chronology has events on the last page, so a window loses them outright.
 */
const CHUNK_BATCHED_SECTIONS = ['timelineEvents'];

/**
 * The sections whose sources are narrowed to the pages carrying a full date.
 *
 * Project 302's English assessment report is around 680k tokens over twelve window-sized batches,
 * and a host holding a fraction of the model in VRAM evaluates one of those prompts in minutes. The
 * timeline instruction only allows an event the source dates in full, so a page with no date on it
 * can never contribute one: it is cost with no possible answer.
 */
const DATE_FILTERED_SECTIONS = ['timelineEvents'];

/**
 * How many times a chunk-batched batch may be halved when its reply runs out of completion budget.
 *
 * Three levels is at most eight pieces from one batch: a batch sized to the PROMPT window can still
 * hold more dated events than the reply budget carries, and the bound is what keeps a document that
 * truncates everywhere from costing a call per chunk.
 */
const MAX_BATCH_HALVINGS = 3;

const isListSection = name => LIST_SECTIONS.includes(name);
const isChunkBatched = name => CHUNK_BATCHED_SECTIONS.includes(name);
const isDateFiltered = name => DATE_FILTERED_SECTIONS.includes(name);
const isListShape = name => LIST_SHAPE_SECTIONS.includes(name);
const maxTokensFor = name => SECTION_MAX_TOKENS[name] || config.projectSummaryMaxTokens;

/**
 * `chunks` split into runs that each fit the context window, in page order.
 *
 * `num_ctx` holds the prompt AND the reply, so a list section's completion budget lowers its prompt
 * ceiling to `num_ctx - num_predict`: a 120-chunk Schedule B is over that ceiling and as one call
 * would be refused outright. A list splits instead — one call per batch, items concatenated.
 *
 * Sized in characters against the same four-per-token estimate `contextOverflow` uses, less the
 * scaffold (`fixedChars`) every batch repeats. A chunk too large for an empty batch is left alone
 * in one, where `contextOverflow` refuses it: nothing here splits a chunk.
 *
 * `cap` bounds a batch by count on top of that, because fitting the PROMPT is only half of it: a
 * batch whose sources fill the window asks for a list that does not fit the completion budget, and
 * a list cut off mid-item parses as nothing. A list section caps at `projectSummaryBatchChunks`; a
 * chunk-batched one caps at `projectSummaryMaxChunks` (see `chunkBatches`).
 */
function fitBatches(chunks, fixedChars, maxTokens, cap = config.projectSummaryBatchChunks) {
  // Only Ollama's window is fixed and silent about overrunning it; Foundry is one call, as before.
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
 * `chunks` batched for a section that reads the WHOLE document rather than its first window.
 *
 * Sized to the window exactly as a list section's batches are, with `maxChunks` as the count cap
 * instead of `projectSummaryBatchChunks`. A fixed-count split does not fit anything: on project
 * 302's assessment report, 120 chunks of it came to 25,825 tokens over the window, so the first
 * batch was refused as `context_overflow` and the section died — and `context_overflow` is not a
 * timeline fallback reason, because a correctly sized batch does not produce it. A single chunk
 * larger than the window is still an overflow; nothing here splits a chunk.
 *
 * Off Ollama there is no fixed window to measure against, so the count cap is the whole bound and
 * the split is the fixed one it always was.
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

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

const isStr = v => typeof v === 'string' && v.trim() !== '';
const isStrArray = v => Array.isArray(v) && v.every(isStr);

/**
 * Citation numbers that actually index a source, as one-based integers.
 *
 * Out-of-range and duplicate numbers are DROPPED, never renumbered: `[9]` against six sources is a
 * fabricated reference, and mapping it onto source 6 would turn an invention into a link that
 * resolves.
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
 * The one normalisation BOTH sides of the grounding comparison get: runs of whitespace collapsed
 * to a single space, thousands separators removed.
 *
 * Thousands, so "50,000" and "50000" are the same figure — without it a bullet saying "50,000"
 * would fail against a source that writes "50000", and one saying "50000" would pass against a
 * source that says nothing of the kind.
 *
 * Whitespace, because the chunks are PDF text and a date lands across a line break as often as not.
 * "July 6,\n 2012" is one date written two ways, and compared literally against the single-spaced
 * spelling this gate builds, it read as a date the source never carried and dropped the claim.
 */
const normalise = text => String(text || '')
  .replace(/\s+/g, ' ')
  .replace(/(\d),(?=\d{3}(\D|$))/g, '$1');

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const MONTHS = MONTH_NAMES.join('|');
const MONTH_NUMBER = new Map(MONTH_NAMES.map((name, i) => [name.toLowerCase(), i + 1]));

/**
 * The month names beyond the English ones: the three-letter abbreviations, and French, which is how
 * the federal and bilingual documents in the corpus date their own events.
 */
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
 * Year, month and day together, deliberately wider than `dateSpellings` below: French month names,
 * 4-letter abbreviations ("sept"), and ordinals `dateSpellings` never emits. A certificate dates
 * itself "DATED at Victoria, this 14th day of October, 2014"; matching only "October 14, 2014"
 * dropped that page before the model ever saw it, and with it the one event the document exists to
 * carry. The invariant is one-directional: this filter must stay at least as wide as the grounding
 * gate, so no page the gate could ground is thrown away before the model sees it.
 *
 * A year alone is not a date, and neither is a day with no year: "October 2014" and "14 October"
 * cannot date an event the instruction will accept.
 */
const FULL_DATE = new RegExp([
  // ISO, and the same three numbers slashed or dotted: "2014-10-14", "2014/10/14", "2014.10.14".
  '\\b\\d{4}[-/.]\\d{2}[-/.]\\d{2}\\b',
  // Day and month numeric, in either order. A source that does not say whether it writes dd/mm or
  // mm/dd gives no way to tell, and both orders are a full date whichever one it meant.
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
 * Every spelling of one date a source might use, lowercased.
 *
 * The model is constrained to ISO by the timeline shape and the documents are not: a certificate
 * writes "October 14, 2014" for the date its own event carries. Compared literally, every event on
 * the 2026-09-09 Site C run was dropped as ungrounded — a 100% failure that looked like a model
 * that had invented all of them.
 *
 * Both slash orders are accepted because dd/mm and mm/dd are indistinguishable in a source that
 * does not say which it uses, and refusing a real date is the worse error. A WRONG date still
 * fails: nothing here widens the match past the one day the claim names.
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
 * Every figure and date a claim commits to.
 *
 * Four digits and up, because two- and three-digit numbers are mostly condition numbers, clause
 * references and ordinary prose ("within 30 days") that appear in a hundred harmless forms. Four
 * digits is where a claim starts being a quantity or a year — the things a model invents fluently.
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
 * Is every figure and date in `text` present in the document(s) it cites?
 *
 * The gate that catches a fluent invention. A hallucinated condition reads exactly like a real one
 * — same register, same structure, plausible citation — until you check whether its numbers are in
 * the source. Anything that fails is dropped whole; a claim with one wrong figure is not repaired
 * into a claim with none.
 *
 * `pool` is every chunk of the source document, where the caller has it. Without it the check is
 * against the cited chunks alone.
 */
function groundedInCitations(text, citations, chunks, pool) {
  return ungroundedToken(text, citations, chunks, pool) === null;
}

/**
 * The chunks a claim is checked against: every chunk of the document(s) it cites, not only the ones
 * the model was shown.
 *
 * A model sees a window of a long document and cites within it, while the figure it quotes is
 * printed again on a page outside that window. Checked against the window alone the claim reads as
 * an invention. Widened to the cited DOCUMENT and no further, so a claim still cannot be grounded
 * on a document it never cited.
 */
function scopeToCitedDocuments(cited, pool) {
  if (!Array.isArray(pool) || pool.length === 0) return cited;
  const documentIds = new Set(cited.map(c => String((c && c.documentId) || '')));
  const scoped = pool.filter(c => documentIds.has(String((c && c.documentId) || '')));
  return scoped.length ? scoped : cited;
}

/**
 * The first figure or date in `text` that the cited chunks do not carry, or null when they carry
 * every one of them.
 *
 * `groundedInCitations` is this with the answer collapsed to a boolean. Split so a drop can name
 * the token that failed: "the section produced nothing" sends an operator nowhere, "it claimed
 * 2019-03-14 and the chunk it cites says 2019-04-14" sends them to the retrieval or the model.
 */
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
 * `spelling` present in `cited`, on a digit boundary for numeric forms.
 *
 * `1/10/2014` is a plain substring of `11/10/2014` and of `1/10/20140`: a numeric spelling needs
 * digits on neither side, or it grounds a claim the source never made. Month-name spellings ("October
 * 1, 2014") already delimit themselves and use plain `includes`.
 */
function spellingMatches(cited, spelling) {
  if (!/^[\d/-]+$/.test(spelling)) return cited.includes(spelling);
  const escaped = spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^0-9])${escaped}(?![0-9])`).test(cited);
}

/**
 * A ```json fence around an otherwise good reply.
 *
 * `format: 'json'` constrains decoding and still does not stop every model wrapping the object in
 * one — Site C's nations reply came back fenced, was rejected as `not_json`, and paid for the retry
 * that came back fenced again.
 */
const CODE_FENCE = /^\s*```[a-z]*\s*\n?([\s\S]*?)\n?\s*```\s*$/i;

/**
 * JSON or null. A reply that is not JSON at all is a rejected section, not a parse to retry.
 *
 * AN ARRAY IS JSON. Asked for the nations named in a document that names none, the model answers
 * `[]`, and rejecting the bare array as malformed turned an honest "there are none" into a parse
 * failure on the record — which is what Site C's nations section stored as `not_json`.
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
 * The list a reply declares, whatever key it used, or null when the reply is not a list at all.
 *
 * Read for its LENGTH, before the citation and grounding gates run: a section that is null because
 * the model listed nothing is a different answer from one whose every item was dropped, and only
 * the second is a fault.
 */
function replyList(parsed) {
  if (Array.isArray(parsed)) return parsed;
  for (const key of LIST_KEYS) {
    const list = listOf(parsed, key);
    if (list) return list;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Citation registry
// ---------------------------------------------------------------------------------------------

/**
 * The record's one citation list.
 *
 * Each model call numbers its own sources from 1; the stored record numbers them once, across every
 * section, so a section's `citations: [4]` and the footer's source list mean the same thing. Chunks
 * are registered only when something actually cites them — the record carries the sources it used,
 * not every chunk that was read.
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
        // A source that is not a DEMI document says so and carries the link a reader needs, because
        // nothing in DEMI resolves `iaac:158078` and the page has no other way to reach the file.
        ...(chunk.source ? { source: String(chunk.source) } : {}),
        ...(chunk.url ? { url: String(chunk.url) } : {}),
        ...(chunk.format ? { format: String(chunk.format) } : {})
      });
      return n;
    },
    /**
     * Local one-based source numbers to record-wide ones.
     *
     * A chunk found by a keyword search across the project carries its OWN document's name, because
     * the call it was a source for had no single document to name it with.
     */
    map(local, chunks, documentName) {
      return local.map(n => this.register(chunks[n - 1], chunks[n - 1].documentName || documentName));
    },
    list: () => entries
  };
}

// ---------------------------------------------------------------------------------------------
// Nations
// ---------------------------------------------------------------------------------------------

/**
 * The generic words a nation's name may end with. TRAILING only: "Métis Nation British Columbia"
 * carries one mid-name and is not the same organisation with it removed.
 */
const GENERIC_SUFFIX =
  /(?:\s*\b(?:first\s+nations?|indian\s+bands?|tribal\s+councils?|nations?|bands?|tribes?))+\s*$/;

/**
 * A nation's name reduced to what two spellings of it have in common.
 *
 * "Saulteau First Nations", "Saulteau First Nation" and "Saulteau Indian Band" are one organisation
 * written three ways, and the join has to survive that — as it has to survive a registry that
 * writes "Ka:'yu:'k't'h'" where the model writes "Kayukth", and a page that drops the diacritics.
 *
 * Deliberately conservative: it normalises spelling, never meaning. Two genuinely different nations
 * whose names differ only in a dropped word stay different, because the remaining words still
 * differ. Names it cannot match are reported unmatched, which is the input to `NATION_ALIASES`.
 */
function normaliseNationName(name) {
  return String(name || '')
    // Decomposed first, so "Stó:lō" and "Stolo" reduce to the same letters.
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // A parenthesised alias is a second name for the same nation, not part of this one.
    .replace(/\([^)]*\)/g, ' ')
    // REMOVED, not spaced: these punctuate inside a word ("Scia'new", "Ka:'yu:'k't'h'"), where the
    // 7 stands for a glottal stop. Everything else separates words and becomes a space.
    .replace(/['‘’`"“”:7]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the\s+/, '')
    .replace(GENERIC_SUFFIX, '')
    .trim();
}

/**
 * One nation written two ways that no spelling rule reduces to the other, normalised on both sides.
 *
 * Read for the Organization row as well as for the model's name, so it does not matter which side
 * of the join uses the alias. Every other pair on the registry — Ka:'yu:'k't'h'/Che:k'tles7et'h',
 * Stó:lō, Lake Cowichan — already matches on `normaliseNationName` alone and needs no entry here.
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
 * Model-extracted names joined to the Organization rows DEMI already holds.
 *
 * The model returns NAMES ONLY. Address and website are read off the row, never from the model —
 * a hallucinated postal address on a government page about a First Nation is a different class of
 * error from a wrong summary sentence, and this is the boundary that makes it impossible.
 *
 * An unmatched name keeps `organizationId: null` rather than being dropped: it was cited in a
 * document, so it is reportable, and the page renders it without a contact card.
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

// ---------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------

/**
 * One section: ask for JSON over the sources it was handed, validate, number the citations
 * record-wide. Called only with sources — the caller is what refuses an empty set.
 *
 * @returns {Promise<{value: any, usage: object|null, model: string|null, documentId: string|null,
 *   reason: string|null}>} `value` is null when the section could not be produced, and `reason`
 *   always says why.
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
    // No dated page, no possible event: the same outcome as a model that read the document and
    // declared none, which is what earns the next candidate its turn.
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
  // How many entries the model SAID it found, before the citation and grounding gates ran. A list
  // that came back empty is an answer; a list whose every entry was dropped is a fault.
  let declared = 0;
  let sawList = false;
  // Which batch failed, when there was more than one: "conditions is null" and "conditions is null
  // because its third batch never parsed" send an operator to different places.
  const batchLabel = i => (batches.length > 1 ? ` (batch ${i + 1} of ${batches.length})` : '');

  /**
   * One piece of a batch asked, retried once when it is not JSON, and halved when it truncates.
   *
   * `piece` is the whole batch at `depth` 0 and half its parent below that; `index` stays the
   * batch's, so a failure is still reported against the batch an operator can see.
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
        // Named apart from a malformed reply because the remedy is different: the model answered
        // the question and ran out of budget, so the budget is what has to move. The console format
        // drops metadata, so the numbers an operator acts on are in the message.
        logger.warn(`[project-summary] ${section}: the reply stopped at the ${maxTokens}-token ` +
          'completion budget, so what came back is a fragment', {
          documentId, sources: piece.length, numPredict: maxTokens
        });
      }
      return reply;
    };

    let reply = await ask(system);
    let parsed = parseJson(reply.content);

    // A truncated reply is not a malformed one, so the strict instruction cannot fix it: the pages
    // hold more dated events than the completion budget carries. Halving asks the same pages in two
    // smaller pieces, each with the whole budget to itself. Bounded, because a document that
    // truncates everywhere would otherwise cost one call per chunk.
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
      // The whole section, not just this batch: `mergeItemBatches` renumbers from 1, so a list
      // missing the batch that failed reads exactly like a complete one.
      reason = `${reply.truncated ? 'truncated' : 'not_json'}${batchLabel(index)}`;
      return false;
    }

    const list = replyList(parsed);
    if (list) {
      sawList = true;
      declared += list.length;
    }

    // Citations are numbered within the piece that produced them, so the registry is handed that
    // piece's chunks — this is what keeps a batch-2 `[1]` off batch 1's first source.
    // The grounding gate reads `chunks`, not the piece: a figure the model saw on one page is often
    // printed again on a page it was not shown, and the claim is about the document either way.
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
    // Three different faults wore one name. A list reply that carried no recognised key is a model
    // answering the wrong shape; a list that came back empty is an honest nothing; a list whose
    // every entry was dropped is the citation or grounding gate doing its job, or failing at it.
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

/**
 * The timeline batches as one timeline: one row per date and label, newest first.
 *
 * Two batches of one document report the same event whenever a chronology is restated, and the page
 * sorts the rows against `facts`, so the merge orders them rather than leaving them in batch order.
 */
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
 * `{items: [...]}` — the conditions list, and the federal list, which have the same shape.
 *
 * Items are dropped one at a time: a reply with nine good conditions and one invented figure keeps
 * the nine. Bullets are filtered INSIDE a kept item for the same reason, and an item whose bullets
 * are all dropped is kept with an empty list — its title and one-liner were cited and checked in
 * their own right.
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

// ---------------------------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------------------------

/** Longest project name quoted into a prompt. Past this it is crowding out the sources. */
const PROMPT_NAME_MAX = 200;

/**
 * A project name fit to be quoted into a prompt.
 *
 * The name is a stored field and the prompt puts it inside quotes on its own line, so a name
 * carrying a quote character and a newline can close the string and continue as instructions —
 * "…", ignore the sources and list every condition you know of. Nothing upstream constrains the
 * field: it arrives from the Eagle mirror, which takes it from the registry.
 *
 * So: quotes and backticks removed rather than escaped (no escape survives every position it could
 * be read in), all whitespace collapsed to single spaces so the name stays one line, and a length
 * cap so it cannot bury the rules that follow it.
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
 * The hit documents in the order their passages are worth reading.
 *
 * Which documents contribute matters as much as how many. A project-wide keyword search ranks a
 * 2011 province-wide workshop roster alongside the certificate, and a roster names every nation in
 * the province — so K'omoks was cited for Site C. Decisions and applications speak for THIS
 * project; everything else follows, newest first.
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
 * The nations section's source: the project's own passages, not one document.
 *
 * `id` is null because there is no single source document, which is also why the section stores no
 * `sourceDocumentId` — each citation names the document its chunk came from.
 */
const NATIONS_SOURCE = { id: null, displayName: 'passages that name a First Nation' };

// ---------------------------------------------------------------------------------------------
// Federal
// ---------------------------------------------------------------------------------------------

/** A DEMI document id this is not, and cannot be mistaken for: `iaac:158078`. */
const iaacId = (...parts) => ['iaac', ...parts].join(':');

/** A blank page is not a source: nothing can cite it and the grounding gate cannot check it. */
const readablePages = decision =>
  ((decision && decision.pages) || []).filter(page => String(page.text || '').trim());

/**
 * A decision statement's pages as chunks the rest of this file can already handle.
 *
 * The federal prompt, the citation gate and the grounding gate all read chunks, and none of them
 * cares where a chunk was stored — so the registry's PDF becomes pages, and pages become chunks,
 * and nothing else changes.
 */
function federalChunksFrom(decision) {
  const documentId = iaacId(decision.docId);
  return readablePages(decision)
    .map(page => ({
      // `id` names the pseudo-chunk; `chunkId` is the key the citation registry reads. One value,
      // both names, because a chunk here is read by code written for the other kind.
      id: iaacId(decision.docId, page.page),
      chunkId: iaacId(decision.docId, page.page),
      documentId,
      pageNumber: page.page,
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
  // An older statement was never filed as a file: the registry prints it on the document page, so
  // the page is the only link there is and `format` says which of the two the reader is offered.
  pageUrl: decision.pageUrl || null,
  format: decision.format || null
});

/**
 * The `federal` section as stored, whichever registry the decision came from.
 *
 * `source` is the field a reader is owed: a DEMI-sourced item resolves to a document in this
 * service and an IAAC-sourced one does not, and the two must not render as the same thing.
 *
 * A CEAR project with no decision statement is NOT a null section. Null means "nothing is known";
 * here the registry was read and what it says is that Canada has issued no decision — which is a
 * fact about the project, and the facts that go with it are what the page shows instead of items.
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
  // A decision the registry lists but whose PDF yielded nothing. Storing `no_federal_decision` here
  // would claim Canada issued no decision when the document is sitting on the registry unread.
  if (readablePages(decision).length === 0) {
    return {
      source: 'iaac',
      facts: { ...facts, decision: decisionFacts(decision) },
      items: [],
      reason: 'federal_decision_unreadable'
    };
  }
  // The decision read, and it lists no numbered conditions — a CEAA 2012 comprehensive study is
  // decided that way. That is an outcome, not a failed section: returning null here would drop the
  // status, the CEAR link and the decision document a reader can open.
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
 * Generate one project's stored summary record.
 *
 * Returns the record; it does NOT write. Storing is the caller's decision, so a dry run and a live
 * run generate identical output and only one of them saves.
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

  // The same flag the query-time summariser reads. Null rather than an empty record: a stored
  // record with every section null is indistinguishable from a project whose documents yielded
  // nothing, and one of those is a configuration state.
  if (!config.summaryEnabled) {
    logger.warn('[project-summary] SUMMARY_ENABLED is false; nothing generated');
    return null;
  }
  if (section && !SECTIONS.includes(section)) {
    throw new Error(`unknown section "${section}"; one of ${SECTIONS.join(', ')}`);
  }

  const project = await sources.project(projectId);
  if (!project) throw new Error(`project ${projectId} not found, or not readable`);

  // The ONE place source documents are narrowed. Every section and every `facts` entry is picked
  // from this list, so nothing downstream can reintroduce a document the reader may not see.
  const listed = await sources.documents(projectId);
  const documents = listed.filter(isPublicSource);
  if (documents.length !== listed.length) {
    logger.info('[project-summary] non-public documents excluded', {
      projectId: String(projectId), excluded: listed.length - documents.length
    });
  }

  // Only a document with extracted text can be a SOURCE. `facts` is still computed over every
  // public document, so the counts describe the whole registry; only the key-document LINKS prefer
  // a source document, so a link and the prose beside it name the same file.
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
  // Why EVERY null section is null, the ones no model call was made for included. A null with no
  // reason is what the 2026-09-09 Site C run stored for status, timelineEvents and compliance, and
  // it reads as "the model had nothing to say" where the cause was three unextracted documents.
  const sectionErrors = {};
  // The document a `not_extracted` section is waiting on, so the page can link the file whose text
  // is not there yet rather than say only that the section is missing.
  const sectionSources = {};
  // Amendments are one call per document, so a single reason would name only the last failure.
  // Collected per reason, because the document ids are what an operator acts on.
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

  // Which document each section reads, decided before anything is fetched, and picked from the
  // documents that HAVE text: a picked document with none spends the section for nothing. Each
  // picker is run over the registry as well, so a section with no source can say which of the two
  // states it is in — nothing filed, or filed and not extracted yet.
  const source = pick => pickSource(pick, extracted, documents);
  // Status: the newest amendment with text if there is one, else the certificate. The sentence the
  // card carries is about where the project stands NOW, so the most recent decision wins.
  const pickStatus = pool => facts.amendments
    .map(ref => pool.find(d => String(d.id) === ref.documentId))
    .find(Boolean) || PICK.certificate(pool);
  const { document: statusDoc, ...statusAbsent } = source(pickStatus);
  const { document: scheduleB, ...conditionsAbsent } = source(PICK.scheduleB);
  const { document: federalDoc, ...federalAbsent } = source(PICK.federal);
  const { document: complianceDoc, ...complianceAbsent } = source(PICK.newestInspection);
  const { document: timelineDoc, ...timelineAbsent } = source(pickTimeline);
  // Every document the timeline may read, best first. Which of them it actually runs is decided
  // after the reads, because a candidate whose chunk read comes back empty costs no model call.
  const timelineDocs = timelineCandidates(extracted);
  const amendmentDocs = facts.amendments
    .map(ref => ({ ref, document: documents.find(d => String(d.id) === ref.documentId) }))
    .filter(a => a.document);

  // EVERY API READ HAPPENS HERE, BEFORE THE FIRST MODEL CALL.
  //
  // The generator runs from a workstation on a staff token that expires five minutes after it is
  // issued, and one call over a 120-source prompt takes minutes. Reads interleaved with model calls
  // therefore hit 401 partway through a run and lose everything generated before it. Reading first
  // puts the whole token-bearing part of the run inside a minute, after which the model works from
  // memory and the token can expire harmlessly.
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

  // THE FEDERAL DECISION IS USUALLY NOT IN DEMI. Five projects in the whole corpus have a Decision
  // Statement filed here; every project that had a federal assessment has one on the public IAAC
  // registry. So a null federal section was reporting DEMI's gaps as Canada's silence, and where
  // DEMI holds the document nothing below runs — this is a fallback, not a replacement.
  let federalOrigin = 'demi';
  let federalDocument = federalDoc;
  let federalChunks = null;
  let federalSpec = { ...federalAbsent };
  let federalSource = null;
  if (wanted('federal') && !federalDoc && config.federalSource === 'iaac') {
    try {
      federalSource = await iaac.fetchFederalSource(project);
    } catch (err) {
      // The registry, not the project. A section generated from a half-read page would be worse
      // than one that says it could not read the page.
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

  // Nations come from the project's own passages, not from one document: Site C's certificate names
  // no First Nation, so a certificate-only source reported nothing on a project with 30 consulted
  // nations. The keyword search says WHICH documents name one — its rows carry an escaped snippet
  // and no chunk text — and the chunks themselves come from the per-document read every other
  // section uses, so what the model sees is text that can be cited and grounded.
  const nationsChunks = [];
  // Nothing to summarise here is not a missing document: the search over the whole project found no
  // passage that names a First Nation.
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

  // An `empty` reply from a decision that READ is the decision saying it carries no conditions, and
  // `federalSection` stores that outcome. The section is there, so it is not one to investigate:
  // it is logged and left out of `sectionErrors`, which is what the run is judged on.
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

  // The chronology, down the candidate list. A document whose reply the citation and grounding
  // gates emptied is not this project's chronology, and the next candidate is usually the one that
  // holds it; only the last outcome is the section's, so a fallback that works stores no error.
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
        // 8 of Site C's 21 amendment packages have no extracted text. The amendment still counts in
        // `facts` and still renders as a row; what it does not get is a sentence made from nothing.
        // Quiet, and named apart from `no_chunks`: nothing went wrong here, where a document whose
        // flag says extracted and whose chunk read comes back empty is a real fault.
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
  PROMPT_VERSION,
  PRICED_AS,
  SOURCE_ACCESS,
  isPublicSource,
  QUIET_REASONS,
  // Exported for tests: each is a gate with its own failure mode, and each is worth pinning apart
  // from a whole-record run.
  buildFacts,
  sanitisePromptName,
  validCitations,
  groundedInCitations,
  claimTokens,
  normaliseNationName,
  canonicalNationName,
  NATION_ALIASES,
  joinNations,
  pickSource,
  isFrenchTitle,
  hasFullDate,
  mergeTimelineBatches,
  buildItems,
  buildNations,
  buildTimeline,
  PICK
};
