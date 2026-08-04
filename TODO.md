# TODO

Open work only. Facts, measurements and history live in the
[wiki](https://github.com/digitalspace/eagle-demi/wiki); if something here needs a paragraph of
background, that background belongs there and this entry links to it.

Dev only. `main` is deployed and current as of 2026-08-04.

---

## Label debt — blocks any further retrieval work

The retrieval scorecard is the verdict metric for extraction quality, and it currently rests on 71
labels with strata too small to rank. Everything below is "put an eye on a document", not code.

- [ ] **`src/scripts/retrieval-labels-ocr.jsonl` holds 25 candidates, not labels.** Seeded from
      document titles, which are metadata and not verified to be on the page; 12 are marked STARVED.
      Scoring them as-is measures the title, not the extraction. Open each scan, confirm the words
      appear, then edit or delete the line — that turns it into a second OCR stratum worth running.
- [ ] **The `tiled` stratum has 2 labels, not 10.** The other 8 need an eye on a rendered map sheet,
      which is the one stratum where a wrong reading is indistinguishable from a retrieval miss.
      Renders are at `/root/demi-tiled-review/`; drop phrases into `D-ocr-tiled.jsonl` and re-run.
      Until then the tiled row in the scorecard means nothing.

Until n is larger, treat recall@10 0.620 as the same number as 0.549 — one standard error on this
label set is ~0.059 and both shipped improvements are inside it.

## Extraction

- [ ] **Intake cleaner.** Still worth doing as tidying, but the case got weaker: stripping
      `<!-- image -->` and dropping separator chunks does nothing about word-joining, which is the
      defect in the extracted text. Do not expect it to move recall — word-joining accounts for 3 of
      32 retrieval misses. Not an OCR re-run.
- [ ] **`pageNumber` is a citation feature and nothing cites. Do not build it yet.** It is a sequence
      number on both paths, not a PDF page, and making it real needs host, wire-protocol and API
      changes *plus* re-extraction — it does not ride a re-chunk. Nothing consumes it: no PDF viewer
      and no `#page=` anchor in the frontend, which renders it honestly as `Passage N`. If citations
      are ever wanted, the cheap slice is the text path (56% of the corpus, pypdfium2, no GPU), but it
      still needs source PDFs and ~1,496 already 404 in the dev object store. Whether a browser
      honours `#page=N` on a presigned URL depends on the object being served inline rather than as an
      attachment, which is unverified. Background:
      [Extraction Pipeline](https://github.com/digitalspace/eagle-demi/wiki/Extraction-Pipeline).

## Tests

- [ ] **`cosmos.bulk()`'s >100-op chunking is untested**, including its discard-on-throw behaviour.
- [ ] **`TARGET_CHUNK_SIZE` and `MIN_CHUNK_SIZE` are only checked against literals** (`>= 2000`,
      `> 100`). `MAX` and `OVERLAP` are now read from `src/config.js` by the overlap tests, so those
      two are genuinely asserted to reach the chunker — but a silent env change to `TARGET` or `MIN`
      still orphans every chunk already written without failing a test.

## Infrastructure

- [ ] **Rewrite `azure/main.bicep` to describe dev.** It never instantiates `cosmos-nosql.bicep`,
      `ai-search.bicep`, `identity.bicep`, `document-storage.bicep` or `frontend-web-app.bicep`, and
      there is no VNet in the resource group. Not urgent — `azure-deploy-dev.yaml`'s infra job was
      reduced to `az bicep build` on 2026-08-04, so it cannot deploy the template even once a
      credential exists.
- [ ] **CI is blocked.** `AZURE_CLIENT_ID` is missing from repo secrets. It needs an Entra app
      registration with a federated credential, and creating one needs Microsoft Graph, which
      conditional access blocks. Manual deploy is the working path meanwhile.
- [ ] **Phase 3b, blob storage.** Code and Bicep written, nothing deployed or copied. The argument is
      per-environment isolation, not cost. Needs `Storage Blob Delegator` on the identity or every
      download link fails to sign — it is not implied by `Storage Blob Data Contributor`.
- [ ] **The `syncState` container still exists in the live account.** It was removed from the template
      2026-08-01, but the template is not deployed so nothing was deleted. `leases` is kept
      deliberately: its original reason died with Typesense, but a change-feed trigger stays the only
      route to automatic delete propagation.

## Search UI

- [ ] **Highlighting for projects and documents is done in the browser.** Only the chunk index asks
      AI Search for `highlight`; project and document hits are marked up client-side by a regex and
      a hand-rolled Levenshtein in `registry-state.service.ts`. Asking the service to highlight
      `displayName,description` would delete that code and match what the analyzer actually matched
      — the local matcher can mark a word the index never hit, and miss a stemmed one it did.
- [ ] **No facets.** The sector chips are a hardcoded list of four, and nothing displays a count per
      value. Facets would make them real, but `sector`/`region`/`status` must be `facetable` in the
      index first, which is not a mutable field property — it needs a reindex. Cost is the reindex,
      not the query.
- [ ] **The index, indexer and data-source definitions exist only in the live service.** Nothing in
      git can rebuild them, and `publicNetworkAccess: Disabled` means they were hand-POSTed from
      inside the VNet. Export the three of each to JSON via Kudu and commit them. Read-only, no
      deployment risk, and it is the difference between a rebuildable environment and an
      unrepeatable one.
- [ ] **There is no result paging.** `searchChunks` sends only `top` (default 20, hard cap 250) and
      never sends `$skip`; the controller has no offset and the frontend has no load-more. Left alone
      deliberately — nobody uses DEMI yet, and this is a decision for whoever owns the search UI. If
      it is ever wanted: `$skip` caps at 100,000 and deep skips degrade, and score-ordered paging is
      unstable across requests, so infinite scroll needs a deterministic tiebreak in `$orderby` rather
      than score alone. `@odata.count` is already requested and, since 2026-08-04, returned by all
      three datasets and shown in the column headers — so the user can now see how much a page is
      hiding, which is the argument for paging rather than a substitute for it.

## Needs a human, not code

- [ ] **AI Services Hub registration.** The platform documents that provisioning Azure AI services is
      managed through the AI Services Hub, requested via <https://bcgov.github.io/ai-hub-tracking/>.
      `demi-search-dev` was created directly, without that request. Nothing blocked it and nothing is
      broken, but the process was skipped — submit before this goes past dev.
- [ ] **Verify scoped and fragment access tiers end to end.** Unit-tested only; no scoped Keycloak
      role exists yet. Create a `project:<id>` role on a test user.
- [ ] **Verify boundary rendering at all three frontend fidelities.** The API contract is verified
      (`/boundaries` and `/boundaries/<name>` both 200); the visual result is not.

## Cost

Spend is roughly 200 CAD/month against a 100 CAD budget. AI Search Basic (~74/month) is the only line
this team controls, and dropping it means losing fuzzy search. Defender for Cloud (~48/month) is the
second-largest line and is almost certainly set by platform policy — ask the platform team, do not
turn plans off. Breakdown in
[Azure Environments](https://github.com/digitalspace/eagle-demi/wiki/Azure-Environments).

## Open decisions

| # | Question | Default | Cost of reversing |
|---|---|---|---|
| 1 | Backup mode `Continuous7Days` on dev | Not done | One-way. Gain 8h/support-ticket → 7-day self-service, free tier; lose Geo backup redundancy permanently |

Settled, and kept here only because reversing them is expensive: **index tier** (Basic, with `content`
`retrievable: false` — Basic→S1 needs a new service and a full reindex) and **delete propagation**
(hard delete plus immediate index delete; the `_ts` high-water mark seeing no deletes is measured,
not assumed).

## Out of scope

`rg-epic-search` is not our project. It shares the `c4b0a8` billing group, so it surfaces in any
subscription-wide cost query — sharing a bill is not owning a system. Do not investigate it, cost it,
or track it here. Scope is `c4b0a8-dev-rg` and the DEMI resources. If something ever genuinely
couples DEMI to it, raise that specific coupling rather than reopening the area.
