'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  backfillEacNumbers, certificateOf, summaryLine, exitCodeFor, parseArgs
} = require('../../src/scripts/backfill-eac-number');
const merge = require('../../src/merge/project');

/**
 * Track records as the next export will carry them. Hand-written and NOT read off
 * `src/data/track_projects_enriched.json`: that file has no `ea_certificate` column yet, so a
 * fixture derived from it would exercise the empty path only and every assertion below would pass
 * vacuously.
 */
const WITH_CERT = { track_project_id: 207, name: 'Nicomen Wind Energy', ea_certificate: 'E05-01' };
const WITH_CERT_2 = { track_project_id: 208, name: 'Berg Mine', ea_certificate: 'E14-02' };
// Track uses the column for certificate STATE too — 58 records read "Withdrawn", 41 "In progress".
const STATE_WORD = { track_project_id: 209, name: 'Ajax Mine', ea_certificate: 'Withdrawn' };
const NO_CERT = { track_project_id: 354, name: 'Surrey Langley SkyTrain' };
const BLANK_CERT = { track_project_id: 355, name: 'Kimberley Water', ea_certificate: '   ' };
const UNSEEDED = { track_project_id: 999, name: 'Never Seeded', ea_certificate: 'E99-09' };

function fakeSources(trackProjects) {
  return { loadTrackProjects: () => trackProjects };
}

/**
 * Projects repository double. It ASSERTS the access tier: a scoped context lists only what it can
 * see, so every row it cannot read would be counted as `missingRow` and silently skipped.
 */
function fakeProjects(ids) {
  return {
    CONTAINER: 'projects',
    async listVisible(access) {
      assert.strictEqual(access && access.tier, 'privileged',
        'the project scan must run as systemAccess(), or rows read as missing');
      return { items: ids.map(id => ({ id })) };
    }
  };
}

function fakePatch() {
  const calls = [];
  return { calls, fn: async (id, ops) => { calls.push({ id, ops }); } };
}

test('certificateOf asks the merge, so the backfill and a re-seed agree', async (t) => {
  await t.test('it returns what mergeTrackProject would store', () => {
    const reseeded = merge.mergeTrackProject(WITH_CERT, null);
    assert.strictEqual(certificateOf(WITH_CERT), reseeded.eaCertificate);
    assert.strictEqual(certificateOf(WITH_CERT), 'E05-01');
  });

  await t.test('a missing column is null, not undefined', () => {
    assert.strictEqual(certificateOf(NO_CERT), null);
  });

  await t.test('a whitespace-only value is null — hasValue trims', () => {
    // Otherwise the backfill writes '   ' where a re-seed writes nothing at all.
    assert.strictEqual(certificateOf(BLANK_CERT), null);
  });

  await t.test('a state word is stored verbatim, not filtered out', () => {
    // The column is certificate STATE as well as number. Anything that kept only values matching a
    // number pattern would silently drop ~100 records that say what happened to the application.
    assert.strictEqual(certificateOf(STATE_WORD), 'Withdrawn');
    assert.strictEqual(certificateOf({ track_project_id: 1, ea_certificate: 'N/A' }), 'N/A');
    assert.strictEqual(certificateOf({ track_project_id: 1, ea_certificate: 'WD09-01' }), 'WD09-01');
  });
});

test('backfillEacNumbers', async (t) => {
  await t.test('dry run is the default and writes nothing', async () => {
    const patch = fakePatch();
    const summary = await backfillEacNumbers([], {
      sources: fakeSources([WITH_CERT, NO_CERT]),
      projects: fakeProjects(['207', '354']),
      patch: patch.fn
    });

    assert.strictEqual(summary.mode, 'dry-run');
    assert.strictEqual(summary.total, 2);
    assert.strictEqual(summary.withCert, 1);
    assert.strictEqual(summary.patched, 0);
    assert.strictEqual(patch.calls.length, 0, 'a dry run must not patch');
  });

  await t.test('--live patches only the records carrying a value', async () => {
    const patch = fakePatch();
    const summary = await backfillEacNumbers(['--live'], {
      sources: fakeSources([WITH_CERT, NO_CERT, BLANK_CERT, WITH_CERT_2, STATE_WORD]),
      projects: fakeProjects(['207', '208', '209', '354', '355']),
      patch: patch.fn
    });

    assert.strictEqual(summary.total, 5);
    assert.strictEqual(summary.withCert, 3);
    assert.strictEqual(summary.patched, 3);
    assert.deepStrictEqual(patch.calls.map(c => c.id), ['207', '208', '209'],
      'a project with no certificate must not be touched at all');
    assert.strictEqual(patch.calls[2].ops[0].value, 'Withdrawn',
      'a state word is patched like any other value');
  });

  await t.test('the patch sets one field and never replaces the record', async () => {
    const patch = fakePatch();
    await backfillEacNumbers(['--live'], {
      sources: fakeSources([WITH_CERT]),
      projects: fakeProjects(['207']),
      patch: patch.fn
    });

    assert.deepStrictEqual(patch.calls[0].ops, [
      { op: 'set', path: '/eaCertificate', value: 'E05-01' }
    ]);
  });

  await t.test('a Track id with no Cosmos row is counted, not fatal', async () => {
    const patch = fakePatch();
    const summary = await backfillEacNumbers(['--live'], {
      sources: fakeSources([UNSEEDED, WITH_CERT]),
      projects: fakeProjects(['207']),
      patch: patch.fn
    });

    assert.strictEqual(summary.missingRow, 1);
    assert.strictEqual(summary.patched, 1, 'the run continues past the unseeded project');
    assert.deepStrictEqual(patch.calls.map(c => c.id), ['207']);
    assert.strictEqual(exitCodeFor(summary), 0, 'upstream drift is reported, not an error');
  });

  await t.test('a failed patch is counted, and the run continues', async () => {
    let first = true;
    const summary = await backfillEacNumbers(['--live'], {
      sources: fakeSources([WITH_CERT, WITH_CERT_2]),
      projects: fakeProjects(['207', '208']),
      patch: async () => { if (first) { first = false; throw new Error('429'); } }
    });

    assert.strictEqual(summary.failed, 1);
    assert.strictEqual(summary.patched, 1, 'one failure must not abandon the rest');
    assert.strictEqual(exitCodeFor(summary), 1);
  });

  await t.test('the checked-in export loads and counts its certificates', async () => {
    // Pinned to the 2026-08-31 export: 382 records, 342 with a non-empty `ea_certificate`.
    // A regenerated export moves these numbers; update them with it.
    const patch = fakePatch();
    const summary = await backfillEacNumbers(['--live'], {
      projects: fakeProjects([]), patch: patch.fn
    });

    assert.strictEqual(summary.total, 382);
    assert.strictEqual(summary.withCert, 342);
    assert.strictEqual(summary.missingRow, 342);
    assert.strictEqual(patch.calls.length, 0);
  });
});

test('summaryLine carries every count the alert reads', () => {
  assert.strictEqual(
    summaryLine({ mode: 'live', total: 382, withCert: 120, patched: 118, missingRow: 2 }),
    '[eac-backfill] mode=live total=382 withCert=120 patched=118 missingRow=2');
});

test('parseArgs refuses anything it does not understand', () => {
  // A typo'd flag silently ignored turns a live run into a dry run reporting success.
  assert.deepStrictEqual(parseArgs([]), { live: false });
  assert.deepStrictEqual(parseArgs(['--live']), { live: true });
  assert.throws(() => parseArgs(['--dry-run']), /unknown argument/);
});
