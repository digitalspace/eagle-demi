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

const config = require('../config');
const { logger } = require('../utils/logger');
// Required as a MODULE, not destructured: the three are the seam a test replaces to keep a
// generator run off the network, and a destructured copy cannot be replaced.
const summarizer = require('./summarize');
const { PROMPT_VERSION, SHAPES, INSTRUCTIONS, systemPrompt } = require('./project-summary-prompts');

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

/**
 * The document's registry type.
 *
 * `type` is what the DEMI row carries (a resolved List label — "Certificate Package", "Inspection
 * Record"); `documentType` is what an upstream caller may hand us. Reading both means the picker
 * does not care which shape the adapter returned.
 */
const typeOf = doc => String((doc && (doc.type || doc.documentType)) || '');
const nameOf = doc => String((doc && (doc.displayName || doc.documentFileName)) || '');
const dateOf = doc => String((doc && doc.datePosted) || '');

const isType = (doc, type) => typeOf(doc).toLowerCase() === type.toLowerCase();
const nameMatches = (doc, re) => re.test(nameOf(doc));

/** Newest by `datePosted`. A row with no date sorts last rather than winning on a blank string. */
function newest(docs) {
  const dated = docs.filter(dateOf);
  const pool = dated.length ? dated : docs;
  return pool.slice().sort((a, b) => dateOf(b).localeCompare(dateOf(a)))[0] || null;
}

function byDateDesc(docs) {
  return docs.slice().sort((a, b) => dateOf(b).localeCompare(dateOf(a)));
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
  assessmentReport: docs => newest(docs.filter(d =>
    isType(d, 'Assessment Report') || nameMatches(d, /assessment\s+report/i))),
  application: docs => newest(docs.filter(d =>
    isType(d, 'Application Materials') || nameMatches(d, /application\s+(materials|for an?)/i))),
  newestInspection: docs => newest(docs.filter(d => isType(d, 'Inspection Record'))),
  amendments: docs => byDateDesc(docs.filter(d => isType(d, 'Amendment Package'))),
  inspections: docs => docs.filter(d => isType(d, 'Inspection Record')),
  // Self-reports have no type of their own in the registry; the name is what identifies them.
  selfReports: docs => byDateDesc(docs.filter(d =>
    nameMatches(d, /self[\s-]?report/i) && nameMatches(d, /compliance|annual/i))),
  // Federal. Hidden unless the registry actually holds one — Site C has none in DEMI, and a
  // section invented for a project with no federal decision is exactly the claim this must not make.
  federal: docs => newest(docs.filter(d =>
    nameMatches(d, /decision\s+statement/i) || nameMatches(d, /joint\s+review\s+panel/i)))
};

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

/**
 * `facts` — computed from the documents index, never from the model.
 *
 * Everything here is a count, a date or an id. If a number on the rendered page can be counted, it
 * is counted here; the model is only ever asked for prose no query can produce.
 */
function buildFacts(documents) {
  const inspections = PICK.inspections(documents);
  const selfReports = PICK.selfReports(documents);

  return {
    documentTotal: documents.length,
    amendments: PICK.amendments(documents).map(docRef),
    inspections: { count: inspections.length, latest: docRef(newest(inspections)) },
    selfReports: { count: selfReports.length, latest: docRef(selfReports[0] || null) },
    keyDocuments: KEY_DOCUMENT_ROLES
      .map(([role, pick]) => {
        const ref = docRef(pick(documents));
        return ref ? { role, ...ref } : null;
      })
      .filter(Boolean)
  };
}

// ---------------------------------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------------------------------

/** The numbered sources, one per chunk, capped by `projectSummaryMaxChunks`. */
function buildSourceBlock(chunks) {
  return chunks
    .map((c, i) => `[${i + 1}] (page ${c.pageNumber ?? 0}) ${String(c.content || '').trim()}`)
    .join('\n\n');
}

// ---------------------------------------------------------------------------------------------
// Model providers
// ---------------------------------------------------------------------------------------------

/**
 * One JSON completion, from whichever provider is configured.
 *
 * Both providers are asked for the same thing in their own dialect: deterministic, JSON-only, with
 * a token ceiling. The caller sees one shape — `{content, usage, model}` — so nothing downstream
 * knows or cares which one ran.
 */
async function chatJson(system, user) {
  return config.projectSummaryProvider === 'ollama'
    ? chatOllama(system, user)
    : chatFoundry(system, user);
}

async function chatFoundry(system, user) {
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
      max_tokens: config.projectSummaryMaxTokens,
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
    model: config.foundryDeployment
  };
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
async function chatOllama(system, user) {
  const res = await fetch(`${config.ollamaUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ollamaModel,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      stream: false,
      format: 'json',
      think: false,
      options: {
        temperature: 0,
        num_ctx: config.projectSummaryOllamaCtx,
        num_predict: config.projectSummaryMaxTokens
      }
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ollama ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  return {
    content: (data && data.message && data.message.content) || '',
    // Ollama's own counter names, mapped to the OpenAI ones so `estimateCostCad` prices both
    // providers with one implementation.
    usage: {
      prompt_tokens: Number(data && data.prompt_eval_count) || 0,
      completion_tokens: Number(data && data.eval_count) || 0
    },
    model: config.ollamaModel
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
 * @returns {number|null} the estimated prompt tokens when the prompt will not fit, else null
 */
function contextOverflow(system, user) {
  if (config.projectSummaryProvider !== 'ollama') return null;
  const estimate = Math.ceil((system.length + user.length) / 4);
  return estimate + config.projectSummaryMaxTokens > config.projectSummaryOllamaCtx
    ? estimate
    : null;
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
 * Thousands separators removed, so "50,000" and "50000" are the same figure.
 *
 * Applied to BOTH the claim and the chunk before they are compared: without it a bullet saying
 * "50,000" would fail against a source that writes "50000", and one saying "50000" would pass
 * against a source that says nothing of the kind.
 */
const normaliseNumbers = text => String(text || '').replace(/(\d),(?=\d{3}(\D|$))/g, '$1');

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';

/**
 * Every figure and date a claim commits to.
 *
 * Four digits and up, because two- and three-digit numbers are mostly condition numbers, clause
 * references and ordinary prose ("within 30 days") that appear in a hundred harmless forms. Four
 * digits is where a claim starts being a quantity or a year — the things a model invents fluently.
 */
function claimTokens(text) {
  const s = normaliseNumbers(text);
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
 * Is every figure and date in `text` present in the chunks it cites?
 *
 * The gate that catches a fluent invention. A hallucinated condition reads exactly like a real one
 * — same register, same structure, plausible citation — until you check whether its numbers are in
 * the source. Anything that fails is dropped whole; a claim with one wrong figure is not repaired
 * into a claim with none.
 */
function groundedInCitations(text, citations, chunks) {
  const tokens = claimTokens(text);
  if (tokens.length === 0) return true;

  const cited = normaliseNumbers(
    citations.map(n => (chunks[n - 1] && chunks[n - 1].content) || '').join('\n')
  ).toLowerCase();

  return tokens.every(token => cited.includes(token.toLowerCase()));
}

/** JSON or null. A reply that is not JSON at all is a rejected section, not a parse to retry. */
function parseJson(content) {
  try {
    const parsed = JSON.parse(String(content || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
        documentName
      });
      return n;
    },
    /** Local one-based source numbers to record-wide ones. */
    map(local, chunks, documentName) {
      return local.map(n => this.register(chunks[n - 1], documentName));
    },
    list: () => entries
  };
}

// ---------------------------------------------------------------------------------------------
// Nations
// ---------------------------------------------------------------------------------------------

/**
 * A nation's name reduced to what two spellings of it have in common.
 *
 * "Saulteau First Nations", "Saulteau First Nation" and "Saulteau Indian Band" are one organisation
 * written three ways, and the join has to survive that. The generic words are dropped LAST, after
 * punctuation, so "Nation(s)" inside a name is removed however it was punctuated.
 *
 * Deliberately conservative: it normalises spelling, never meaning. Two genuinely different nations
 * whose names differ only in a dropped word stay different, because the remaining words still
 * differ. Names it cannot match are reported unmatched, which is the input to an alias table.
 */
function normaliseNationName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(first\s+nations?|indian\s+band|nations?|band|tribal\s+council|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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
    const key = normaliseNationName(org.name);
    if (key && !byName.has(key)) byName.set(key, org);
  }

  return names.map(({ name, citations }) => {
    const match = byName.get(normaliseNationName(name));
    return { name, organizationId: match ? String(match.id) : null, citations };
  });
}

// ---------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------

/**
 * One section: choose a source document, read its chunks, ask for JSON, validate, number the
 * citations record-wide.
 *
 * NO SOURCE DOCUMENT MEANS NO MODEL CALL. Not an optimisation — a model asked to summarise nothing
 * answers from its own knowledge, and the answer is indistinguishable from a real one.
 *
 * @returns {Promise<{value: any, usage: object|null, model: string|null, documentId: string|null,
 *   reason: string|null}>} `value` is null when the section could not be produced; `reason` names
 *   why when the cause is a run condition rather than the model's answer.
 */
async function runSection({ document, chunks, registry, projectName, instruction, shape, build }) {
  // A document with no extracted text is the same case as no document: nothing to ground on.
  if (chunks.length === 0) {
    return { value: null, usage: null, model: null, documentId: String(document.id), reason: null };
  }

  const used = chunks.slice(0, config.projectSummaryMaxChunks);
  const system = systemPrompt(projectName, instruction, shape);
  const user = `Sources from "${nameOf(document)}":\n\n${buildSourceBlock(used)}`;

  const overflow = contextOverflow(system, user);
  if (overflow !== null) {
    logger.warn('[project-summary] prompt exceeds the context window; section not generated', {
      documentId: String(document.id),
      sources: used.length,
      estimatedPromptTokens: overflow,
      numPredict: config.projectSummaryMaxTokens,
      numCtx: config.projectSummaryOllamaCtx
    });
    return {
      value: null, usage: null, model: null,
      documentId: String(document.id), reason: 'context_overflow'
    };
  }

  const { content, usage, model } = await chatJson(system, user);
  const parsed = parseJson(content);

  if (!parsed) {
    logger.warn('[project-summary] rejected a reply that was not JSON', {
      documentId: String(document.id), sources: used.length
    });
    return { value: null, usage, model, documentId: String(document.id), reason: 'not_json' };
  }

  const value = build(parsed, used, n => registry.map(n, used, nameOf(document)));
  return { value, usage, model, documentId: String(document.id), reason: null };
}

/** `{sentence, citations}` — dropped whole if the sentence is ungrounded. */
function buildSentence(parsed, chunks, toGlobal) {
  if (!isStr(parsed.sentence)) return null;
  const local = validCitations(parsed.citations, chunks.length);
  if (local.length === 0) return null;
  if (!groundedInCitations(parsed.sentence, local, chunks)) return null;
  return { sentence: parsed.sentence.trim(), citations: toGlobal(local) };
}

function buildParagraph(parsed, chunks, toGlobal) {
  if (!isStr(parsed.paragraph)) return null;
  const local = validCitations(parsed.citations, chunks.length);
  if (local.length === 0) return null;
  if (!groundedInCitations(parsed.paragraph, local, chunks)) return null;
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
function buildItems(parsed, chunks, toGlobal) {
  if (!Array.isArray(parsed.items)) return null;

  const items = [];
  for (const raw of parsed.items) {
    if (!raw || typeof raw !== 'object') continue;
    if (!isStr(raw.title) || !isStr(raw.oneLiner)) continue;
    if (raw.bullets !== undefined && !isStrArray(raw.bullets)) continue;

    const local = validCitations(raw.citations, chunks.length);
    if (local.length === 0) continue;
    if (!groundedInCitations(`${raw.title} ${raw.oneLiner}`, local, chunks)) continue;

    items.push({
      n: items.length + 1,
      category: isStr(raw.category) ? raw.category.trim() : '',
      title: raw.title.trim(),
      oneLiner: raw.oneLiner.trim(),
      bullets: (raw.bullets || []).filter(b => groundedInCitations(b, local, chunks)),
      citations: toGlobal(local)
    });
  }

  return items.length ? { items } : null;
}

function buildTimeline(parsed, chunks, toGlobal) {
  if (!Array.isArray(parsed.events)) return null;

  const events = [];
  for (const raw of parsed.events) {
    if (!raw || typeof raw !== 'object') continue;
    // An ISO date, strictly. A timeline row merges with the fact rows on the page and sorts
    // against them, so a free-text date would be a row that cannot be placed.
    if (!isStr(raw.date) || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date.trim())) continue;
    if (!isStr(raw.label)) continue;

    const local = validCitations(raw.citations, chunks.length);
    if (local.length === 0) continue;
    if (!groundedInCitations(`${raw.date} ${raw.label}`, local, chunks)) continue;

    events.push({ date: raw.date.trim(), label: raw.label.trim(), citations: toGlobal(local) });
  }

  return events.length ? events : null;
}

function buildNations(parsed, chunks, toGlobal) {
  if (!Array.isArray(parsed.nations)) return null;

  const names = [];
  const seen = new Set();
  for (const raw of parsed.nations) {
    if (!raw || typeof raw !== 'object' || !isStr(raw.name)) continue;
    const local = validCitations(raw.citations, chunks.length);
    if (local.length === 0) continue;

    const name = raw.name.trim();
    const key = normaliseNationName(name);
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

  const documents = await sources.documents(projectId);
  const facts = buildFacts(documents);
  const registry = citationRegistry();
  const projectName = sanitisePromptName(project.name || project.displayName || projectId);

  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  const models = new Set();
  // Why a section is null, for the sections where "null" and "nothing was generated" differ. An
  // absent document is not in here — that is the grounding rule working, not a fault.
  const sectionErrors = {};
  const wanted = name => !section || section === name;

  /** One section end to end, with its usage folded into the record's totals. */
  const run = async (name, document, spec) => {
    if (!wanted(name) || !document) return null;
    const { items: chunks } = await sources.chunksForDocument(String(document.id));
    const result = await runSection({ document, chunks, registry, projectName, ...spec });
    if (result.reason) sectionErrors[name] = result.reason;
    if (result.usage) {
      usage.prompt_tokens += Number(result.usage.prompt_tokens) || 0;
      usage.completion_tokens += Number(result.usage.completion_tokens) || 0;
    }
    if (result.model) models.add(result.model);
    return result;
  };

  // Status: the newest amendment if there is one, else the certificate. The sentence the card
  // carries is about where the project stands NOW, so the most recent decision document wins.
  const statusDoc = facts.amendments.length
    ? documents.find(d => String(d.id) === facts.amendments[0].documentId)
    : PICK.certificate(documents);
  const status = await run('status', statusDoc, {
    shape: SHAPES.status,
    instruction: INSTRUCTIONS.status,
    build: buildSentence
  });

  const scheduleB = PICK.scheduleB(documents);
  const conditions = await run('conditions', scheduleB, {
    shape: SHAPES.conditions,
    instruction: INSTRUCTIONS.conditions,
    build: buildItems
  });

  const federalDoc = PICK.federal(documents);
  const federal = await run('federal', federalDoc, {
    shape: SHAPES.conditions,
    instruction: INSTRUCTIONS.federal,
    build: buildItems
  });

  // Nations from the certificate, falling back to the assessment report — Site C has no Section 11
  // Order document in DEMI, which is where this would otherwise be read.
  const nationsDoc = PICK.certificate(documents) || PICK.assessmentReport(documents);
  const nationsResult = await run('nations', nationsDoc, {
    shape: SHAPES.nations,
    instruction: INSTRUCTIONS.nations,
    build: buildNations
  });

  const complianceDoc = PICK.newestInspection(documents);
  const compliance = await run('compliance', complianceDoc, {
    shape: SHAPES.compliance,
    instruction: INSTRUCTIONS.compliance,
    build: buildParagraph
  });

  const timelineDoc = PICK.assessmentReport(documents) || PICK.certificate(documents);
  const timelineEvents = await run('timelineEvents', timelineDoc, {
    shape: SHAPES.timeline,
    instruction: INSTRUCTIONS.timelineEvents,
    build: buildTimeline
  });

  // One call per amendment. Each is its own document, and a single call over all eight would let a
  // sentence about one amendment cite another's chunks.
  const amendments = [];
  if (wanted('amendments')) {
    for (const ref of facts.amendments) {
      const doc = documents.find(d => String(d.id) === ref.documentId);
      const result = await run('amendments', doc, {
        shape: SHAPES.amendment,
        instruction: INSTRUCTIONS.amendments,
        build: buildSentence
      });
      if (result && result.value) {
        amendments.push({ documentId: ref.documentId, ...result.value });
      }
    }
  }

  const organizations = nationsResult && nationsResult.value ? await sources.organizations() : [];
  const nations = nationsResult && nationsResult.value
    ? joinNations(nationsResult.value, organizations)
    : null;

  const unmatched = (nations || []).filter(n => !n.organizationId).map(n => n.name);
  if (unmatched.length) {
    // The input to an alias table. An unmatched name is not an error — it renders without a
    // contact card — but a growing list of them is the signal that the normalisation needs help.
    logger.info('[project-summary] nation names with no Organization row', {
      projectId: String(projectId), unmatched
    });
  }

  const totalUsage = { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens };

  return {
    id: String(projectId),
    projectId: String(projectId),
    eagleId: project.eagleId ? String(project.eagleId) : null,
    generatedAt: now || new Date().toISOString(),
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
      federal: federal && federal.value
        ? { sourceDocumentId: federal.documentId, ...federal.value }
        : null
    },
    sectionErrors,
    citations: registry.list()
  };
}

module.exports = {
  generateProjectSummary,
  SECTIONS,
  PROMPT_VERSION,
  PRICED_AS,
  // Exported for tests: each is a gate with its own failure mode, and each is worth pinning apart
  // from a whole-record run.
  buildFacts,
  sanitisePromptName,
  validCitations,
  groundedInCitations,
  claimTokens,
  normaliseNationName,
  joinNations,
  buildItems,
  buildNations,
  PICK
};
