'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const config = require('../../src/config');
const { summarize, buildPrompt, parseCitations, truncate, SYSTEM_PROMPT } = require('../../src/ai/summarize');

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

test('the system prompt states the grounding contract', async (t) => {
  await t.test('forbids outside knowledge and requires a refusal path', () => {
    // Pinned deliberately. These two lines are what stop a confident answer to a query the corpus
    // cannot support, and a well-meaning edit that softens them would not fail any other test.
    assert.match(SYSTEM_PROMPT, /ONLY from the numbered sources/);
    assert.match(SYSTEM_PROMPT, /Never use outside knowledge/);
    assert.match(SYSTEM_PROMPT, /do not answer the question, say so/);
  });
});
