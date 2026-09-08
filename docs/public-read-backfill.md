# Public-read backfill

`src/scripts/seed-public-reads.js` fills the containers behind eagle-public's remaining reads —
`lists`, `notifications`, `updates`, `commentPeriods` and `comments` — from eagle-api.

eagle-api pushes each of these to DEMI as it writes them, so steady state needs no help. The
backfill exists for the rows written before the push did: the whole corpus at cutover, and anything
eagle-api changes without going through a controller.

Every row except a `List` item is written by the same `mirrorFromEagle` function the push handler
calls, so a backfilled row and a pushed row are identical, down to the access list a comment period
takes from its project and a comment takes from its period. `List` is the exception because
eagle-api has no List write controller to push from: list items change by migration, and this script
is the only writer DEMI has for them.

## Order

The stages run in dependency order, and `--only` selects stages without reordering them:

1. `lists` — Eagle `List`
2. `organizations` — Eagle `Organization`, into the same container under `kind: Organization`
3. `notifications` — Eagle `ProjectNotification`
4. `updates` — Eagle `RecentActivity`
5. `commentPeriods` — Eagle `CommentPeriod`
6. `comments` — one pass per comment period over `/api/public/comment`

Projects come first of all, and they are not this script's: run `db:seed-nosql` before it. A comment
period whose parent is not in DEMI is skipped, and so is a comment whose period is not.

A period's parent is a project or a `ProjectNotification` — Eagle's `project` reference holds either
id, and prod publishes periods and documents under notifications. A notification-parented period is
stored under the notification's own id and keeps the access list Eagle published it with, because a
notification carries none of its own for the period to be narrowed against. That is the same rule
`seed-nosql` applies to a notification-parented document. Because the `notifications` stage runs
first, a period under one resolves on the same run.

## Running it

The script takes the environment from the settings the process starts with, never from a flag:
`EAGLE_API_BASE` chooses the source, `COSMOS_ENDPOINT` and `COSMOS_NOSQL_DATABASE` the target. On
the devbox, `demi-run` supplies all three — see the README, "Running anything against the database".

```bash
npm run db:seed-public-reads                      # dry run: fetches, counts, writes nothing
npm run db:seed-public-reads -- --live
npm run db:seed-public-reads -- --live --only lists
npm run db:seed-public-reads -- --live --since 2026-01-01
```

Each stage logs one line:

```
[backfill] commentPeriods: fetched=1204 written=1198 skipped=6 errors=0
```

`skipped` counts rows the run chose not to write — a row outside `--since`, or one whose parent is
not in DEMI. `errors` counts rows that failed to write; the first 20 are logged with their id.

A dry run reports `would-write` in place of `written` and touches nothing, including the state file.

### Resuming

A finished stage is recorded in the state file (`./seed-public-reads.state.json`, or `--state
<path>`) and a later run skips it. The comment stage records each comment period whose comments all
wrote, so a run killed part way through resumes at the period it stopped on rather than at the first
one.

`--only` overrides that: a stage named on the command line runs whether or not the state file says
it finished. Naming a stage is how a repair is asked for, and the stage needing repair is always one
that has completed before.

Nothing that failed is recorded: a period holding a comment that failed to write stays off the
per-period list, and a stage that logged errors is not marked complete. Both would otherwise be
skipped next time, leaving those rows missing for good.

Delete the state file to force a full rerun. Every write is an upsert, so replaying costs request
units and nothing else.

## After a List migration in eagle-api

A migration writes to Mongo directly and fires no push, so DEMI hears nothing. Run the list stage
against the environment the migration ran in:

```bash
npm run db:seed-public-reads -- --live --only lists
```

The state file will already hold a completed `lists` entry from the first backfill. `--only lists`
runs it anyway.

## What the backfill cannot recover

`/api/public/comment` removes the author from a comment submitted anonymously before it answers, so
a backfilled anonymous comment carries no author. A pushed one does, because eagle-api pushes the
raw record. This is invisible to the public either way — the author of an anonymous comment is
withheld at level 2 — but it is a real difference between a backfilled row and a pushed one, and
re-running the backfill will not fix it.

`--since` filters on `dateUpdated` or `dateAdded` after the fetch, because eagle-api's search takes
no date filter. It narrows what is written, never what is read, so it saves request units and not
time. A row carrying neither timestamp is written.

## Checking the result

`src/scripts/reconcile-eagle.js` diffs the ids Eagle publishes against the rows DEMI holds, for
these containers as well as projects and documents. It reports and deletes nothing.

```bash
node src/scripts/reconcile-eagle.js              # comment periods, lists, notifications, updates
node src/scripts/reconcile-eagle.js --comments   # and comments
```

Comments are behind a flag because the sweep costs one eagle-api request per comment period and one
Cosmos query per period — too much for the nightly timer, which is why the alert line says
`comments: skipped` when it was not asked for. A container the run did not sweep never reports zero
drift.

### Unresolved parents

A comment period Eagle publishes is not always a period DEMI should hold. eagle-api's
`dataset=CommentPeriod` gates on the period's own `read[]` and joins no parent, so a period stays in
the published set even when its project does not — while the mirror drops it, because there is no
DEMI parent row to hang it off. Those ids are reported under `unresolvedParent` and excluded from
`drift=`, the same treatment a document under an unresolvable parent already gets. Measured on test
2026-09-07: 29 periods under 20 unpublished projects, every one of them previously counted as push
drift.

The gate is the seed's own `documentAdmission`, so a period whose parent is a published
`ProjectNotification` resolves and is expected in DEMI, exactly as a document under one is. Both
sweeps read the notification partitions as well as the project ones.

`--comments` walks those unresolved period ids too, so Eagle's comments under them are reported
rather than silently missed — sweeping DEMI's periods alone never fetched them at all. They also
land under `unresolvedParent`.
