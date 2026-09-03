# Bulk download: performance

Where wall time goes in `POST /api/bulk-downloads` → zip on test. Measured
2026-09-03 against `demi-api-fc-test` (`c4b0a8-test-rg`, Canada Central,
Flex Consumption, 2048 MB instances) via Log Analytics workspace
`demi-logs-test` (`AppTraces`, `AppRequests`), the ARM resource, and one
manual presigned-URL timing from this box. Behaviour and caps:
[[Bulk-Download]]. Code: `src/jobs/bulk-download.js`, `src/storage/minio.js`,
`host.json`.

## Worker wall time vs. document count

`AppTraces` `Executing 'Functions.bulkDownloadWorker'` / `Executed ...
Duration=` lines, last 30 hours (09/02 07:18 -- 09/03 04:35, all activity in
the 3-day window). 20 worker invocations total; the two below are the
cleanest same-corpus samples where every requested document downloaded
successfully (`errors=0`):

| Job | Documents | Duration | ms/doc |
|---|---|---|---|
| `7813a292` | 10 | 10,881 ms | 1,088 |
| `5269b413` | 10 | 18,113 ms | 1,811 |
| `7543a53c` | 47 (of 100 requested, 53 unreadable) | 24,394 ms | ~350 (successful docs only, error checks subtracted) |

Nine more jobs in the same 09/02 20:46--20:50 burst carried 2 documents each
(`documents=2, errors=0`) and ran 644 ms--2,203 ms end to end — a floor set
by fixed per-job cost (manifest read, credential re-check, Cosmos writes),
not by streaming, at that document count.

**Eleven of the twenty invocations packed zero documents** — every requested
id came back `[bulk] object unreadable]` and the job finished in 1.6--3.5 s.
This is the known test-bucket gap (`asnpnn` mirrors prod from before
~2020-05; wiki `Bulk-Download-Operations.md` "Backfill missing objects on
test"), not a performance signal — but it means roughly half of test's real
job traffic is misleadingly fast, and averaging all 20 jobs would understate
per-document cost.

Bytes per job (Cosmos `bulkDownloads.bytes`) were not reachable: Cosmos DB
firewall rejects this box's public IP (`demi-cosmos-test` is private-endpoint
+ keyless, confirmed by a live 403 `Forbidden ... blocked by your Cosmos DB
account firewall`). MB/s per job is not computed; the ms/doc figures above
stand on their own.

## Queue wait / cold start

Not directly measurable from available logs. `POST /api/bulk-downloads`
does not carry the job id in its logged path (only the response body does,
which isn't logged — the wiki notes the job id is deliberately masked from
per-request logs as a bearer capability), so a POST row cannot be joined to
the `Executing` row it triggered.

`host.json` sets `logging.logLevel.default: "Warning"`, which suppresses
most Host-category traces; `AppTraces` held exactly **one** `Host started`
line in the whole 72-hour window (08/31 21:44, evidently the app's last
cold boot or a restart), so instance-scale-out events are not visible either.
`az functionapp` / ARM confirms why cold starts matter: `functionAppConfig
.scaleAndConcurrency.alwaysReady: []` — no pinned instance for
`bulkDownloadWorker`, so any job arriving after Flex has scaled an idle
instance to zero pays a cold start before `Executing` fires. The isolated
single-job invocations in the log (09/02 22:14, 22:24, 23:00, 23:14, 23:35,
23:53, 09/03 03:18, 04:18, 04:34 — each tens of minutes after the previous
one) show no duration outlier tied to the gap, but that only says the cold
start, if any, happened *before* the measured `Duration` window, not that it
didn't happen.

`POST /api/bulk-downloads` itself is fast: 159 POSTs in the sample, median
38 ms, max 862 ms (`AppRequests`, `HttpPath=/api/bulk-downloads`). 13 of 159
(8%) hit `429` (pending/per-day cap) and one hit `503` — both load-test
artifacts, not latency findings.

## Poll overhead

Measured directly from `AppRequests` `GET /api/bulk-downloads/{id}` per job:
6--11 polls per job, interval 4--5 s while the job is running (matches the
documented "poll every 4 s" client guidance), each GET answered in well
under 400 ms. Total poll overhead is at most one extra interval (0--5 s) of
perceived latency after the job actually finishes — negligible next to
worker wall time.

## NRS throughput (manual sample, not the Function's own network path)

No `AppDependencies` rows exist for `nrs.objectstore.gov.bc.ca` — the MinIO
SDK call isn't instrumented as a dependency. One manual presigned-GET timing
from this box, via `POST https://demi-apim-test.azure-api.net/api/bulk-downloads`
with a single documentId:

| Object | Size | time_connect | time_starttransfer | time_total | Speed |
|---|---|---|---|---|---|
| small PDF | 63,972 B | 126 ms | 233 ms | 254 ms | 252 KB/s (size too small to read as throughput) |
| larger PDF | 5,957,976 B | 14 ms (reused conn) | 173 ms | 617 ms | 9.66 MB/s |

**Caveat**: this is this box's own network to NRS (BC Gov object store,
public internet, not Azure-private), not the Function instance's path from
Canada Central. It is presented as an order-of-magnitude sample, not a
measured Function-to-NRS number. The connect/TTFB component (~130--230 ms)
is the part most likely to also apply to the Function instance, since it
reflects TLS handshake + S3 auth round-trips to a BC Gov endpoint from
outside BC Gov's network, independent of caller.

## Instance settings

`az`/ARM (`Microsoft.Web/sites` `demi-api-fc-test`, live):

| Setting | Value |
|---|---|
| SKU | FlexConsumption |
| `instanceMemoryMB` | 2048 |
| `maximumInstanceCount` | 20 |
| `alwaysReady` | `[]` (none) |
| `host.json` queue | `messageEncoding: none`, `batchSize: 1`, `newBatchThreshold: 0`, `maxDequeueCount: 3`, `visibilityTimeout: 01:00:00` |
| `src/storage/minio.js` | `UPLOAD_PART_SIZE = 64 * 1024 * 1024` (64 MiB) |

`batchSize: 1` means one zip per instance at a time; Flex scales instances
horizontally (up to 20) rather than running several zips per instance — this
is deliberate (comment in `host.json`), sized against the 64 MiB multipart
buffer per 2048 MB instance.

## Ranked causes

### 1. Sequential per-document fetch — no concurrency (dominant) — FIXED

**Evidence**, as measured 2026-09-03 and before the fix below: `buildPart()`
in `src/jobs/bulk-download.js` awaited `getObjectStream` → `addEntry` →
archive write for one document before starting the next. Measured ms/doc
(1,088 and 1,811 for the two clean 10-doc jobs) rose linearly with document
count, with no sign of overlap.

**Estimated share of wall time**: the large majority, for any job with real
(non-missing) documents — the only step in the loop that scales with document
count rather than being a fixed per-job cost.

**Fix, applied**: a bounded read-ahead inside `buildPart` — see "Changes
applied" below. Zip entry order, and therefore `zip-stream`'s single-writer
constraint, binds the *append* only, so the fetch overlaps it. The read-ahead
holds object streams to read from, not upload buffers, so the part-size
budget in #4 is unchanged. Still untested against a job built from several
≥10 MB documents: the test corpus is mostly small and mostly missing.

**Measure after**: ms/doc for a matched-size job, against the numbers above.

### 2. Per-object round-trip / connect latency to NRS

**Evidence**: manual sample shows 126 ms connect / 233 ms TTFB on a cold
connection, 14 ms / 173 ms on a reused one. Fetches were serial (#1) when
those numbers were taken, so this latency was paid once per document rather
than amortized — on the 47-doc job, even 150--200 ms of unavoidable
round-trip per file adds up to 7--9 s of the 24 s total.

**Estimated share**: bundled with #1 — the same fix amortizes it, since
overlapping requests overlap their round trips too. Not separable with
current instrumentation (no `AppDependencies` rows for NRS calls).

**Fix**: same as #1. A secondary, smaller fix — confirm the MinIO client
reuses TCP connections across `getObjectStream` calls within one instance
(the SDK should, by default; not verified here) — would help even without
concurrency, since it's the difference between the 126 ms and 14 ms connect
times above.

**Measure after**: add `AppDependencies` instrumentation for the MinIO
GET/PUT calls (currently invisible to Log Analytics) so connect vs.
transfer time is separable from wall time, before deciding whether
connection reuse alone is worth doing.

### 3. Flex cold start + queue latency

**Evidence**: `alwaysReady: []` confirmed live; `AppTraces` cannot show cold
starts because `host.json` logs at `Warning` by default and POST-to-job-id
correlation is unavailable (see Queue wait section). Real but unquantified
with current logging.

**Estimated share**: unknown — plausibly 1--5 s (typical Flex cold start)
for the first job after any idle gap, zero for jobs arriving on a warm
instance (the 09/02 20:46--20:50 burst of 15+ jobs in under 4 minutes shows
no such tax once an instance is warm).

**Fix**: `alwaysReady=1` for `bulkDownloadWorker` specifically (Flex
per-function always-ready, not per-app) trades a small fixed monthly cost
for removing this on the first job after idle. Cheap and low-risk, but
should be justified by an actual cold-start measurement first — see below.

**Measure after**: before spending on `alwaysReady`, get the number: either
instrument `[bulk] job ready <id>` to also log the job's `createdAt` (already
on the Cosmos row) so poll-observed submit→ready latency is computable
end-to-end, or raise `host.json` `logLevel` for `Host.General`/scale
categories on a temporary basis to catch `Host started` lines.

### 4. 64 MiB part buffering

**Evidence**: `minio.js` sizes the multipart client at 64 MiB specifically
so *one* in-flight buffer fits the 2048 MB instance comfortably alongside
one object streaming at a time (host.json comment cross-references this).
Sample documents observed here (64 KB, 5.96 MB) and the Stage 0 corpus
numbers (largest single document 1.17 GiB, most projects average low
single-digit MB/doc) are almost always under 64 MiB, so this never even
triggers a second part for a typical file.

**Estimated share**: ~0% of wall time. Only matters for documents over
64 MiB, which are rare.

**Fix**: none. The read-ahead in #1 does not touch this budget: it opens
object streams to read from, while the archive still feeds one multipart
upload per part, so there is still one 64 MiB buffer per instance. Re-sizing
becomes necessary only if several parts are ever uploaded at once — and
reducing the part size without redoing that arithmetic reintroduces the exact
OOM risk the 64 MiB choice was sized to avoid.

### 5. zip-stream overhead

**Evidence**: `store: true` (no compression), a pure passthrough per entry.
No CPU-bound step here that would show up against network-bound per-document
time.

**Estimated share**: negligible, not separately measurable, not worth
measuring again unless #1--#3 are fixed and a residual is still unexplained.

### 6. Client 4 s poll

**Evidence**: measured 4--5 s actual interval, 6--11 polls/job, each answered
in under 400 ms server-side.

**Estimated share**: near 0% of total job time — this is client-perceived
latency added only at the tail (up to one poll interval after the job is
actually `ready`), not a cost stacked per document.

**Fix**: none proposed. The plan record already costed and rejected
push-based alternatives (Web PubSub/SignalR) for cost/complexity versus
short polling's near-zero overhead — no new information here changes that.

### 7. Browser's final download from NRS

**Evidence**: 9.66 MB/s sample for a 5.96 MB file, single connection,
straight from NRS to the caller with no Azure egress in the path.

**Estimated share**: 0% of *worker* wall time (happens after the job is
`ready`, as a separate step) but is part of what a user experiences as "the
download is slow" for large parts (up to the 2 GiB per-part cap). Caveat
above applies — this is not the Function's network path, it's a downstream
step the Function has no control over.

**Fix**: none proposed; out of the worker's control. If ever a complaint,
CDN in front of NRS or a real byte-count from production traffic would be
the next step, not a code change here.

## Recommendation

#1 (sequential fetch) is applied — it was the only cause that scales with
document count and it explains the entire linear ms/doc pattern above. It
needs remeasuring against those numbers; how, and against what, is in
"Changes applied". #4 (part size) needed no change with it.

#3 (cold start) still needs a real number before anything is spent on
`alwaysReady`. Half of the instrumentation gap is closed — the POST now logs
the job id, so submit-to-`Executing` is joinable — but `Warning`-level host
logging still hides scale-out events. #2, #5, #6 and #7 need no code change
based on what is measured here.

## Changes applied

Against cause #1, in `src/jobs/bulk-download.js`:

- **Read-ahead in `buildPart`.** The worker opens up to `BULK_FETCH_AHEAD`
  (`config.bulkFetchAhead`, default 3) objects ahead of the entry it is
  appending, so the next documents' round trips overlap the current append.
  The append itself stays serial, so zip entry order is unchanged. A failed
  open is still that one document's error, including a stream whose socket
  resets while it waits its turn; opens the part never reaches — a part that
  rolled, a cancel, a fatal error — are destroyed without waiting on them. Part size (#4) is untouched: the archive still holds one
  multipart upload buffer, and the read-ahead adds object streams, not
  upload buffers.
- **`POST /api/bulk-downloads` logs `[bulk] job queued job=<id>`.** The access
  log still masks the job id out of the request path, so this line is what a
  job's queue wait is measured from: join it to the worker's `Executing`
  trace for the same id. Closes the correlation gap named under "Queue wait /
  cold start".

**Measurement to repeat after deploy**: ms/doc on a 10-document job with every
document readable (`errors=0`), from the same `AppTraces` `Executing` /
`Executed ... Duration=` pair used for the table above. The two clean samples
to beat are 1,088 and 1,811 ms/doc. Use a corpus of comparable file sizes —
the mostly-missing test bucket produces jobs that finish in 1.6-3.5 s and
measure nothing.
