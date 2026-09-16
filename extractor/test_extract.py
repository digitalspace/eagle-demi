#!/usr/bin/env python3
"""Checks for the extractor. `python3 extractor/test_extract.py`

Two halves:

1. `decide()` — the copied routing rule, pinned so it cannot drift from
   `extraction-host/worker.py`. That file is a sibling in this repo now, so the last case always
   runs BOTH implementations over thousands of generated inputs and demands identical answers.
   That is the real guard; the individual cases above it say which rule moved.

2. The text path against REAL PDFs on disk, with no network. This is what makes the extraction
   itself testable here: dev's object store holds files for almost none of its documents (measured:
   1 downloadable in 40 of the most recent), so an end-to-end run against dev proves nothing about
   text extraction.
"""

import importlib.util
import json
import random
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
# extract.py does `import ocr`, which resolves relative to sys.path, not to the loading file.
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("extract", HERE / "extract.py")
extract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extract)

FAILURES = []


def check(name, condition, detail=""):
    if condition:
        return
    FAILURES.append(f"{name}{': ' + detail if detail else ''}")


# ── the routing rule ─────────────────────────────────────────────────────────
extract.selfcheck()

# In the same repo since the extractor moved here, so this is no longer conditional: worker.py
# missing is a real failure, not a developer without the other checkout.
demi_worker = HERE.parent / "extraction-host" / "worker.py"
# worker.py reads DEMI_ADMIN_KEY at import, so lift `decide` out by source rather than importing.
src = demi_worker.read_text()
start = src.index("def decide(counts, size):")
end = src.index("\n\n\n", start)
ns = {
    "statistics": statistics,
    "MIN_CHARS_PER_PAGE": extract.MIN_CHARS_PER_PAGE,
    "MIN_TEXT_FRACTION": extract.MIN_TEXT_FRACTION,
    "LOW_YIELD_MIN_BYTES": extract.LOW_YIELD_MIN_BYTES,
}
exec(src[start:end], ns)  # noqa: S102
theirs = ns["decide"]

random.seed(7)
disagreements = 0
for _ in range(3000):
    counts = [
        random.choice([0, 5, 51, 199, 200, 400, 5000])
        for _ in range(random.randint(0, 30))
    ]
    size = random.choice([500, 199_999, 200_000, 5_000_000])
    if extract.decide(counts, size) != theirs(counts, size):
        disagreements += 1
check("routing parity with worker.py", disagreements == 0, f"{disagreements} of 3000 differ")
parity = f"verified against worker.py over 3000 cases"


# ── the text path, against real PDFs ─────────────────────────────────────────
# Real documents rather than a synthetic one-liner: a generated PDF has a perfect text layer and
# would pass any implementation, including a broken one.
CANDIDATES = [
    HERE.parent.parent / "eagle-demi.wiki" / "policies" / "Managing Government Information Policy - 2022.pdf",
    HERE.parent.parent / "eagle-demi.wiki" / "policies" / "Guidelines on Documenting Government Decisions - 2019.pdf",
    HERE.parent.parent / "EPIC.submit" / "Holder User Guide EPIC.submit v1.1.pdf",
]
pdfs = [p for p in CANDIDATES if p.exists()]

if pdfs:
    for pdf in pdfs:
        size = pdf.stat().st_size
        counts = extract.probe_pdf(pdf)
        check(f"probe reads pages from {pdf.name}", len(counts) > 0)

        route, markdown, info = extract.route_and_extract(pdf, size)
        # These are ordinary digital documents. Anything else means the probe or the thresholds are
        # broken, and every one of them would be sent to a GPU that has nothing to find.
        check(f"{pdf.name} routes to text", route == "text", f"got {route} ({info.get('reason')})")
        if route == "text":
            check(f"{pdf.name} yields text", extract.real_chars(markdown) > 500,
                  f"{extract.real_chars(markdown)} real chars")
            # Pages are separated by a form feed, which is what chunker.js counts pages off. A
            # multi-page document with no marker in it has lost its page provenance.
            check(f"{pdf.name} separates pages with a marker", "\f" in markdown)

    # A file this extractor cannot open is recorded, never raised: raising retries it five times
    # and parks it in the poison queue beside the failures that are actually worth looking at.
    junk = HERE / ".junk-probe.bin"
    junk.write_bytes(b"not a pdf")
    try:
        route, md, info = extract.route_and_extract(junk, 9)
        check("an unopenable file is skipped, not an error", route == "skip", str(info))
        check("and produces nothing to ingest", md is None)
    finally:
        junk.unlink(missing_ok=True)

    # A file that CLAIMS to be a PDF and is truncated takes the same road. This is a different code
    # path from the one above — the magic bytes match, pdfium is what refuses.
    broken = HERE / ".broken-probe.pdf"
    broken.write_bytes(b"%PDF-1.4\ntruncated before anything useful")
    try:
        route, _, info = extract.route_and_extract(broken, 40)
        check("a corrupt PDF is skipped, not an error", route == "skip", str(info))
    finally:
        broken.unlink(missing_ok=True)
    corpus = f"{len(pdfs)} real PDFs"
else:
    corpus = "no local PDFs found — text-path cases skipped"

# ── OCR ──────────────────────────────────────────────────────────────────────
# The real OCR stack, against a real page image, with no fixture and no network: render a page of
# one of the PDFs above and read it back. This fails if cv2 cannot import, if the models are
# missing, or if the render scale drops below what the recogniser can use — the three ways this
# path breaks silently in a deployed app.
ocr = importlib.import_module("ocr")

check("magic bytes route a PDF", ocr.MAGIC[b"%PDF"] == "pdf")
check("magic bytes route a PNG", ocr.MAGIC[b"\x89PNG"] == "image")

if pdfs:
    import pypdfium2 as pdfium

    source = pdfs[0]
    page_image = HERE / ".ocr-probe.png"
    doc = pdfium.PdfDocument(source)
    try:
        # Page 1 rather than page 0: a cover page is often a logo and a title, and an empty result
        # there would not distinguish "OCR is broken" from "there was nothing to read".
        page = doc[min(1, len(doc) - 1)]
        page.render(scale=ocr.OCR_RENDER_SCALE).to_pil().save(page_image)
        page.close()
    finally:
        doc.close()

    try:
        text, info = ocr.ocr_file(page_image)
        recovered = extract.real_chars(text)
        check("OCR reads a rendered page", recovered > 200,
              f"{recovered} real chars from {source.name}")
        check("an image counts as one page", info.get("pagesRead") == 1, str(info))
        ocr_note = f"{recovered} chars off a rendered page"
    except ImportError as e:
        # rapidocr is a deployment dependency. A developer without it should still get the rest of
        # the suite rather than a red run they cannot act on.
        ocr_note = f"rapidocr not installed — OCR cases skipped ({e})"
    finally:
        page_image.unlink(missing_ok=True)
else:
    ocr_note = "no local PDFs — OCR cases skipped"

# The cap has to be visible in the row, or a document that was read to page 200 of 900 looks
# exactly like one that was read to the end.
if pdfs:
    try:
        _, capped = ocr.ocr_file(pdfs[0], max_pages=1)
        check("a truncated document says so", capped.get("truncatedAtPage") == 1, str(capped))
        check("and reports its real length", capped.get("pages", 0) > 1, str(capped))
    except ImportError:
        # Same reason as the OCR block above: rapidocr is a deployment dependency, and a developer
        # without it should get the rest of the suite rather than a red run. Recorded rather than
        # swallowed, so the summary line says which cases did not run.
        ocr_note = f"{ocr_note}; truncation cases skipped too"

# ── page markers ─────────────────────────────────────────────────────────────
# The contract with src/chunker.js: still one markdown string, with a form feed between consecutive
# pages — never leading, never trailing, and an empty page still yields its marker so the page
# numbers stay real. It is what makes `pageNumber` a page a reader can quote rather than a passage
# sequence, so each rule is pinned here instead of left to whoever next edits the joiner.
check("the marker is a form feed", ocr.PAGE_BREAK == "\f", repr(ocr.PAGE_BREAK))
check("consecutive pages get one marker each", ocr.join_pages(["a", "b", "c"]) == "a\fb\fc")
check("a single page carries no marker", ocr.join_pages(["only"]) == "only")
check("an empty page keeps its slot", ocr.join_pages(["a", "", "c"]) == "a\f\fc")
check("page text is stripped around the marker", ocr.join_pages([" a \n", "\n b "]) == "a\fb")

# A synthetic PDF, unlike the real documents above, because these cases need KNOWN text on KNOWN
# pages. The real documents stay the proof that extraction itself works; this one is the proof that
# page 2's text ends up on page 2.
FIXTURE = HERE / "fixtures" / "three-pages.pdf"
try:
    import pypdfium2 as pdfium
except ImportError as e:
    pdfium = None
    marker_note = f"pypdfium2 not installed — fixture cases skipped ({e})"

if pdfium and FIXTURE.exists():
    TOKENS = ["ALPHAPAGEONE", "BRAVOPAGETWO", "CHARLIEPAGETHREE"]

    md = extract.extract_text(FIXTURE)
    parts = md.split(ocr.PAGE_BREAK)
    check("three pages give exactly two markers", md.count(ocr.PAGE_BREAK) == 2, repr(md))
    check("no leading or trailing marker", not md.startswith("\f") and not md.endswith("\f"),
          repr(md))
    check("each page's text sits on its own side of the markers",
          len(parts) == 3 and all(tok in parts[i] for i, tok in enumerate(TOKENS)), repr(parts))

    # Through the routing, not just the joiner: `function_app.py` calls route_and_extract, and a
    # marker that only survives in extract_text would never reach the index.
    route, routed, info = extract.route_and_extract(FIXTURE, FIXTURE.stat().st_size)
    check("the routed text path keeps its markers",
          route == "text" and routed.count(ocr.PAGE_BREAK) == 2, f"{route}: {info}")

    # A real PDF with a genuinely empty middle page — a page object with no content stream — rather
    # than a hand-written list. This is the case that decides whether page 3 is called page 3.
    blanked = HERE / ".blank-middle-probe.pdf"
    source = pdfium.PdfDocument(FIXTURE)
    try:
        built = pdfium.PdfDocument.new()
        built.import_pages(source, [0])
        built.new_page(612, 792)
        built.import_pages(source, [2])
        built.save(str(blanked))
    finally:
        source.close()
    try:
        md = extract.extract_text(blanked)
        blank_pages = md.split(ocr.PAGE_BREAK)
        check("an empty middle page still yields its marker", md.count(ocr.PAGE_BREAK) == 2,
              repr(md))
        check("so the page after it is still the third page",
              len(blank_pages) == 3 and blank_pages[2].startswith("CHARLIEPAGETHREE"), repr(md))
    finally:
        blanked.unlink(missing_ok=True)

    # The OCR path over the same fixture with the recogniser stubbed out: rapidocr is not needed to
    # prove that a page it reads nothing on keeps its place.
    real_text_fn = ocr._text
    try:
        counter = {"page": 0}

        def _fake_text(image):
            counter["page"] += 1
            return "" if counter["page"] == 2 else f"OCRPAGE{counter['page']}"

        ocr._text = _fake_text
        md, ocr_info = ocr.ocr_file(FIXTURE)
        check("the OCR path marks pages too", md.count(ocr.PAGE_BREAK) == 2, repr(md))
        check("a page OCR read nothing on still holds its place",
              md.split(ocr.PAGE_BREAK) == ["OCRPAGE1", "", "OCRPAGE3"], repr(md))
        check("and is still counted as empty", ocr_info.get("emptyPages") == 1, str(ocr_info))
    finally:
        ocr._text = real_text_fn

    marker_note = f"text and OCR paths over {FIXTURE.name}"
elif pdfium:
    marker_note = f"{FIXTURE.name} missing — fixture cases skipped"

# The host's copy of the contract. worker.py is vendored onto the extraction box and cannot import
# this package, so its definitions are lifted by source and compared, the same way `decide()` is.
wns = {}
for opening in ('PAGE_BREAK = "', "def join_pages(pages):", "def text_len(md):",
                "def doc_pages(doc):"):
    at = src.index(opening)
    exec(src[at:src.index("\n\n\n", at)], wns)  # noqa: S102

check("the host uses the same marker", wns["PAGE_BREAK"] == ocr.PAGE_BREAK, wns["PAGE_BREAK"])
check("the host joins pages the same way",
      wns["join_pages"](["a", "", "c"]) == ocr.join_pages(["a", "", "c"]))
# The low-yield and retry tests in worker.py compare recovered text. A long scan of blank pages
# would otherwise read as a document that converted fine, on the strength of its markers alone.
check("markers do not count as recovered text", wns["text_len"]("a\fb\fc") == 3)


class _FakeDoclingDoc:
    """What `conv.convert(part).document` gives the OCR path, for a host with no docling installed.

    docling-core's `export_to_markdown(page_no=N)` (in it since 2.4.0; the host runs docling 2.116.0,
    which floors docling-core at 2.86.0) returns "" for a page it found no items on, and `pages` is
    a dict keyed by the 1-based page number. Both are copied here.
    """

    def __init__(self, page_markdown):
        self._pages = page_markdown
        self.pages = {n: None for n in range(1, len(page_markdown) + 1)}

    def export_to_markdown(self, page_no=None):
        if page_no is None:
            return "\n\n".join(p for p in self._pages if p)
        return self._pages[page_no - 1]


class _FakeUnpagedDoc:
    """An office document or a single image: docling builds no page map for these."""

    pages = {}

    def export_to_markdown(self, page_no=None):
        check("an unpaged document is never asked for a page", page_no is None, str(page_no))
        return "whole thing"


doc_pages, host_join = wns["doc_pages"], wns["join_pages"]
check("the OCR path exports one markdown per page",
      doc_pages(_FakeDoclingDoc(["A", "", "C"])) == ["A", "", "C"])
check("a page docling read nothing on is still joined in",
      host_join(doc_pages(_FakeDoclingDoc(["A", "", "C"]))) == "A\f\fC")
check("a document with no page map is one page with no marker",
      host_join(doc_pages(_FakeUnpagedDoc())) == "whole thing")
# ocr_worker converts OCR_BATCH_PAGES pages at a time and concatenates the per-batch page lists, so
# the markers have to count the document's pages and not its batches.
batched = host_join(page
                    for part in (_FakeDoclingDoc(["A", "B"]), _FakeDoclingDoc(["C"]))
                    for page in doc_pages(part))
check("page batches join into one page sequence", batched == "A\fB\fC", repr(batched))


# ── the outcome record ───────────────────────────────────────────────────────
# The extractor's own log line is lost on short invocations (measured: two ~1 s runs on a cold Flex
# instance emitted no telemetry at all), and those are exactly the runs with no chunks to corroborate
# them. So the row is posted to eagle-search as well — and posting it must never be able to fail an
# extraction that already succeeded.
posted = []


class _FakePost:
    def __init__(self, boom=False):
        self.boom = boom

    def __call__(self, url, **kwargs):
        if self.boom:
            raise ConnectionError("service unreachable")
        posted.append((url, kwargs.get("json"), kwargs.get("headers", {})))


real_post, real_url, real_key = extract.requests.post, extract.INGEST_URL, extract.INGEST_KEY
try:
    extract.INGEST_URL, extract.INGEST_KEY = "https://example.invalid", "secret"

    extract.requests.post = _FakePost()
    extract.post_outcome({"id": "d1", "route": "skip", "reason": "not available publicly"})
    check("an outcome with nothing to ingest is still recorded", len(posted) == 1)
    if posted:
        url, body, headers = posted[0]
        check("posted to the admin endpoint", url.endswith("/admin/extract-outcome"), url)
        check("carries the key", headers.get("x-ingest-key") == "secret")
        check("posts the row verbatim", body.get("route") == "skip", str(body))

    # A service that is down loses the record — it must not also lose the extraction.
    extract.requests.post = _FakePost(boom=True)
    extract.post_outcome({"id": "d2", "route": "text"})

    # No credentials means no call, not a crash: a developer running the CLI without INGEST_URL set
    # is doing a dry inspection, not misconfiguring production.
    posted.clear()
    extract.INGEST_URL, extract.INGEST_KEY = "", ""
    extract.requests.post = _FakePost()
    extract.post_outcome({"id": "d3", "route": "text"})
    check("no credentials means no call", len(posted) == 0)
finally:
    extract.requests.post, extract.INGEST_URL, extract.INGEST_KEY = real_post, real_url, real_key

# ── host.json ────────────────────────────────────────────────────────────────
# Both of these were learned from a deployed app that ran happily and drained nothing. See
# function_app.py's header for what each failure looks like.
host = json.loads((HERE / "host.json").read_text())
check("host.json declares an extension bundle", "extensionBundle" in host,
      "without it queueTrigger is not registered and the queue never drains")
check("queue messages are plain text", host["extensions"]["queues"].get("messageEncoding") == "none",
      "base64 is the bundle default, and a 24-char ObjectId decodes to garbage instead of failing")

# ── a transient download failure must not become a permanent skip ────────────
# `function_app.py` re-raises only when `route is None`, so a recorded skip CONSUMES the message.
# Nothing re-enqueues afterwards — eagle-search queues on insert and on the publish transition, and
# a document that was already published when eagle-api hiccuped gets neither. So the difference
# between "skip" and "raise" here is the difference between losing an attempt and losing a document.
class _FakeGet:
    def __init__(self, exc=None, status=200):
        self.exc, self.status = exc, status

    def __call__(self, url, **kwargs):
        if self.exc:
            raise self.exc
        raise AssertionError("unreachable in these cases")


real_get = extract.requests.get
try:
    # 404 — genuinely not public. A permanent fact about the document, recorded and consumed.
    extract.requests.get = _FakeGet(exc=FileNotFoundError("not available publicly (HTTP 404): d4"))
    row = extract.extract_one("d4")
    check("a 404 is recorded as a skip", row.get("route") == "skip", str(row))

    # Oversize — also permanent.
    extract.requests.get = _FakeGet(exc=ValueError("larger than MAX_FILE_MB=300"))
    row = extract.extract_one("d5")
    check("an oversize file is recorded as a skip", row.get("route") == "skip", str(row))

    # A 503, a timeout, a reset. Transient, and must reach the poison queue instead.
    for exc, label in [
        (ConnectionError("connection reset"), "a connection reset"),
        (RuntimeError("503 Server Error: Service Unavailable"), "a 5xx"),
    ]:
        extract.requests.get = _FakeGet(exc=exc)
        try:
            row = extract.extract_one("d6")
            check(f"{label} must raise, not skip", False, f"returned {row}")
        except Exception as e:  # noqa: BLE001
            check(f"{label} raises", not isinstance(e, AssertionError), repr(e))
finally:
    extract.requests.get = real_get


if FAILURES:
    print("FAILED:")
    for f in FAILURES:
        print("  -", f)
    sys.exit(1)

print(f"extractor tests OK ({parity}; text path over {corpus}; OCR: {ocr_note}; "
      f"page markers: {marker_note})")
