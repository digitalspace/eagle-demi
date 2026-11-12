'use strict';

// Search step 5 and the only step that touches a model (wiki ADR-006). The model sees only the
// chunks it is handed; it never selects, re-ranks or rewrites the query.

const config = require('../config');
const { logger } = require('../utils/logger');

let credential = null;
let tokenCache = null;

/**
 * Bearer token for the Foundry data plane, from the shared user-assigned identity; no API key.
 * The credential loads lazily so test runs that never authenticate skip the credential chain.
 */
async function getToken() {
  if (tokenCache && tokenCache.expiresOn - Date.now() > 5 * 60 * 1000) {
    return tokenCache.token;
  }

  if (!credential) credential = require('../utils/azure-credential').createCredential();

  const result = await credential.getToken('https://cognitiveservices.azure.com/.default');
  if (!result || !result.token) throw new Error('no token returned for the Foundry data plane');
  tokenCache = { token: result.token, expiresOn: result.expiresOnTimestamp || Date.now() };
  return tokenCache.token;
}

/**
 * The grounding contract; the nonsense-term probe checks the "say so" line. Citations are one-based
 * `[n]` source numbers, never chunk ids, so the model cannot invent a real-looking id.
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
 * Estimated query cost in CAD, the billing currency, from list rates in config. Every surface must
 * call it an estimate. Null, not 0, when usage is absent: "not measured" is not "free".
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

/** Chat-completions URL for the configured deployment, shared with `ai/project-summary.js`. */
function foundryChatUrl() {
  return `${config.foundryEndpoint.replace(/\/$/, '')}/openai/deployments/` +
    `${encodeURIComponent(config.foundryDeployment)}/chat/completions` +
    `?api-version=${encodeURIComponent(config.foundryApiVersion)}`;
}

/** One chat completion POST; each caller fetches its own token and URL and reads the response. */
function foundryChat(url, token, { system, user, maxTokens, signal, jsonObject }) {
  return fetch(url, {
    method: 'POST',
    ...(signal ? { signal } : {}),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      // Deterministic: same input, same output, for search and project summaries. A rerun that
      // reads differently looks like a bug to a user and makes the probes non-repeatable.
      temperature: 0,
      max_tokens: maxTokens,
      ...(jsonObject ? { response_format: { type: 'json_object' } } : {})
    })
  });
}

/**
 * Trim a chunk to the configured ceiling, which bounds cost before the request. Cutting on a word
 * boundary avoids handing the model a severed token it may try to complete.
 */
function truncate(text, maxChars) {
  const s = String(text || '').trim();
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.8 ? cut.slice(0, lastSpace) : cut) + '…';
}

/** Render the chunks as numbered sources. The cost probe's token ceiling depends on this shape. */
function buildPrompt(keywords, chunks, maxChars) {
  const sources = chunks
    .map((c, i) => `[${i + 1}] ${truncate(c.content, maxChars)}`)
    .join('\n\n');

  return `Question: ${keywords}\n\nSources:\n${sources}`;
}

/**
 * Cited source numbers as zero-based chunk indices. Out-of-range and duplicate numbers are dropped
 * so the frontend never links a citation to nothing.
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
 * Summarise chunks the caller has ALREADY retrieved and ACL-filtered. No access control here:
 * both gates live in the controller.
 *
 * @param {string} keywords    the user's query, verbatim
 * @param {Array}  chunks      [{ chunkId, documentId, projectId, pageNumber, content }]
 * @returns {Promise<{summary: string|null, citations: number[], usage: object|null, reason?: string}>}
 */
async function summarize(keywords, chunks) {
  // Only chunk `content` reaches the model. The early return is the grounding guarantee: handed
  // an empty list, a model answers from its own knowledge.
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

  const url = foundryChatUrl();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.summaryTimeoutMs);

  try {
    const token = await getToken();
    const res = await foundryChat(url, token, {
      system: SYSTEM_PROMPT, user: prompt, maxTokens: config.summaryMaxTokens, signal: controller.signal
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
  // Shared with ai/project-summary.js, which calls the same deployment with its own prompts.
  getToken,
  foundryChatUrl,
  foundryChat,
  // Exported for tests: prompt shape bounds the bill, and citation parsing bounds what the UI links.
  buildPrompt,
  parseCitations,
  truncate,
  SYSTEM_PROMPT
};
