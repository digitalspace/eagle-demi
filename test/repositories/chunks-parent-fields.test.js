'use strict';

/**
 * The parent-document metadata a chunk carries a copy of, so a chunk query can filter on it without
 * resolving the documents first.
 *
 * What is asserted here is what is silent when it breaks: a missing key leaves the PREVIOUS value
 * on the chunk (a PATCH sets only what it names), so a document whose milestone was cleared would
 * keep answering the old milestone filter, under a 200 and a green indexer run.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const chunks = require('../../src/repositories/chunks');
const cosmos = require('../../src/db/cosmos-nosql');
const { systemAccess } = require('../../src/helpers/access-sql');

const DOCUMENT = {
  id: 'docA',
  projectId: '207',
  typeId: '5cf00c03a266b7e1877504db',
  milestoneId: '5cf00c03a266b7e1877504ef',
  projectPhaseId: '5cf00c03a266b7e1877504f0',
  documentAuthorTypeId: '5cf00c03a266b7e1877504dc'
};

/** Captures the operations one bulk patch would send, without a Cosmos client. */
function stubPatch(t, ids) {
  const sent = [];
  let queries = 0;
  t.mock.method(cosmos, 'query', async () => {
    queries += 1;
    return { items: ids, continuationToken: null };
  });
  sent.queries = () => queries;
  // `opts` is captured, not discarded: the retry budget a caller names rides there and nothing else
  // observes it, so a double that dropped it would agree with a repository that dropped it too.
  t.mock.method(cosmos, 'bulkVerified', async (container, operations, opts = {}) => {
    sent.push({ container, operations, opts });
    return {
      succeeded: operations.length, failed: 0, statusCounts: {}, requestCharge: 1,
      failedIds: [], skippedIds: []
    };
  });
  return sent;
}

const STAMPED_AT = '2026-09-10T12:00:00.000Z';

/**
 * Captures the bulk request a GUARDED walk sends, and answers it through the REAL `bulkVerified`
 * over a faked transport: how a per-operation status becomes `succeeded`, `failedIds` or
 * `skippedIds` is the data layer's rule, and a double that restated it here would agree with a
 * broken one. `answers` maps a chunk id to the status Cosmos gives that operation — 412 is "a newer
 * walk already stamped this chunk".
 */
function stubGuardedPatch(t, ids, answers = {}) {
  const sent = [];
  const bulkVerified = cosmos.bulkVerified;
  t.mock.method(cosmos, 'query', async () => ({ items: ids, continuationToken: null }));
  t.mock.method(cosmos, 'patch', async () => {
    throw new Error('a chunk patch must ride the bulk path, not one request per chunk');
  });
  t.mock.method(cosmos, 'bulkVerified', async (container, operations) => {
    sent.push({ container, operations });
    return bulkVerified(container, operations, {
      maxAttempts: 1,
      bulkFn: async (pending) => pending.map(op => ({
        statusCode: answers[op.id] || 200, requestCharge: 1
      }))
    });
  });
  return sent;
}

/** The single bulk request a guarded walk sent, one entry per chunk. */
const opsOf = (sent) => sent[0].operations;

test('chunks.parentFieldsOf', async (t) => {
  await t.test('carries exactly the fields the chunks index declares, plus the version', () => {
    assert.deepStrictEqual(Object.keys(chunks.parentFieldsOf(DOCUMENT)),
      [...chunks.CHUNK_PARENT_FIELDS, 'parentFieldsVersion']);
  });

  await t.test('stamps the CURRENT version, so every writer marks its own chunks', () => {
    // Every write path — the chunk build, the propagation patch, the seed re-stamp, both backfills
    // — goes through here, which is what makes the stamp impossible to forget on one of them.
    assert.strictEqual(chunks.parentFieldsOf(DOCUMENT).parentFieldsVersion,
      chunks.CHUNK_PARENT_FIELDS_VERSION);
    assert.strictEqual(chunks.parentFieldsOf({}).parentFieldsVersion,
      chunks.CHUNK_PARENT_FIELDS_VERSION,
      'a document with no List refs is still STAMPED — that is the whole point of the version');
  });

  await t.test('a field the document does not have is null, never absent', () => {
    // Absent is the dangerous one: `setFieldsForDocument` emits one `set` per KEY, so a key left
    // out leaves whatever the chunk already held. A document that lost its milestone would keep
    // matching the old milestone filter.
    const fields = chunks.parentFieldsOf({ id: 'docA', projectId: '207', typeId: 'abc' });

    assert.deepStrictEqual(fields, {
      projectId: '207',
      typeId: 'abc', milestoneId: null, projectPhaseId: null, documentAuthorTypeId: null,
      parentFieldsVersion: chunks.CHUNK_PARENT_FIELDS_VERSION
    });
    for (const field of chunks.CHUNK_PARENT_FIELDS) {
      assert.ok(field in fields, `${field} is absent, so a PATCH would not clear it`);
    }
  });

  await t.test('values are strings, because the index column is Edm.String', () => {
    // An ObjectId or a number handed to the indexer under an Edm.String field indexes as null, and
    // the filter that was meant to match it then matches nothing under a 200.
    const fields = chunks.parentFieldsOf({ typeId: 12, milestoneId: { toString: () => 'oid' } });

    assert.strictEqual(fields.typeId, '12');
    assert.strictEqual(fields.milestoneId, 'oid');
  });

  await t.test('a missing document is all nulls, not a throw', () => {
    assert.deepStrictEqual(chunks.parentFieldsOf(undefined), {
      projectId: null,
      typeId: null, milestoneId: null, projectPhaseId: null, documentAuthorTypeId: null,
      parentFieldsVersion: chunks.CHUNK_PARENT_FIELDS_VERSION
    });
  });
});

/**
 * The stamp that orders two walks over one document.
 *
 * Without it the last patch to land wins whatever it was serving: a walk that started before an
 * edit finishes after the walk serving that edit, puts the superseded values back on the chunks,
 * and the pending flag is already down — so the filter answers from stale metadata and nothing in
 * the corpus says so.
 */
test('chunks.parentStampFieldsOf', async (t) => {
  await t.test('is the parent fields plus the walk the chunk was born in', () => {
    assert.deepStrictEqual(chunks.parentStampFieldsOf(DOCUMENT, STAMPED_AT), {
      ...chunks.parentFieldsOf(DOCUMENT),
      [chunks.STAMPED_AT_FIELD]: STAMPED_AT
    });
  });

  await t.test('a stamp that is not an ISO instant is refused', () => {
    // It reaches a patch condition as a raw string — the SDK binds no parameters there — so the
    // shape is checked at every door the value can enter through.
    assert.throws(() => chunks.parentStampFieldsOf(DOCUMENT, '2026-09-10'), TypeError);
    assert.throws(() => chunks.parentStampFieldsOf(DOCUMENT, undefined), TypeError);
    assert.throws(
      () => chunks.parentStampFieldsOf(DOCUMENT, '2026-09-10T12:00:00.000Z" OR true OR "'),
      TypeError);
  });
});

test('chunks.parentFieldsChanged', async (t) => {
  await t.test('an edit that moves nothing is not a change', () => {
    assert.strictEqual(chunks.parentFieldsChanged(DOCUMENT, { ...DOCUMENT, displayName: 'new' }),
      false);
  });

  await t.test('absent and null are the same value', () => {
    // A row seeded before the List ids existed has no `typeId` PROPERTY at all. Reading that as a
    // change would re-patch every chunk of the corpus with the nulls they already hold.
    assert.strictEqual(chunks.parentFieldsChanged({ id: 'docA' }, { id: 'docA', typeId: null }),
      false);
  });

  await t.test('each parent field on its own is a change', () => {
    for (const field of chunks.CHUNK_PARENT_FIELDS) {
      assert.strictEqual(
        chunks.parentFieldsChanged(DOCUMENT, { ...DOCUMENT, [field]: 'moved' }), true,
        `${field} moved and was not reported`);
    }
  });

  await t.test('a field being cleared is a change', () => {
    assert.strictEqual(chunks.parentFieldsChanged(DOCUMENT, { ...DOCUMENT, milestoneId: null }),
      true);
  });
});

test('chunks.setParentFieldsForDocument', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('patches every chunk of the document, in its own partition', async () => {
    const sent = stubPatch(t, ['docA::p1::c0', 'docA::p1::c1', 'docA::p2::c0']);

    const result = await chunks.setParentFieldsForDocument(systemAccess(), 'docA', DOCUMENT);

    assert.strictEqual(result.chunks, 3);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].container, chunks.CONTAINER);
    assert.deepStrictEqual(sent[0].operations.map(op => op.id),
      ['docA::p1::c0', 'docA::p1::c1', 'docA::p2::c0']);
    // The partition key is the DOCUMENT id, not the project — a bulk request cannot span
    // partitions, and this container is the one place those two differ.
    for (const op of sent[0].operations) {
      assert.strictEqual(op.operationType, 'Patch');
      assert.strictEqual(op.partitionKey, 'docA');
    }
  });

  await t.test('sets every parent field and the version on each chunk', async () => {
    const sent = stubPatch(t, ['docA::p1::c0']);

    await chunks.setParentFieldsForDocument(systemAccess(), 'docA', DOCUMENT);

    // The propagation path is one of the writers the completeness probe counts. Patching the values
    // without the version leaves a correctly-stamped chunk indistinguishable from an unvisited one.
    assert.deepStrictEqual(sent[0].operations[0].resourceBody.operations, [
      { op: 'set', path: '/projectId', value: DOCUMENT.projectId },
      { op: 'set', path: '/typeId', value: DOCUMENT.typeId },
      { op: 'set', path: '/milestoneId', value: DOCUMENT.milestoneId },
      { op: 'set', path: '/projectPhaseId', value: DOCUMENT.projectPhaseId },
      { op: 'set', path: '/documentAuthorTypeId', value: DOCUMENT.documentAuthorTypeId },
      { op: 'set', path: '/parentFieldsVersion', value: chunks.CHUNK_PARENT_FIELDS_VERSION }
    ]);
  });

  await t.test('setFieldsForChunks patches the named rows and reads no id list', async () => {
    // What the backfill rides: it has already read which rows disagree, and the whole-document
    // helper would re-query the partition and patch the rows that are already correct.
    const sent = stubPatch(t, ['docA::p1::c0', 'docA::p1::c1', 'docA::p2::c0']);

    const result = await chunks.setFieldsForChunks(
      systemAccess(), 'docA', ['docA::p1::c1'], chunks.parentFieldsOf(DOCUMENT));

    assert.strictEqual(result.chunks, 1);
    assert.deepStrictEqual(sent[0].operations.map(op => op.id), ['docA::p1::c1']);
    assert.strictEqual(sent.queries(), 0, 'the caller supplied the ids, so nothing is re-read');
  });

  await t.test('setFieldsForChunks passes the caller\'s retry budget to the bulk write', async () => {
    // Where the backfill's `--max-attempts` lands. Dropping it costs nothing visible here and the
    // whole walk on a sustained throttle, which is the case the budget exists for.
    const sent = stubPatch(t, ['docA::p1::c0']);

    await chunks.setFieldsForChunks(
      systemAccess(), 'docA', ['docA::p1::c0'], chunks.parentFieldsOf(DOCUMENT),
      { stampedAt: STAMPED_AT, maxAttempts: 12 });
    await chunks.setFieldsForChunks(
      systemAccess(), 'docA', ['docA::p1::c0'], chunks.parentFieldsOf(DOCUMENT));

    assert.strictEqual(sent[0].opts.maxAttempts, 12, 'the budget the caller asked for');
    // Absent, not `undefined`: the data layer's own default has to stay reachable for the request
    // paths that share this write, which name no budget at all.
    assert.ok(!('maxAttempts' in sent[1].opts),
      'a caller that named no budget must not send a key that overrides the default');
  });

  await t.test('a document with no chunks writes nothing', async () => {
    const sent = stubPatch(t, []);

    const result = await chunks.setParentFieldsForDocument(systemAccess(), 'docA', DOCUMENT);

    assert.strictEqual(result.chunks, 0);
    assert.strictEqual(sent.length, 0, 'an empty bulk request is a billed round trip for nothing');
  });
});

test('a guarded re-stamp only overwrites chunks older than itself', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('every chunk is patched under the ordering condition, in one request', async () => {
    const sent = stubGuardedPatch(t, ['docA::p1::c0', 'docA::p1::c1']);

    const result = await chunks.setParentFieldsForDocument(
      systemAccess(), 'docA', DOCUMENT, { stampedAt: STAMPED_AT });

    assert.strictEqual(result.chunks, 2);
    assert.strictEqual(result.succeeded, 2);
    // One bulk request, not one per chunk: a corpus walk is 400k+ chunks, and the guard must not
    // cost a round trip each.
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].container, chunks.CONTAINER);
    assert.deepStrictEqual(opsOf(sent).map(op => op.id), ['docA::p1::c0', 'docA::p1::c1']);
    for (const op of opsOf(sent)) {
      assert.strictEqual(op.operationType, 'Patch');
      assert.strictEqual(op.partitionKey, 'docA');
      // A chunk stamped by this walk or a newer one keeps what it has. `<`, never `<=`: a re-run of
      // the SAME walk has nothing left to say either.
      assert.strictEqual(op.resourceBody.condition,
        'FROM c WHERE NOT IS_DEFINED(c.parentStampedAt) ' +
        `OR c.parentStampedAt < "${STAMPED_AT}"`);
    }
  });

  await t.test('the walk writes its own token, so the next walk can order itself', async () => {
    const sent = stubGuardedPatch(t, ['docA::p1::c0']);

    await chunks.setParentFieldsForDocument(
      systemAccess(), 'docA', DOCUMENT, { stampedAt: STAMPED_AT });

    // Without this op the condition never advances: every later walk sees an unstamped chunk and
    // the guard passes for all of them, which is the last-writer-wins it replaced.
    assert.deepStrictEqual(opsOf(sent)[0].resourceBody.operations.at(-1),
      { op: 'set', path: '/parentStampedAt', value: STAMPED_AT });
    assert.deepStrictEqual(opsOf(sent)[0].resourceBody.operations.map(op => op.path),
      ['/projectId', '/typeId', '/milestoneId', '/projectPhaseId', '/documentAuthorTypeId',
        '/parentFieldsVersion', '/parentStampedAt']);
  });

  await t.test('a 412 is "already newer", counted apart from a failure', async () => {
    const sent = stubGuardedPatch(t, ['c0', 'c1', 'c2'], { c1: 412 });

    const result = await chunks.setFieldsForChunks(
      systemAccess(), 'docA', ['c0', 'c1', 'c2'], chunks.parentFieldsOf(DOCUMENT),
      { stampedAt: STAMPED_AT });

    assert.strictEqual(result.skippedNewer, 1);
    assert.strictEqual(result.failed, 0,
      'a chunk a newer walk stamped is current — counting it failed sends the repair after it');
    assert.strictEqual(result.succeeded, 2);
    assert.deepStrictEqual(result.statusCounts, { 200: 2, 412: 1 });
    assert.strictEqual(result.requestCharge, 3,
      'the guarded walk bills RU like any other write, and a summary that read 0 hid it');
    assert.strictEqual(opsOf(sent).length, 3, 'one rejection does not stop the walk');
  });

  await t.test('any other Cosmos status is still a failure, named by chunk', async () => {
    stubGuardedPatch(t, ['c0', 'c1'], { c0: 404, c1: 400 });

    const result = await chunks.setFieldsForChunks(
      systemAccess(), 'docA', ['c0', 'c1'], chunks.parentFieldsOf(DOCUMENT),
      { stampedAt: STAMPED_AT });

    assert.strictEqual(result.failed, 2);
    assert.strictEqual(result.skippedNewer, 0);
    assert.deepStrictEqual(result.failedIds, ['c0', 'c1']);
  });

  await t.test('a request that threw is not swallowed as a rejected write', async () => {
    t.mock.method(cosmos, 'query', async () => ({ items: ['c0'], continuationToken: null }));
    t.mock.method(cosmos, 'bulkVerified', async () => {
      throw new TypeError('condition is malformed');
    });

    await assert.rejects(() => chunks.setFieldsForChunks(
      systemAccess(), 'docA', ['c0'], chunks.parentFieldsOf(DOCUMENT), { stampedAt: STAMPED_AT }),
    TypeError);
  });

  await t.test('a malformed token writes nothing at all', async () => {
    const sent = stubGuardedPatch(t, ['c0']);

    await assert.rejects(() => chunks.setParentFieldsForDocument(
      systemAccess(), 'docA', DOCUMENT, { stampedAt: 'now' }), TypeError);
    assert.strictEqual(sent.length, 0);
  });

  await t.test('an unguarded caller sends no condition at all', async () => {
    // The ingest and ACL paths pass no token: they are not racing another walk, and a condition
    // there would refuse writes nothing is ordering.
    const sent = stubPatch(t, ['c0', 'c1']);

    const result = await chunks.setParentFieldsForDocument(systemAccess(), 'docA', DOCUMENT);

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(result.skippedNewer, 0);
    assert.strictEqual(sent[0].operations[0].resourceBody.condition, undefined);
    assert.ok(!sent[0].operations[0].resourceBody.operations
      .some(op => op.path === '/parentStampedAt'),
    'an unguarded write must not claim a walk it is not ordered against');
  });
});

/**
 * `reStampAfterWrite` — the one copy of the loop the seed and both backfills used to keep three of.
 *
 * The counters are the point: a document that THREW and a chunk operation Cosmos REJECTED went into
 * the same number, and one document is ~19 chunk operations, so the figure the operator used to
 * decide whether to run the repair could be out by an order of magnitude either way.
 */
test('chunks.reStampAfterWrite', async (t) => {
  const ok = (chunks_) => ({ succeeded: chunks_, failed: 0, statusCounts: { 200: chunks_ },
    requestCharge: chunks_, chunks: chunks_ });

  /** Records the documents that reached Cosmos; `results` decides what each one answers. */
  function fakeStamp(results = {}) {
    const seen = [];
    const stamp = async (access, id) => {
      seen.push(String(id));
      const answer = results[String(id)];
      if (answer instanceof Error) throw answer;
      return answer || ok(19);
    };
    return { seen, stamp };
  }

  await t.test('counts documents and chunk operations separately', async () => {
    const { stamp } = fakeStamp({
      d2: { succeeded: 15, failed: 4, statusCounts: { 200: 15, 429: 4 }, requestCharge: 19 },
      d3: new Error('cosmos unavailable')
    });

    const result = await chunks.reStampAfterWrite(systemAccess(),
      [{ id: 'd1' }, { id: 'd2' }, { id: 'd3' }], [], { stamp });

    assert.strictEqual(result.stamped, 1, 'documents fully re-stamped');
    assert.strictEqual(result.failedDocuments, 2, 'one threw, one lost chunks — both documents');
    assert.strictEqual(result.failedChunks, 4, 'chunk OPERATIONS, and a throw contributes none');
    assert.strictEqual(result.chunks, 34, 'chunk operations that landed');
  });

  await t.test('names the documents behind the counts, so the flag can be cleared per document', async () => {
    // Counts cannot say WHICH document lost a chunk, and the caller has to clear the pending flag
    // on the ones that landed while leaving it raised on the ones that did not. Clearing on the
    // count alone takes a still-stale document off the reconcile line.
    const { stamp } = fakeStamp({
      d2: { succeeded: 15, failed: 4, statusCounts: { 429: 4 }, requestCharge: 19 },
      d3: new Error('cosmos unavailable')
    });

    const result = await chunks.reStampAfterWrite(systemAccess(),
      [{ id: 'd1' }, { id: 'd2' }, { id: 'd3' }, { id: 'd4' }], ['d4'], { stamp });

    assert.deepStrictEqual(result.stampedDocumentIds, ['d1']);
    assert.deepStrictEqual(result.failedDocumentIds, ['d2', 'd3'],
      'a lost chunk operation fails its document as surely as a throw does');
    assert.strictEqual(result.stampedDocumentIds.length, result.stamped);
    assert.strictEqual(result.failedDocumentIds.length, result.failedDocuments);
    assert.ok(!result.stampedDocumentIds.includes('d4'),
      'a skipped document is in neither list — its row write never landed');
  });

  await t.test('every document is accounted for exactly once', async () => {
    // The invariant that makes the three counters readable as a whole: nothing is dropped, and no
    // document is both stamped and failed.
    const { stamp } = fakeStamp({ d3: new Error('cosmos unavailable') });
    const docs = [{ id: 'd1' }, { id: 'd2' }, { id: 'd3' }, { id: 'd4' }];

    const result = await chunks.reStampAfterWrite(systemAccess(), docs, ['d4'], { stamp });

    assert.strictEqual(result.stamped + result.failedDocuments + result.skipped, docs.length);
    assert.strictEqual(result.skipped, 1);
  });

  await t.test('a document whose row write was rejected is skipped, never stamped', async () => {
    // Re-stamping on the strength of a rejected write puts a value in the chunks that no document
    // row holds, so the chunk answers a filter its own document does not match.
    const { seen, stamp } = fakeStamp();

    const result = await chunks.reStampAfterWrite(systemAccess(),
      [{ id: 'd1' }, { id: 'd2' }], ['d2'], { stamp });

    assert.deepStrictEqual(seen, ['d1']);
    assert.strictEqual(result.skipped, 1);
    assert.strictEqual(result.stamped, 1);
  });

  await t.test('onError fires once per document, whatever the document holds', async () => {
    // What the log cap counts. Firing per rejected chunk operation is how a cap of five went quiet
    // after the first document, hiding a corpus-wide fault behind one id.
    const { stamp } = fakeStamp({
      d1: new Error('first'), d2: new Error('second'),
      d3: { succeeded: 0, failed: 19, statusCounts: { 429: 19 } }
    });
    const errors = [];

    const result = await chunks.reStampAfterWrite(systemAccess(),
      [{ id: 'd1' }, { id: 'd2' }, { id: 'd3' }], [], {
        stamp, onError: (doc, err) => errors.push(`${doc.id}:${err.message}`)
      });

    assert.deepStrictEqual(errors, ['d1:first', 'd2:second'],
      'nothing throws for a rejected chunk operation — it arrives as a status count');
    assert.strictEqual(result.failedChunks, 19);
  });

  await t.test('a throw does not stop the documents behind it', async () => {
    // The document rows are authoritative and have landed; aborting would leave the rest of a 60k
    // corpus carrying chunk values nothing will ever refresh.
    const { seen, stamp } = fakeStamp({ d1: new Error('cosmos unavailable') });

    await chunks.reStampAfterWrite(systemAccess(), [{ id: 'd1' }, { id: 'd2' }], [], { stamp });

    assert.deepStrictEqual(seen, ['d1', 'd2']);
  });

  await t.test('sums the RU and the status counts across documents', async () => {
    const { stamp } = fakeStamp({ d1: ok(2), d2: { ...ok(1), statusCounts: { 200: 1, 429: 3 } } });

    const result = await chunks.reStampAfterWrite(systemAccess(),
      [{ id: 'd1' }, { id: 'd2' }], [], { stamp });

    assert.strictEqual(result.requestCharge, 3);
    assert.deepStrictEqual(result.statusCounts, { 200: 3, 429: 3 });
  });

  await t.test('hands every document the walk it is serving', async () => {
    // The token has to reach the chunk patches or the guard is not there at all — and the walk is
    // one instant, not one per document, so a document that arrives late in a long batch is still
    // ordered against the walk that read it.
    const seen = [];
    const stamp = async (access, id, doc, options) => {
      seen.push(options && options.stampedAt);
      return ok(19);
    };

    await chunks.reStampAfterWrite(systemAccess(), [{ id: 'd1' }, { id: 'd2' }], [],
      { stamp, stampedAt: STAMPED_AT });

    assert.deepStrictEqual(seen, [STAMPED_AT, STAMPED_AT]);
  });

  await t.test('chunks a newer walk already stamped do not fail their document', async () => {
    // The whole point of the guard: this walk is stale for those chunks, and the document is
    // current because a newer walk wrote it. Counting that as a failure leaves the pending flag
    // raised and sends the repair after a document nothing is wrong with.
    const stamp = async (access, id) => (id === 'd2'
      ? { succeeded: 0, failed: 0, skippedNewer: 19, statusCounts: { 412: 19 }, requestCharge: 0 }
      : { ...ok(19), skippedNewer: 4 });

    const result = await chunks.reStampAfterWrite(systemAccess(),
      [{ id: 'd1' }, { id: 'd2' }], [], { stamp, stampedAt: STAMPED_AT });

    assert.strictEqual(result.skippedNewer, 23);
    assert.strictEqual(result.failedDocuments, 0);
    assert.deepStrictEqual(result.stampedDocumentIds, ['d1', 'd2']);
  });

  await t.test('patches through setParentFieldsForDocument when no seam is given', async (t2) => {
    // The seam is for the scripts' repository doubles. Production passes none, so the default is
    // the only thing that reaches Cosmos, and a broken default would be invisible in every other
    // test here.
    const sent = stubPatch(t2, ['docA::p1::c0']);

    const result = await chunks.reStampAfterWrite(systemAccess(), [DOCUMENT]);

    assert.strictEqual(result.stamped, 1);
    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(sent[0].operations[0].resourceBody.operations.map(op => op.path),
      ['/projectId', '/typeId', '/milestoneId', '/projectPhaseId', '/documentAuthorTypeId',
        '/parentFieldsVersion']);
    t2.mock.restoreAll();
  });
});

// The ACL patch now rides the same generic helper. Its shape is a visibility boundary, so it is
// re-asserted here rather than left to the generalization to preserve by inspection.
test('chunks.setAclForDocument still writes read[] and its isPublished mirror', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a public ACL sets both, in that order', async () => {
    const sent = stubPatch(t, ['docA::p1::c0']);

    const result = await chunks.setAclForDocument(systemAccess(), 'docA', ['public', 'sysadmin']);

    assert.strictEqual(result.chunks, 1);
    assert.deepStrictEqual(sent[0].operations[0].resourceBody.operations, [
      { op: 'set', path: '/read', value: ['public', 'sysadmin'] },
      { op: 'set', path: '/isPublished', value: true }
    ]);
  });

  await t.test('a private ACL mirrors false', async () => {
    const sent = stubPatch(t, ['docA::p1::c0']);

    await chunks.setAclForDocument(systemAccess(), 'docA', ['sysadmin']);

    assert.strictEqual(sent[0].operations[0].resourceBody.operations[1].value, false);
  });

  await t.test('an empty ACL is refused before anything is read', async () => {
    // Fail closed: a chunk with no ladder token matches nobody, and clearing an ACL through this
    // door would be a takedown nobody audited.
    const sent = stubPatch(t, ['docA::p1::c0']);

    await assert.rejects(() => chunks.setAclForDocument(systemAccess(), 'docA', []), TypeError);
    assert.strictEqual(sent.length, 0);
  });
});

test('chunks.parentFieldRowsForDocument', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('reads the ids and the four fields, and nothing else', async () => {
    // The backfill makes this read ONCE PER DOCUMENT over ~61k documents, so the projection is the
    // whole cost. `content` in it would pull the corpus back through the script.
    let spec = null;
    let options = null;
    t.mock.method(cosmos, 'query', async (container, s, o) => {
      spec = s; options = o;
      return { items: [], continuationToken: null };
    });

    await chunks.parentFieldRowsForDocument(systemAccess(), 'docA');

    assert.strictEqual(spec.query.split(' FROM ')[0].replace('SELECT ', ''),
      ['c.id', ...chunks.CHUNK_PARENT_FIELDS.map(f => `c.${f}`), 'c.parentFieldsVersion'].join(', '),
      'the version has to come back or every row reads as unstamped and the backfill never ends');
    assert.strictEqual(options.partitionKey, 'docA',
      'a cross-partition read per document would scan 1.1M chunks each time');
  });

  await t.test('chunkMatchesParent compares the values AND the version', async () => {
    const nothing = chunks.parentFieldsOf({});
    const V = chunks.CHUNK_PARENT_FIELDS_VERSION;

    // The case the whole stamp exists for. A document with no List refs and a chunk carrying four
    // nulls agree on every value, so values alone cannot say whether that chunk was ever visited.
    assert.strictEqual(
      chunks.chunkMatchesParent({ id: 'c0', parentFieldsVersion: V }, nothing), true,
      'a stamped chunk of a document with nothing to copy is finished, not outstanding');
    assert.strictEqual(chunks.chunkMatchesParent({ id: 'c0' }, nothing), false,
      'four nulls and NO version is an unstamped chunk and must still be re-stamped');

    // An older stamp is a mismatch however right the values look — that is what makes a version
    // bump re-walk the corpus after CHUNK_PARENT_FIELDS grows.
    assert.strictEqual(
      chunks.chunkMatchesParent({ ...DOCUMENT, parentFieldsVersion: V - 1 },
        chunks.parentFieldsOf(DOCUMENT)), false);
    assert.strictEqual(
      chunks.chunkMatchesParent({ ...DOCUMENT, parentFieldsVersion: V },
        chunks.parentFieldsOf(DOCUMENT)), true);

    // The value comparison still has to hold on its own.
    assert.strictEqual(
      chunks.chunkMatchesParent({ id: 'c0', typeId: 'stale', parentFieldsVersion: V }, nothing),
      false, 'a chunk holding a value its document dropped is NOT a match');
    assert.strictEqual(
      chunks.chunkMatchesParent({ id: 'c0', typeId: DOCUMENT.typeId, parentFieldsVersion: V },
        chunks.parentFieldsOf(DOCUMENT)),
      false, 'the other three still have to agree');
  });
});
