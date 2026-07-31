'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { filterFor, quote } = require('../../src/helpers/access-odata');
const { TIER } = require('../../src/helpers/access-sql');

const PUBLIC = { tier: TIER.PUBLIC, roles: ['public'], projectScope: null };
const ADMIN = { tier: TIER.PRIVILEGED, roles: ['public', 'sysadmin'], projectScope: null };
const SCOPED = { tier: TIER.SCOPED, roles: ['public', 'project-team'], projectScope: ['207'] };

test('access-odata filter', async (t) => {
  await t.test('privileged callers get no filter at all', () => {
    const { filter, empty } = filterFor(ADMIN);
    assert.strictEqual(filter, null, 'privileged is unrestricted, the same shape as SQL true');
    assert.strictEqual(empty, false);
  });

  await t.test('anonymous callers are restricted to the roles they hold', () => {
    const { filter, empty } = filterFor(PUBLIC);
    assert.strictEqual(empty, false);
    // read/any(...) is the collection form. Without `any` the filter compares the collection
    // itself and silently matches nothing, which on this path reads as an empty corpus.
    assert.match(filter, /^read\/any\(r: /);
    assert.ok(filter.includes("'public'"));
    assert.ok(!filter.includes('projectId'), 'an unscoped caller must not be project-restricted');
  });

  await t.test('scoped callers are restricted on projectId as well as roles', () => {
    const { filter } = filterFor(SCOPED);
    assert.match(filter, /read\/any\(r: /);
    assert.match(filter, /projectId/);
    assert.ok(filter.includes("'207'"));
    assert.match(filter, / and /, 'both dimensions apply, not either');
  });

  // A project IS its own scope, so on demi-projects the field is `id`. Scoping projects on a
  // `projectId` they do not carry would match nothing — and an empty result is indistinguishable
  // from an empty corpus, which is how this kind of bug survives review.
  await t.test('the scope field is per-index, not hardcoded', () => {
    const { filter } = filterFor(SCOPED, 'id');
    assert.match(filter, /(^|[^a-zA-Z])id/, 'projects scope on id');
    assert.ok(!/projectId/.test(filter), 'projects have no projectId field to scope on');
    assert.ok(filter.includes("'207'"));
  });

  // The default keeps every existing caller (chunks, documents) on projectId without change.
  await t.test('projectId remains the default', () => {
    assert.strictEqual(filterFor(SCOPED).filter, filterFor(SCOPED, 'projectId').filter);
  });

  // THE fail-closed test. OData has no `false` literal, so "may see nothing" cannot be written as
  // a filter — a null filter and an empty string are both UNRESTRICTED. The only correct answer
  // is to not issue the request, and `empty` is how that is signalled.
  await t.test('scoped to nothing reports empty rather than an unrestricted filter', () => {
    const { filter, empty } = filterFor({ tier: TIER.SCOPED, roles: ['public'], projectScope: [] });
    assert.strictEqual(empty, true, 'must tell the caller to issue no request');
    assert.strictEqual(filter, null);
  });

  await t.test('a missing access context fails closed, never open', () => {
    assert.deepStrictEqual(filterFor(null), { filter: null, empty: true });
    assert.deepStrictEqual(filterFor(undefined), { filter: null, empty: true });
  });

  // There is no bound-parameter form in an OData filter — the value IS the query text — so the
  // escaping is the only thing standing between a role name and the filter's meaning.
  await t.test('quotes in a value are escaped by doubling, per OData', () => {
    assert.strictEqual(quote("o'brien"), "'o''brien'");

    // Asserted as an exact literal rather than by searching for a fragment: the ESCAPED output
    // legitimately contains the injected text, so any substring test is ambiguous about whether
    // the quote was doubled. Only the whole literal shows that it was.
    const { filter } = filterFor({
      tier: TIER.PUBLIC,
      roles: ["public', fake/any(x: x eq 'sysadmin"],
      projectScope: null
    });
    assert.ok(
      filter.includes("r eq 'public'', fake/any(x: x eq ''sysadmin'"),
      'the whole injection must land inside one literal, with every quote doubled'
    );
    // Every quote is either a literal delimiter or half of a doubled pair, so the total is even.
    // An escape that dropped or added one would leave the filter unbalanced.
    assert.strictEqual((filter.match(/'/g) || []).length % 2, 0, 'quotes must stay balanced');
  });

  // A comma is the separator search.in() uses, so a value containing one would silently split
  // into two roles — granting a role nobody holds.
  await t.test('a value containing a comma falls back to an eq chain', () => {
    const { filter } = filterFor({
      tier: TIER.PUBLIC,
      roles: ['public', 'weird,role'],
      projectScope: null
    });
    assert.ok(!filter.includes('search.in'), 'search.in cannot express a value with a comma');
    assert.ok(filter.includes("r eq 'weird,role'"));
    assert.ok(filter.includes("r eq 'public'"));
  });
});
