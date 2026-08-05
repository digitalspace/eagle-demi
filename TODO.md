# TODO

Open work only. Facts, measurements and history live in the
[wiki](https://github.com/digitalspace/eagle-demi/wiki); if something here needs a paragraph of
background, that background belongs there and this entry links to it.

Dev only. `main` is deployed and current as of 2026-08-04.

---

## Label debt

The retrieval scorecard is the verdict metric for extraction quality. It now rests on 78 labels
across five strata, all of them verified by a human reading the source rather than seeded from
metadata.

- [ ] **The tiled stratum has 9 labels and no more renders to read.** The seven renders in
      `/root/demi-tiled-review/` were read by eye on 2026-08-04 and labelled; going past 9 means
      rendering more map sheets from the object store, where ~1,496 source PDFs 404.
- [ ] **No OCR-scan stratum exists.** `retrieval-labels-ocr.jsonl` was deleted rather than scored:
      its 25 lines were seeded from document TITLES, which are metadata and were never verified to
      be on the page, and 13 were marked STARVED. Rebuilding it needs renders of scans that mostly
      cannot be fetched. `B-ocr-legacy` and `C-ocr-pdfium` still cover the OCR paths.

Pooled recall@10 is 0.590 at n=78 (recall@1 0.308, MRR 0.392). One standard error is ~0.056, so it
is the same number as the 0.620 recorded at n=71 — the labels moved, the retrieval did not.

## Retrieval — the ranking failure is fixed

Closed 2026-08-05. It was a ranking problem, and a reranker fixed it.
`58869332de49fe015163a0c9` ("CROSS SECTIONS N AND A THROUGH NORTH WASTE DUMPS") ranked **11** under
BM25 and ranks **2** with semantic reranking on. Paired run, 78 labels, one session:

| | recall@1 | recall@10 | recall@50 | MRR |
|---|---|---|---|---|
| BM25 | 0.308 | 0.590 | 0.705 | 0.398 |
| + semantic ranker | **0.372** | **0.628** | 0.705 | **0.472** |

5 miss→hit and 2 hit→miss at k=10; 23 labels moved up, 7 down, 25 unchanged. `found@50` is
identical at 55 in both arms — the check that L1 was untouched, since a reranker can only reorder
what BM25 already retrieved. The textless control stays 0 in both arms.

Honest limit: 5 versus 2 discordant pairs is not significant on its own (one SE ~0.056). The case
is that all three metrics move together with nothing regressing — the bar `FUZZY_BOOST` cleared and
`anyTerms` failed. Scorecards in `src/scripts/scorecards/2026-08-05-*`.

- [ ] **Nothing measures this for natural-language queries.** All 78 labels are verbatim phrases
      lifted off a page, which is exact-match lexical retrieval — the weakest case for a reranker
      trained on natural language. It won anyway. But the queries real users type are the case the
      feature is actually for, and no label set covers them; there is no query log to build one from
      because nobody uses DEMI yet. The gain above is a floor, not an estimate.

## Extraction

- [ ] **`pageNumber` is a citation feature and nothing cites. Do not build it yet.** It is a sequence
      number on both paths, not a PDF page, and making it real needs host, wire-protocol and API
      changes *plus* re-extraction — it does not ride a re-chunk. Nothing consumes it: no PDF viewer
      and no `#page=` anchor in the frontend, which renders it honestly as `Passage N`. If citations
      are ever wanted, the cheap slice is the text path (56% of the corpus, pypdfium2, no GPU), but it
      still needs source PDFs and ~1,496 already 404 in the dev object store. Whether a browser
      honours `#page=N` on a presigned URL depends on the object being served inline rather than as an
      attachment, which is unverified. Background:
      [Extraction Pipeline](https://github.com/digitalspace/eagle-demi/wiki/Extraction-Pipeline).
- [ ] **The intake cleaner is intake-only.** Chunks already written keep their `<!-- image -->`
      placeholders and their separator-furniture rows; only new ingest is clean. Nothing here is
      worth a re-extraction on its own — fold it into whatever re-extraction happens next.

## NRPTI ingest

- [ ] **NRPTI auto-seeds projects that are not projects, and nothing ever removes them.**
      `src/scripts/sync-nrpti.js` tries five ways to link a compliance record to an existing project
      (`_epicProjectId`, exact name, normalized name, name segments, token inclusion) and then, at
      Priority 4, **invents one** from `item.projectName || item.location` — a synthetic id
      `8000000 + hash(name) % 1000000`, `projectState: 'Compliance Record Ingest'`, a centroid
      hardcoded to Victoria, and `read: ['public', …]` so it is publicly listed like a real project.
      Many of those names are facilities, locations or record titles, not EPIC projects, so the
      registry gains rows that no project ever existed for.
      The fix is to delete Priority 4: link only when Track or Eagle already has the project, and
      leave the record unlinked otherwise. Two things must be decided at the same time, because both
      are load-bearing:
      - **What an unlinked record becomes.** Today the no-name path writes `projectId: ''`, which is
        the empty-string partition — reachable by no scoped read, so the record is ingested and then
        invisible. Either that is accepted deliberately (an unmatched-records bucket someone can
        query) or unmatched records should not be written at all. Do not leave it as an accident.
      - **The link is not free to change later.** `projectId` is the records container's PARTITION
        KEY, so re-pointing a record at the right project is a delete plus an insert, not an update.
      - [ ] **Purge the seeded stragglers**, which is a separate job from the gate: a script over
            `metadata.seededFromNrpti === true` / `sourceSystem === 'nrpti'` that deletes the project
            AND calls `aiSearch.deleteFromIndex` for it. Indexers never see deletes — drop that
            second half and the phantom projects stay searchable forever even once Cosmos is clean.
            Then re-point or drop the records that referenced them.
      Measured 2026-08-05, and the measurement is thin: `/api/projects` returns 382 rows, all
      `sourceSystem: 'track'`, and the first 250 rows of the `demi-projects` index carry no synthetic
      id — so under PUBLIC access, on dev, there is nothing to purge right now and the gate is what
      actually matters before the next `POST /admin/sync/nrpti`. That read cannot see past ACLs and
      the list endpoint ignores `pageNum`, so it is not proof the containers are clean. Count with
      `systemAccess()` before concluding the purge is a no-op.

## Infrastructure

- [ ] **CI is blocked.** `AZURE_CLIENT_ID` is missing from repo secrets. It needs an Entra app
      registration with a federated credential, and creating one needs Microsoft Graph, which
      conditional access blocks. Manual deploy is the working path meanwhile, and every merge to
      `main` will keep showing a red "Deploy DEMI to Azure Dev" that fails at the Azure Login step.
- [ ] **Phase 3b, blob storage.** Code and Bicep written, nothing deployed or copied; wired into
      `main.bicep` behind `deployDocumentStorage`, which defaults false. The argument is
      per-environment isolation, not cost. Needs `Storage Blob Delegator` on the identity or every
      download link fails to sign — it is not implied by `Storage Blob Data Contributor`.
- [ ] **`main.bicep` has never been deployed and still should not be.** It now describes dev
      accurately — `az deployment group what-if` reports zero creates and zero deletes against the
      live group — but it has never actually run, and `azure-deploy-dev.yaml`'s infra job was
      reduced to `az bicep build` on 2026-08-04. Deploying it for the first time is its own
      decision, needing a credential that does not exist.

## Semantic ranker — two things to watch, now that it is live

- [ ] **`content` is `retrievable: true` and the index no longer stops whole chunks leaving.**
      Semantic configuration fields must be searchable *and* retrievable, so it had to flip. The
      guarantee now lives in `searchChunks`'s explicit `select` list, which excludes `content` —
      adding it there is not a display tweak, it starts returning full chunk text to every caller.
      Verified on the live index that L2 still reads the field with `select` excluding it, so
      nothing else had to change. Watch that `select`.
- [ ] **Ranking can degrade silently and nothing alerts.** Basic tier allows 2 concurrent semantic
      requests per search unit against a frontend that searches on debounced keystrokes, so
      `semanticErrorHandling: 'partial'` returning BM25 order is an expected path, not an edge. The
      reason is logged (`[ai-search] semantic reranking did not run: …`) and `rerankerScore` is
      absent on the hits, but nothing watches either. Under load the product may be serving the
      unranked order most of the time while the scorecard measures the ranked one.
- [ ] **The 402 latch does not un-latch when the month rolls over.** A single 402 turns semantic off
      for the life of the process, which is what stops every later search paying a wasted 402 plus a
      retry. But the allowance resets monthly and the latch does not, so a process that spans the
      rollover keeps serving BM25 until it restarts. Fine today — App Service recycles well inside a
      month — and the trade is deliberate: the alternative is re-probing on some timer nobody would
      tune. If the app ever gets long-lived, restart it after a 402 rather than waiting.

## Search UI

- [ ] **Facets are NOT blocked — the reason recorded here was wrong.** `sector`, `region` and
      `status` on `demi-projects` are already `facetable: true`, as is every field in both metadata
      indexes; see `azure/search/indexes/`. This entry previously said they needed a reindex because
      `facetable` is not a mutable field property. True in general, moot here: the fields were
      created facetable. What remains is a `facets` parameter on the query and UI to render the
      counts — the sector chips are still a hardcoded list of four with no count per value.
- [ ] **There is no result paging.** `searchChunks` sends only `top` (default 20, hard cap 250) and
      never sends `$skip`; the controller has no offset and the frontend has no load-more. Left alone
      deliberately — nobody uses DEMI yet, and this is a decision for whoever owns the search UI. If
      it is ever wanted: `$skip` caps at 100,000 and deep skips degrade, and score-ordered paging is
      unstable across requests, so infinite scroll needs a deterministic tiebreak in `$orderby` rather
      than score alone. `@odata.count` is already requested and returned by all three datasets and
      shown in the column headers — so the user can see how much a page is hiding, which is the
      argument for paging rather than a substitute for it.
- [ ] **The client-side highlighter did not die and should not yet.** Project, document and chunk
      cards now render the analyzer's own `<mark>` markup, but the regex-and-Levenshtein path still
      backs two live cases: results from the Cosmos fallback, which has no analyzer to ask, and
      map-explorer's boundary-name lists, which never touch the search API. It becomes deletable
      only if the Cosmos fallback goes.

## Needs a human, not code

- [ ] **AI Services Hub registration — now blocking, not just owed.** Provisioning Azure AI services
      is managed through the AI Services Hub, requested via <https://bcgov.github.io/ai-hub-tracking/>.
      `demi-search-dev` was created directly, without that request. The summariser needs a
      `Microsoft.CognitiveServices` account (`azure/modules/foundry.bicep`), which is squarely what
      that process governs — so this is no longer a debt to settle before prod, it gates the deploy.
      Code is written and dark-launched behind `SUMMARY_ENABLED=false`, so nothing is waiting on it
      except the account itself. See
      [ADR-006](https://github.com/digitalspace/eagle-demi/wiki/ADR-006-AI-Summarization-over-BM25).
- [ ] **Verify scoped and fragment access tiers end to end.** The reason this was never observed is
      now known and fixed: `helpers/auth.js` rejected any non-privileged Keycloak token inside
      *authentication*, so `passiveAuth` dropped it and `req.user` stayed unset — TIER.SCOPED was
      unreachable in production regardless of the role. Fixed in PR #15 (`b7d61ae`) and
      regression-tested. What remains is genuinely human: create a `project:<id>` role on a test
      user and confirm the filter narrows against real data.
- [ ] **Verify boundary rendering at all three frontend fidelities.** The API contract is verified
      (`/boundaries` and `/boundaries/<name>` both 200); the visual result is not.
- [ ] **Look at server-side highlighting on dev.** Shipped and unit-tested, but the visible result
      has not been eyeballed. Azure returns windowed fragments for a long field, so a long project
      description now renders as fragments joined by an ellipsis rather than in full.
- [ ] **Delete the 12 merged branches on `origin`.** From PRs #1–#10, #12 and #13.
      `git push --delete` is barred by settings deny, so this needs a human or the GitHub UI.

## Cost

Spend is roughly 200 CAD/month against a 100 CAD budget. AI Search Basic (~74/month) is the only line
this team controls, and dropping it means losing fuzzy search. Defender for Cloud (~48/month) is the
second-largest line and is almost certainly set by platform policy — ask the platform team, do not
turn plans off. Breakdown in
[Azure Environments](https://github.com/digitalspace/eagle-demi/wiki/Azure-Environments).

The AI summariser adds a new line, and it is the first one that is **per-token rather than per-hour**:
roughly $0.0006 a query, so ~$0.63/mo at a thousand queries. Small, but it scales with use rather
than with time, which is why the endpoint is privileged-only and why `summarize.js` logs
prompt/completion tokens on every call. Watch the logged p95 rather than assuming the estimate.

## Open decisions

| # | Question | Default | Cost of reversing |
|---|---|---|---|
| 1 | Backup mode `Continuous7Days` on dev | Not done | One-way. Gain 8h/support-ticket → 7-day self-service, free tier; lose Geo backup redundancy permanently |
| 2 | ~~Semantic ranker left enabled~~ | **Closed 2026-08-05: in use** | It is now the shipped ranking on `demi-chunks` — see above. Every Deep Search is a billable semantic query against an unpublished monthly free allowance; exhausting it returns HTTP 402, which the code catches once, latches, and degrades to BM25 for the rest of the process — it stops asking rather than paying a 402 plus a retry on every later search. Watch for that warning before assuming ranking is live |

Settled, and kept here only because reversing them is expensive: **index tier** (Basic — Basic→S1
needs a new service and a full reindex) and **delete propagation**
(hard delete plus immediate index delete; the `_ts` high-water mark seeing no deletes is measured,
not assumed — and now visible in `azure/search/datasources/`, none of which declares a
`dataDeletionDetectionPolicy`).

## Out of scope

`rg-epic-search` is not our project. It shares the `c4b0a8` billing group, so it surfaces in any
subscription-wide cost query — sharing a bill is not owning a system. Do not investigate it, cost it,
or track it here. Scope is `c4b0a8-dev-rg` and the DEMI resources. If something ever genuinely
couples DEMI to it, raise that specific coupling rather than reopening the area.
