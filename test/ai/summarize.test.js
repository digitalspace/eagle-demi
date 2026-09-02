'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const config = require('../../src/config');
const { summarize, buildPrompt, parseCitations, truncate, estimateCostCad, SYSTEM_PROMPT } = require('../../src/ai/summarize');

const chunk = (n, content) => ({
  chunkId: `doc1::p0::c${n}`,
  documentId: 'doc1',
  projectId: 'proj1',
  pageNumber: n,
  content
});

test('summarize', async (t) => {
  const originalEnabled = config.summaryEnabled;
  t.afterEach(() => {
    config.summaryEnabled = originalEnabled;
  });

  await t.test('never calls the model when there is nothing to summarise', async () => {
    // The grounding guarantee, and the reason the nonsense-term probe discriminates. If this
    // returned prose it would be answering from model knowledge rather than from the corpus.
    // `summaryEnabled` is deliberately ON here so the empty check is what short-circuits, not the
    // feature flag — otherwise this test would pass for the wrong reason.
    config.summaryEnabled = true;

    for (const input of [[], null, undefined]) {
      const result = await summarize('anything', input);
      assert.strictEqual(result.summary, null);
      assert.strictEqual(result.reason, 'no_results');
      assert.deepStrictEqual(result.citations, []);
    }
  });

  await t.test('returns nothing while the feature is off', async () => {
    config.summaryEnabled = false;
    const result = await summarize('pipeline', [chunk(0, 'some text')]);
    assert.strictEqual(result.summary, null);
    assert.strictEqual(result.reason, 'disabled');
  });

  await t.test('the empty check wins over the disabled check', async () => {
    // Ordering matters: a caller that finds nothing must be told `no_results`, not `disabled`.
    // The two are different facts and the probes read them differently.
    config.summaryEnabled = false;
    const result = await summarize('pipeline', []);
    assert.strictEqual(result.reason, 'no_results');
  });
});

test('buildPrompt', async (t) => {
  await t.test('numbers sources from 1 and includes the question verbatim', () => {
    const prompt = buildPrompt('pipeline safety', [chunk(0, 'alpha'), chunk(1, 'beta')], 1500);
    assert.match(prompt, /Question: pipeline safety/);
    assert.match(prompt, /\[1\] alpha/);
    assert.match(prompt, /\[2\] beta/);
    assert.ok(!prompt.includes('[0]'), 'sources are one-based, matching the citation format');
  });

  await t.test('never leaks a chunk id to the model', () => {
    // The model cites source NUMBERS. It never sees an id, so it cannot invent one that looks real
    // and survives the frontend's link resolution.
    const prompt = buildPrompt('q', [chunk(0, 'alpha')], 1500);
    assert.ok(!prompt.includes('doc1::p0::c0'));
  });

  await t.test('summarize reads no project or document field', () => {
    // The controller hands this module chunks and nothing else. A row carrying a document's and a
    // project's fields beside the chunk keys goes through a recording proxy, so a future edit that
    // reads `displayName`, `s3Key` or a project name off it fails here rather than shipping the
    // field to the model.
    const CHUNK_KEYS = ['chunkId', 'documentId', 'projectId', 'pageNumber', 'content'];
    const reads = [];
    const decorated = {
      ...chunk(0, 'alpha'),
      read: ['staff'], displayName: 'Sealed Report', s3Key: 'etl/site-c/secret.pdf', name: 'Project X'
    };
    const spy = new Proxy(decorated, {
      get(target, prop) {
        if (typeof prop === 'string') reads.push(prop);
        return target[prop];
      }
    });

    const prompt = buildPrompt('q', [spy], 1500);

    assert.deepStrictEqual(reads.filter(k => !CHUNK_KEYS.includes(k)), [],
      'the prompt builder read a key that is not a chunk key');
    for (const value of ['Sealed Report', 'etl/site-c/secret.pdf', 'Project X', 'staff']) {
      assert.ok(!prompt.includes(value), `${value} reached the model`);
    }
    assert.ok(prompt.includes('alpha'), 'not vacuous: the chunk text itself is in the prompt');
  });

  await t.test('enforces the per-chunk ceiling, which is the cost ceiling', () => {
    // 8 chunks x this cap is the input-token bound the cost probe asserts against. If truncation
    // stops firing, the bill grows with document size instead of with query count.
    const long = 'word '.repeat(2000);
    const prompt = buildPrompt('q', [chunk(0, long), chunk(1, long)], 100);
    for (const line of prompt.split('\n\n').filter(l => l.startsWith('['))) {
      assert.ok(line.length < 160, `source line was ${line.length} chars, cap is 100`);
    }
  });
});

test('truncate', async (t) => {
  await t.test('leaves short text exactly alone', () => {
    assert.strictEqual(truncate('short', 100), 'short');
  });

  await t.test('cuts on a word boundary and marks the cut', () => {
    const out = truncate('alpha beta gamma delta epsilon', 20);
    assert.ok(out.endsWith('…'));
    assert.ok(out.length <= 21);
    assert.ok(!out.includes('epsil'), 'must not hand the model a severed word');
  });

  await t.test('still cuts when there is no usable word boundary', () => {
    const out = truncate('a'.repeat(500), 50);
    assert.ok(out.length <= 51);
  });
});

test('parseCitations', async (t) => {
  await t.test('returns zero-based indices, deduped and ordered', () => {
    assert.deepStrictEqual(parseCitations('claim [2] and [1] and again [2]', 3), [0, 1]);
  });

  await t.test('drops citations past the end of the source list', () => {
    // The UI turns each of these into a link. A [9] against 3 sources would link to nothing.
    assert.deepStrictEqual(parseCitations('see [1] and [9]', 3), [0]);
  });

  await t.test('drops [0], which is not a valid one-based source', () => {
    assert.deepStrictEqual(parseCitations('see [0]', 3), []);
  });

  await t.test('handles text with no citations at all', () => {
    assert.deepStrictEqual(parseCitations('the sources do not answer this question', 3), []);
    assert.deepStrictEqual(parseCitations(null, 3), []);
  });
});

test('estimateCostCad', async (t) => {
  await t.test('prices the measured dev query against the configured rates', () => {
    // 2,835 prompt / 124 completion tokens, measured on dev 2026-08-05. Pinned because the rates
    // in config are model-, sku- AND currency-specific: they carried 4o-mini USD values against a
    // gpt-4.1-mini deployment and understated every query by 3.2x, and nothing else in the suite
    // would notice. The band is what makes this test able to fail — asserting only that the result
    // equals the formula would pass against any rates at all, including the wrong ones.
    const cad = estimateCostCad({ prompt_tokens: 2835, completion_tokens: 124 });
    const expected = (2835 / 1e6) * config.summaryCostPerMTokIn
                   + (124 / 1e6) * config.summaryCostPerMTokOut;

    assert.ok(Math.abs(cad - expected) < 1e-12);
    assert.ok(cad > 0.0020 && cad < 0.0026, `expected ~0.0023 CAD a query, got ${cad}`);
  });

  await t.test('returns null, not zero, when usage was never reported', () => {
    // "Not measured" and "free" are different facts, and the UI hides the line on null.
    for (const input of [null, undefined]) {
      assert.strictEqual(estimateCostCad(input), null);
    }
  });

  await t.test('treats missing or unusable token counts as zero', () => {
    assert.strictEqual(estimateCostCad({}), 0);
    assert.strictEqual(estimateCostCad({ prompt_tokens: 'nonsense' }), 0);
  });
});

test('the system prompt states the grounding contract', async (t) => {
  await t.test('forbids outside knowledge and requires a refusal path', () => {
    // Pinned deliberately. These two lines are what stop a confident answer to a query the corpus
    // cannot support, and a well-meaning edit that softens them would not fail any other test.
    assert.match(SYSTEM_PROMPT, /ONLY from the numbered sources/);
    assert.match(SYSTEM_PROMPT, /Never use outside knowledge/);
    assert.match(SYSTEM_PROMPT, /do not answer the question, say so/);
  });
});
