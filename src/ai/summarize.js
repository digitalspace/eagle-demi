'use strict';

/**
 * Step 5 of the search pipeline, and the only step that touches a model. See wiki ADR-006.
 *
 * Steps 1-4 — tokenize, BM25 + the OData ACL filter, top-N, fetch chunk text from Cosmos — happen
 * in the caller and are unchanged by this module. The model never selects documents, never
 * re-ranks, never rewrites the query, and never sees anything outside the chunks it is handed.
 * Delete the deployment and search still works; only the panel disappears.
 *
 * Everything provider-specific lives here. The controller knows about chunks and access contexts;
 * it does not know which model answers, and swapping the deployment is configuration.
 */

const config = require('../config');
const { logger } = require('../utils/logger');

let credential = null;
let tokenCache = null;

/**
 * Bearer token for the Foundry data plane.
 *
 * Keyless by construction — the same user-assigned identity the search and Cosmos clients use.
 * There is no API key in config to leak, which matters because this repo is public.
 *
 * `@azure/identity` is required lazily, matching `search/ai-search.js` and `db/cosmos-nosql.js`:
 * importing this module must not drag the credential chain into test runs that never authenticate.
 */
async function getToken() {
  if (tokenCache && tokenCache.expiresOn - Date.now() > 5 * 60 * 1000) {
    return tokenCache.token;
  }

  if (!credential) {
    const { DefaultAzureCredential } = require('@azure/identity');
    credential = new DefaultAzureCredential(
      process.env.AZURE_CLIENT_ID
        ? { managedIdentityClientId: process.env.AZURE_CLIENT_ID }
        : undefined
    );
  }

  const result = await credential.getToken('https://cognitiveservices.azure.com/.default');
  if (!result || !result.token) throw new Error('no token returned for the Foundry data plane');
  tokenCache = { token: result.token, expiresOn: result.expiresOnTimestamp || Date.now() };
  return tokenCache.token;
}

/**
 * The grounding contract.
 *
 * "Say so when the sources do not answer it" is the load-bearing line, and it is the one the
 * nonsense-term probe checks. A summariser that answers from model knowledge when handed nothing is
 * indistinguishable from a working one on every ordinary query and wrong on exactly the queries
 * where a user would trust it most.
 *
 * The citation format is `[n]`, one-based, indexing the numbered sources below — not chunk ids. The
 * model never sees a chunk id, so it cannot invent one that looks real.
 */
const SYSTEM_PROMPT = [
  'You summarise search results for a document registry.',
  '',
  'Rules:',
  '- Answer ONLY from the numbered sources given. Never use outside knowledge.',
  '- Cite every claim with the source number in square brackets, like [1] or [2][3].',
  '- If the sources do not answer the question, say so plainly and stop. Do not guess.',
  '- Three sentences at most. No preamble, no restating the question.'
].join('\n');

/**
 * What this query cost, in CAD, from the token counts the deployment reported.
 *
 * CAD because the subscription is billed in CAD and every other cost figure in this repo is too —
 * see the rates in config. A per-query number in a second currency is one someone has to convert
 * before it can be set against the budget it draws down.
 *
 * AN ESTIMATE, and every surface that shows it must say so. Azure bills on its own meter with its
 * own rounding, the list rates live in config and drift from reality the moment Microsoft changes
 * them, and any committed-use or negotiated discount is invisible here. Useful for spotting the
 * query that cost fifty times the others; useless for reconciling an invoice.
 *
 * Returns null rather than 0 when usage is absent — "not measured" and "free" are different facts.
 */
function estimateCostCad(usage) {
  if (!usage) return null;
  const inTok = Number(usage.prompt_tokens) || 0;
  const outTok = Number(usage.completion_tokens) || 0;
  return (
    (inTok / 1e6) * config.summaryCostPerMTokIn +
    (outTok / 1e6) * config.summaryCostPerMTokOut
  );
}

/**
 * Trim a chunk to the configured ceiling.
 *
 * Cost is bounded here, before the request, rather than discovered on the bill. Cutting on a word
 * boundary avoids handing the model a severed token it may try to complete.
 */
function truncate(text, maxChars) {
  const s = String(text || '').trim();
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.8 ? cut.slice(0, lastSpace) : cut) + '…';
}

/**
 * Render the chunks as numbered sources.
 *
 * Exported for tests: this is the only place the prompt's shape is decided, and the token ceiling
 * the cost probe asserts against is a property of this function.
 */
function buildPrompt(keywords, chunks, maxChars) {
  const sources = chunks
    .map((c, i) => `[${i + 1}] ${truncate(c.content, maxChars)}`)
    .join('\n\n');

  return `Question: ${keywords}\n\nSources:\n${sources}`;
}

/**
 * Source numbers actually cited, as zero-based indices into the chunk array.
 *
 * The frontend links citations back to documents, so a `[9]` against eight sources must not become
 * a link to nothing. Out-of-range and duplicate numbers are dropped here rather than defended
 * against in the template.
 */
function parseCitations(text, sourceCount) {
  const seen = new Set();
  for (const match of String(text || '').matchAll(/\[(\d+)\]/g)) {
    const n = Number(match[1]);
    if (n >= 1 && n <= sourceCount) seen.add(n - 1);
  }
  return Array.from(seen).sort((a, b) => a - b);
}

/**
 * Summarise chunks that the caller has ALREADY retrieved and ALREADY ACL-filtered.
 *
 * This function does no access control of its own and must never be handed a chunk the caller
 * cannot read — both gates (the OData filter on the search leg, `chunks.getById` on the Cosmos
 * fetch) live in the controller, upstream of here.
 *
 * @param {string} keywords    the user's query, verbatim
 * @param {Array}  chunks      [{ chunkId, documentId, projectId, pageNumber, content }]
 * @returns {Promise<{summary: string|null, citations: number[], usage: object|null, reason?: string}>}
 */
async function summarize(keywords, chunks) {
  // Nothing retrieved means nothing to summarise. Returning early is not an optimisation — it is
  // the grounding guarantee, and it is what the nonsense-term probe measures. A model asked to
  // summarise an empty list will happily answer from its own knowledge.
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return { summary: null, citations: [], usage: null, reason: 'no_results' };
  }

  if (!config.summaryEnabled) {
    return { summary: null, citations: [], usage: null, reason: 'disabled' };
  }

  if (!config.foundryEndpoint || !config.foundryDeployment) {
    // Configured on but not configured for. Loud, because silently returning null here looks
    // identical to a query that legitimately found nothing.
    logger.error('[summarize] SUMMARY_ENABLED is true but FOUNDRY_ENDPOINT/FOUNDRY_DEPLOYMENT is unset');
    return { summary: null, citations: [], usage: null, reason: 'not_configured' };
  }

  const used = chunks.slice(0, config.summaryMaxChunks);
  const prompt = buildPrompt(keywords, used, config.summaryMaxChars);

  const url = `${config.foundryEndpoint.replace(/\/$/, '')}/openai/deployments/` +
    `${encodeURIComponent(config.foundryDeployment)}/chat/completions` +
    `?api-version=${encodeURIComponent(config.foundryApiVersion)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.summaryTimeoutMs);

  try {
    const token = await getToken();
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt }
        ],
        // Deterministic: this is compression, not composition. Two identical searches returning
        // two different summaries reads as a bug to a user and makes the probes non-repeatable.
        temperature: 0,
        max_tokens: config.summaryMaxTokens
      })
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error(`[summarize] ${res.status} from the deployment: ${body.slice(0, 300)}`);
      return { summary: null, citations: [], usage: null, reason: 'upstream_error' };
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim() || null;

    // The cost meter. Without it the budget question is unanswerable, and this is the cheapest
    // moment to add it — see the cost probe in ADR-006.
    if (data?.usage) {
      logger.info(
        `[summarize] tokens prompt=${data.usage.prompt_tokens} completion=${data.usage.completion_tokens} ` +
        `chunks=${used.length}`
      );
    }

    return {
      summary: text,
      citations: parseCitations(text, used.length),
      usage: data?.usage || null,
      estimatedCostCad: estimateCostCad(data?.usage)
    };
  } catch (err) {
    // Additive feature, non-fatal failure. An aborted or failed summary renders no panel; it must
    // never take the three result columns down with it.
    const reason = err.name === 'AbortError' ? 'timeout' : 'error';
    logger.error(`[summarize] ${reason}: ${err.message}`);
    return { summary: null, citations: [], usage: null, reason };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  summarize,
  estimateCostCad,
  // Exported for tests: prompt shape bounds the bill, and citation parsing bounds what the UI links.
  buildPrompt,
  parseCitations,
  truncate,
  SYSTEM_PROMPT
};
