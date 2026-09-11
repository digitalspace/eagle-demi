'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseArgs, mergeSection, summaryLine, run
} = require('../../src/scripts/generate-project-summary');

const cite = (n, chunkId) => ({ n, chunkId, documentId: 'docB', pageNumber: n, documentName: 'B' });

const STORED = {
  id: '272', projectId: '272', generatedAt: '2026-09-01T00:00:00Z', sourceAccess: 'public',
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
  id: '272', projectId: '272', generatedAt: '2026-09-08T00:00:00Z', sourceAccess: 'public',
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

  await t.test('takes a file to upload as it stands', () => {
    assert.strictEqual(parseArgs(['--project', '272', '--store', '/tmp/x.json']).store,
      '/tmp/x.json');
  });

  await t.test('refuses generation flags beside --store, which generates nothing', () => {
    for (const extra of [['--live'], ['--section', 'conditions'], ['--out', '/tmp/y.json']]) {
      assert.throws(
        () => parseArgs(['--project', '272', '--store', '/tmp/x.json', ...extra]),
        /--store uploads a file as it stands/, extra.join(' '));
    }
  });
});

test('--store', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-summary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** An adapter that only saves. Any read is a generation this run was told not to do. */
  const saveOnly = () => {
    const saved = [];
    const refuse = (what) => async () => {
      throw new Error(`--store must not read ${what}`);
    };
    return {
      saved,
      save: async (record) => { saved.push(record); return record; },
      project: refuse('the project'),
      documents: refuse('the document list'),
      chunksForDocument: refuse('chunks'),
      summary: refuse('the stored record')
    };
  };

  const write = (name, record) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(record, null, 2));
    return file;
  };

  await t.test('uploads the file unchanged, generating nothing', async () => {
    // The record took minutes to generate on a token that lasts five, so this is a retry of the
    // upload. A record that changed on the way up would be one nothing had checked.
    const file = write('record.json', STORED);
    const sources = saveOnly();

    const result = await run({ project: '272', store: file, sources });

    assert.strictEqual(result.stored, true);
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(sources.saved, [JSON.parse(fs.readFileSync(file, 'utf8'))],
      'what was PUT is what was on disk');
  });

  await t.test('refuses a file holding a different project', async () => {
    // `save` addresses the record by its own id, so a mismatched file would be written to the
    // project the FILE names while the operator read the one they typed.
    const file = write('other.json', { ...STORED, id: '999', projectId: '999' });
    const sources = saveOnly();

    await assert.rejects(() => run({ project: '272', store: file, sources }),
      /holds project 999 \(id 999\), not 272/);
    assert.deepStrictEqual(sources.saved, [], 'nothing was written');
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

  await t.test('refuses to merge into a record built from a wider set of documents', () => {
    // The sections nobody regenerated keep the STORED record's sources. Merging into a record that
    // predates the public-only filter would relabel those sections as public without rereading a
    // single document.
    const stale = { ...STORED, sourceAccess: undefined };

    assert.throws(() => mergeSection(stale, FRESH, 'conditions'),
      /regenerate the whole record/);
  });

  await t.test('carries the source access forward', () => {
    assert.strictEqual(mergeSection(STORED, FRESH, 'conditions').sourceAccess, 'public');
  });

  await t.test('replaces the section with the reason it came back empty', () => {
    // A regenerated section that failed overwrites a good stored one. Storing that null without
    // this run's reason leaves the record saying the section is empty and nothing saying why,
    // and the run's own verdict line reports failed=none.
    const failed = {
      ...FRESH,
      sections: { ...FRESH.sections, conditions: null },
      sectionErrors: { conditions: 'not_json' }
    };

    const merged = mergeSection(STORED, failed, 'conditions');

    assert.strictEqual(merged.sections.conditions, null);
    assert.strictEqual(merged.sectionErrors.conditions, 'not_json');
    assert.match(summaryLine(merged, true), /failed=conditions /);
  });

  await t.test('drops the stored reason when the section comes back', () => {
    // The mirror case: an earlier failure's reason surviving a run that succeeded makes the record
    // say a section that renders is a section that failed.
    const stored = { ...STORED, sectionErrors: { conditions: 'not_json' } };

    const merged = mergeSection(stored, FRESH, 'conditions');

    assert.strictEqual(merged.sectionErrors.conditions, undefined);
    assert.match(summaryLine(merged, true), /failed=none /);
  });

  await t.test('moves the document a section waits on with the section it explains', () => {
    // The link the page offers for a `not_extracted` section has to name the document THIS run
    // could not read, not the one an earlier run named.
    const stored = {
      ...STORED,
      sectionErrors: { status: 'not_extracted', conditions: 'not_extracted' },
      sectionSources: {
        status: { documentId: 'docC', displayName: 'Certificate' },
        conditions: { documentId: 'docOld', displayName: 'Schedule B' }
      }
    };
    const failed = {
      ...FRESH,
      sections: { ...FRESH.sections, conditions: null },
      sectionErrors: { conditions: 'not_extracted' },
      sectionSources: { conditions: { documentId: 'docNew', displayName: 'Schedule B (amended)' } }
    };

    const merged = mergeSection(stored, failed, 'conditions');

    assert.deepStrictEqual(merged.sectionSources, {
      status: { documentId: 'docC', displayName: 'Certificate' },
      conditions: { documentId: 'docNew', displayName: 'Schedule B (amended)' }
    });
    assert.match(summaryLine(merged, true), /failed=none absent=conditions /,
      'a document waiting on extraction is a registry state, not a failed run');
  });

  await t.test('drops the stored document when the section comes back', () => {
    const stored = {
      ...STORED,
      sectionErrors: { conditions: 'not_extracted' },
      sectionSources: { conditions: { documentId: 'docOld', displayName: 'Schedule B' } }
    };

    assert.deepStrictEqual(mergeSection(stored, FRESH, 'conditions').sectionSources, {});
  });

  await t.test('leaves the reasons of the sections nobody regenerated alone', () => {
    const stored = { ...STORED, sectionErrors: { status: 'no_document', compliance: 'truncated' } };

    const merged = mergeSection(stored, FRESH, 'conditions');

    assert.deepStrictEqual(merged.sectionErrors,
      { status: 'no_document', compliance: 'truncated' });
  });
});

test('summaryLine', async (t) => {
  await t.test('names the sections that were attempted and failed', () => {
    const line = summaryLine({
      ...FRESH, sections: { ...FRESH.sections, conditions: null },
      sectionErrors: { conditions: 'not_json (batch 2 of 3)' }
    }, false);

    assert.match(line, /sections=none /);
    assert.match(line, /failed=conditions /,
      'a section that was tried and came back empty is not the same as one with no document');
  });

  await t.test('says none when every section that ran came back', () => {
    const line = summaryLine({ ...FRESH, sectionErrors: {} }, true);
    assert.match(line, /failed=none /);
    assert.match(line, /absent=none /);
  });

  await t.test('does not call a section absent when it produced something', () => {
    // Amendments record `no_text` per unextracted package while the ones with text still render,
    // and the line said the section was both there and missing.
    const line = summaryLine({
      ...FRESH,
      sections: {
        ...FRESH.sections,
        amendments: [{ documentId: 'docA', sentence: 'The first amendment.', citations: [1] }]
      },
      sectionErrors: { amendments: 'no_text: docA2' }
    }, false);

    assert.match(line, /sections=conditions,amendments /);
    assert.match(line, /absent=none /);
  });

  await t.test('reads a real failure joined behind a quiet one', () => {
    const line = summaryLine({
      ...FRESH, sections: { ...FRESH.sections, amendments: null },
      sectionErrors: { amendments: 'no_text: docA2; not_json: docA3' }
    }, false);

    assert.match(line, /failed=amendments /);
    assert.match(line, /absent=none /);
  });

  await t.test('lists quiet reasons under absent, not failed', () => {
    // no_document, no_source and empty are the registry having nothing — not a break to chase.
    const line = summaryLine({
      ...FRESH,
      sectionErrors: { status: 'no_document', compliance: 'no_source', amendments: 'empty' }
    }, false);

    assert.match(line, /failed=none /);
    assert.match(line, /absent=status,compliance,amendments /);
  });

  await t.test('sorts a suffixed reason by its leading token', () => {
    // "no_chunks: id1,id2" and "not_json (batch 2 of 3)" carry extra detail after the reason word;
    // only the word itself says whether this is quiet or worth investigating.
    const line = summaryLine({
      ...FRESH,
      sectionErrors: {
        conditions: 'not_json (batch 2 of 3)',
        amendments: 'no_chunks: id1,id2',
        status: 'no_document: docA'
      }
    }, false);

    assert.match(line, /failed=conditions,amendments /);
    assert.match(line, /absent=status /);
  });
});
