'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { parseArgs, mergeSection } = require('../../src/scripts/generate-project-summary');

const cite = (n, chunkId) => ({ n, chunkId, documentId: 'docB', pageNumber: n, documentName: 'B' });

const STORED = {
  id: '272', projectId: '272', generatedAt: '2026-09-01T00:00:00Z',
  usage: { promptTokens: 900, completionTokens: 90 }, estimatedCostCad: 0.9,
  facts: { documentTotal: 1 },
  sections: {
    status: { sentence: 'Old status.', citations: [1] },
    conditions: { sourceDocumentId: 'docB', items: [
      { n: 1, category: 'Water', title: 'Old', oneLiner: 'Old.', bullets: [], citations: [2] }
    ] },
    compliance: null
  },
  citations: [cite(1, 'chunk-status'), cite(2, 'chunk-old-condition')]
};

const FRESH = {
  id: '272', projectId: '272', generatedAt: '2026-09-08T00:00:00Z',
  model: 'qwen3.6:35b-a3b', pricedAs: 'gpt-4.1-mini', promptVersion: 1,
  usage: { promptTokens: 100, completionTokens: 10 }, estimatedCostCad: 0.1,
  facts: { documentTotal: 2 },
  sections: {
    status: null,
    conditions: { sourceDocumentId: 'docB', items: [
      { n: 1, category: 'Water', title: 'New', oneLiner: 'New.', bullets: [], citations: [1] }
    ] },
    compliance: null
  },
  citations: [cite(1, 'chunk-new-condition')]
};

test('parseArgs', async (t) => {
  await t.test('requires a project, so a backfill cannot start by accident', () => {
    assert.throws(() => parseArgs(['--live']), /--project <id> is required/);
  });

  await t.test('refuses a section name that does not exist', () => {
    assert.throws(() => parseArgs(['--project', '272', '--section', 'nonsense']),
      /unknown section "nonsense"/);
  });

  await t.test('is a dry run unless --live is passed', () => {
    assert.strictEqual(parseArgs(['--project', '272']).live, false);
    assert.strictEqual(parseArgs(['--project', '272', '--live']).live, true);
  });

  await t.test('takes an output path', () => {
    assert.strictEqual(parseArgs(['--project', '272', '--out', '/tmp/x.json']).out, '/tmp/x.json');
  });
});

test('mergeSection', async (t) => {
  await t.test('replaces only the named section', () => {
    const merged = mergeSection(STORED, FRESH, 'conditions');

    assert.strictEqual(merged.sections.conditions.items[0].title, 'New');
    assert.strictEqual(merged.sections.status.sentence, 'Old status.',
      'a section nobody regenerated is untouched');
  });

  await t.test('renumbers citations so an untouched section still points at its own source', () => {
    // The fresh section's `[1]` and the stored status section's `[1]` are DIFFERENT chunks.
    // Concatenating the two lists would leave the status sentence citing a condition chunk — a
    // citation that resolves, to the wrong thing, which is worse than one that does not.
    const merged = mergeSection(STORED, FRESH, 'conditions');

    const statusSource = merged.citations.find(c => c.n === merged.sections.status.citations[0]);
    assert.strictEqual(statusSource.chunkId, 'chunk-status');

    const conditionSource = merged.citations
      .find(c => c.n === merged.sections.conditions.items[0].citations[0]);
    assert.strictEqual(conditionSource.chunkId, 'chunk-new-condition');
  });

  await t.test('drops the chunks nothing cites any more', () => {
    // The old condition's source is not cited by anything after the merge, so carrying it would
    // put a source on the page's footer that no claim points at.
    const merged = mergeSection(STORED, FRESH, 'conditions');
    assert.ok(!merged.citations.some(c => c.chunkId === 'chunk-old-condition'));
  });

  await t.test('reports this run cost, not the running total', () => {
    const merged = mergeSection(STORED, FRESH, 'conditions');
    assert.deepStrictEqual(merged.usage, { promptTokens: 100, completionTokens: 10 });
    assert.strictEqual(merged.facts.documentTotal, 2, 'facts are recomputed, never merged');
  });

  await t.test('takes the fresh record whole when nothing is stored yet', () => {
    assert.strictEqual(mergeSection(null, FRESH, 'conditions'), FRESH);
  });
});
