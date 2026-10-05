"""Write a display title into a PDF as an appended incremental update.

The original bytes stay an exact prefix, so truncating to `source_length` restores them. Anything
unsafe is a skip with a reason, and the file is left as it was.
"""

import hashlib
import io
import logging
import re
from collections import Counter
from dataclasses import dataclass
from typing import Optional
from xml.etree import ElementTree
from xml.sax.saxutils import escape

import pikepdf
from pypdf import PdfReader
from pypdf.generic import DictionaryObject, NameObject, StreamObject, create_string_object

log = logging.getLogger("titler")

_DC = "http://purl.org/dc/elements/1.1/"
_RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
_XML_LANG = "{http://www.w3.org/XML/1998/namespace}lang"

# Closing tags may carry whitespace before ">" (`</rdf:RDF\r\n>` occurs in the prod sample).
_DC_TITLE = re.compile(rb"<dc:title\b[^>]*?(?:/>|>.*?</dc:title\s*>)", re.DOTALL)
_DC_TITLE_ATTR = re.compile(rb"""dc:title=(["']).*?\1""", re.DOTALL)
_RDF_END = re.compile(rb"</rdf:RDF\s*>")
_STARTXREF = re.compile(rb"startxref\s+(\d+)")
_OBJ_HEADER = re.compile(rb"\d+\s+\d+\s+obj")
_STREAM_NAME = re.compile(r"stream <[^>]*>")
_OFFSET = re.compile(r"offset \d+")


@dataclass
class Result:
    status: str  # "ready" or "skipped"
    title: str
    source_length: int
    source_sha256: Optional[str]
    data: Optional[bytes] = None
    reason: Optional[str] = None
    source_warnings: int = 0  # qpdf warnings the original already had; the output adds none


class Skip(Exception):
    """A file this tool will not write. The message is the reason stored on the row."""


def set_title(original: bytes, title: str) -> Result:
    """Return `original` plus a title update, or a skip with the reason."""
    title = " ".join(title.split())
    sha = hashlib.sha256(original).hexdigest() if original else None
    try:
        data, source_warnings = _titled(original, title)
    except Skip as skip:
        log.info("skipped: %s", skip)
        return Result("skipped", title, len(original), sha, reason=str(skip))
    if source_warnings:
        log.info("titled with %d pre-existing qpdf warnings", source_warnings)
    return Result("ready", title, len(original), sha, data=data, source_warnings=source_warnings)


def _open(data: bytes) -> PdfReader:
    try:
        reader = PdfReader(io.BytesIO(data), strict=False)
        # Before any object is read: pypdf's writer appends plaintext into encrypted files, and
        # the owner has not decided how those may be changed.
        if reader.is_encrypted:
            raise Skip("encrypted")
        len(reader.pages)  # a broken page tree fails here rather than halfway through the write
        return reader
    except Skip:
        raise
    except Exception as exc:  # pypdf raises many types for malformed input
        raise Skip("unreadable") from exc


def _is_signed(original: bytes, reader: PdfReader) -> bool:
    if b"/ByteRange" in original:
        return True
    acroform = reader.trailer["/Root"].get("/AcroForm")
    return acroform is not None and "/SigFlags" in acroform.get_object()


def _titled(original: bytes, title: str) -> tuple:
    if not original:
        raise Skip("empty")
    if not title:
        raise Skip("no-title")
    reader = _open(original)
    if _is_signed(original, reader):
        raise Skip("signed")
    try:
        source_warnings = _qpdf_warnings(original)
    except Exception as exc:  # qpdf errors, not warnings: leave the file alone
        raise Skip("check-qpdf-source-errors") from exc

    objects = {}  # (number, generation) -> object, all written after the original bytes
    info_ref = _info_ref(reader)
    has_info = "/Info" in reader.trailer
    info = DictionaryObject(reader.trailer["/Info"].get_object()) if has_info else DictionaryObject()
    info[NameObject("/Title")] = create_string_object(title)
    if info_ref is None:
        info_ref = (_next_free_number(reader), 0)
    objects[info_ref] = info

    root = reader.trailer["/Root"]
    has_xmp = "/Metadata" in root
    if has_xmp:
        # Revise the existing stream object: a new number has collided in xref-stream files.
        meta_ref = root.raw_get("/Metadata")
        if not hasattr(meta_ref, "idnum"):
            raise Skip("xmp-direct")
        objects[(meta_ref.idnum, meta_ref.generation)] = _xmp_stream(_xmp_bytes(reader), title)

    updated = _append(original, reader, objects, info_ref)
    _check(original, reader, updated, title, has_xmp)
    _check_with_qpdf(updated, len(reader.pages), title, has_xmp, source_warnings)
    return updated, sum(source_warnings.values())


def _info_ref(reader: PdfReader) -> Optional[tuple]:
    if "/Info" not in reader.trailer:
        return None
    ref = reader.trailer["/Info"].indirect_reference
    return (ref.idnum, ref.generation) if ref is not None else None


def _next_free_number(reader: PdfReader) -> int:
    # /Size is wrong in some real files; never reuse a number any xref section already lists.
    used = [n for table in reader.xref.values() for n in table] + list(reader.xref_objStm)
    return max([int(reader.trailer["/Size"])] + [n + 1 for n in used])


def _xmp_stream(xmp: bytes, title: str) -> StreamObject:
    stream = StreamObject()  # unfiltered: PDF/A-1 forbids filters on the metadata stream
    stream[NameObject("/Type")] = NameObject("/Metadata")
    stream[NameObject("/Subtype")] = NameObject("/XML")
    stream.set_data(_xmp_with_title(xmp, title))
    return stream


def _append(original: bytes, reader: PdfReader, objects: dict, info_ref: tuple) -> bytes:
    """Original bytes, the new objects, and one xref section of the same kind as the last one."""
    found = _STARTXREF.findall(original)
    if not found:
        raise Skip("no-startxref")
    prev = int(found[-1])
    classic = original[prev:prev + 4] == b"xref"
    if not classic and not _OBJ_HEADER.match(original, prev):
        raise Skip("bad-startxref")  # /Prev must point at the real last section

    out = io.BytesIO()
    out.write(original)
    if not original.endswith((b"\n", b"\r")):
        out.write(b"\n")
    offsets = {}
    for (num, gen), obj in sorted(objects.items()):
        offsets[num] = (out.tell(), gen)
        out.write(b"%d %d obj\n" % (num, gen))
        obj.write_to_stream(out)
        out.write(b"\nendobj\n")

    size = max(int(reader.trailer["/Size"]), max(offsets) + 1)
    trailer = {"/Root": reader.trailer["/Root"].indirect_reference, "/Prev": prev}
    if "/ID" in reader.trailer:
        trailer["/ID"] = reader.trailer["/ID"]

    xref_at = out.tell()
    if classic:
        _write_table(out, offsets, size, trailer, info_ref)
    else:
        _write_xref_stream(out, offsets, size, trailer, info_ref)
    out.write(b"startxref\n%d\n%%%%EOF\n" % xref_at)
    return out.getvalue()


def _trailer_dict(size: int, trailer: dict, info_ref: tuple) -> bytes:
    parts = [b"/Size %d" % size,
             b"/Root %d %d R" % (trailer["/Root"].idnum, trailer["/Root"].generation),
             b"/Info %d %d R" % info_ref,
             b"/Prev %d" % trailer["/Prev"]]
    if "/ID" in trailer:
        buf = io.BytesIO()
        trailer["/ID"].write_to_stream(buf)
        parts.append(b"/ID " + buf.getvalue())
    return b" ".join(parts)


def _runs(numbers):
    """Contiguous runs of object numbers, as (first, count)."""
    runs = []
    for n in sorted(numbers):
        if runs and runs[-1][0] + runs[-1][1] == n:
            runs[-1][1] += 1
        else:
            runs.append([n, 1])
    return runs


def _write_table(out, offsets, size, trailer, info_ref):
    out.write(b"xref\n")
    for first, count in _runs(offsets):
        out.write(b"%d %d\n" % (first, count))
        for n in range(first, first + count):
            offset, gen = offsets[n]
            out.write(b"%010d %05d n\r\n" % (offset, gen))
    out.write(b"trailer\n<< " + _trailer_dict(size, trailer, info_ref) + b" >>\n")


def _write_xref_stream(out, offsets, size, trailer, info_ref):
    # The xref stream is an object too, so it takes the next number and lists itself.
    xref_num = size
    entries = {**offsets, xref_num: (out.tell(), 0)}
    width = max(4, (max(o for o, _ in entries.values()).bit_length() + 7) // 8)
    rows = b"".join(b"\x01" + entries[n][0].to_bytes(width, "big") + entries[n][1].to_bytes(2, "big")
                    for first, count in _runs(entries) for n in range(first, first + count))
    index = b" ".join(b"%d %d" % (first, count) for first, count in _runs(entries))
    out.write(b"%d 0 obj\n<< /Type /XRef /W [1 %d 2] /Index [%s] %s /Length %d >>\nstream\n"
              % (xref_num, width, index, _trailer_dict(size + 1, trailer, info_ref), len(rows)))
    out.write(rows + b"\nendstream\nendobj\n")


def _xmp_bytes(reader: PdfReader) -> bytes:
    try:
        return reader.trailer["/Root"]["/Metadata"].get_object().get_data()
    except Exception as exc:
        raise Skip("xmp-unreadable") from exc


def _xmp_with_title(xmp: bytes, title: str) -> bytes:
    """Replace or add dc:title; every other byte of the packet stays as it was."""
    # Text edit, not an XML round trip: ElementTree drops xpacket PIs and renames prefixes.
    value = escape(title).encode("utf-8")
    # Older Acrobat packets carry dc:title as an attribute, which qpdf reads ahead of any element.
    attribute = b'dc:title="' + escape(title, {'"': "&quot;"}).encode("utf-8") + b'"'
    xmp = _DC_TITLE_ATTR.sub(lambda _m: attribute, xmp)
    element = (b'<dc:title><rdf:Alt><rdf:li xml:lang="x-default">' + value
               + b"</rdf:li></rdf:Alt></dc:title>")
    if _DC_TITLE.search(xmp):
        return _DC_TITLE.sub(lambda _m: element, xmp, count=1)
    if not _RDF_END.search(xmp):
        raise Skip("xmp-unrecognised")
    description = (b'<rdf:Description rdf:about="" xmlns:dc="' + _DC.encode() + b'">'
                   + element + b"</rdf:Description>")
    return _RDF_END.sub(lambda _m: description + b"</rdf:RDF>", xmp, count=1)


def xmp_title(xmp: bytes) -> Optional[str]:
    """dc:title x-default from raw XMP bytes; pypdf's own XMP reader fails on some real files."""
    for element in ElementTree.fromstring(xmp).iter(f"{{{_DC}}}title"):
        for li in element.iter(f"{{{_RDF}}}li"):
            if li.get(_XML_LANG) == "x-default":
                return li.text
    return None


def _page_key(page) -> tuple:
    ref = page.indirect_reference
    buf = io.BytesIO()
    page.write_to_stream(buf)  # references serialise as "N G R", so this compares the raw entries
    return ref.idnum, ref.generation, buf.getvalue()


def _check(original: bytes, reader: PdfReader, updated: bytes, title: str, has_xmp: bool) -> None:
    """Refuse any output that is not the original plus a title. Each failure is a skip."""
    if updated[: len(original)] != original:
        raise Skip("check-prefix")
    try:
        reopened = PdfReader(io.BytesIO(updated), strict=False)
        pages = [_page_key(p) for p in reopened.pages]
        written = reopened.metadata.title if reopened.metadata else None
        written_xmp = xmp_title(_xmp_bytes(reopened)) if has_xmp else title
    except Exception as exc:
        raise Skip("check-reopen") from exc
    # Same page objects, same numbers, same entries (so the same /Contents references).
    if pages != [_page_key(p) for p in reader.pages]:
        raise Skip("check-pages")
    if written != title or written_xmp != title:
        raise Skip("check-title")


def _normalise(warning: str) -> str:
    """Drop what differs between two opens of the same objects: the stream name and offsets."""
    return _OFFSET.sub("offset N", _STREAM_NAME.sub("stream", warning))


def _qpdf_warnings(data: bytes) -> Counter:
    """qpdf's warnings for `data`, normalised. Raises when qpdf finds errors (`--check` exit 2)."""
    with pikepdf.open(io.BytesIO(data)) as pdf:
        return Counter(_normalise(w) for w in pdf.check_pdf_syntax())


def _check_with_qpdf(updated: bytes, page_count: int, title: str, has_xmp: bool,
                     source_warnings: Counter) -> None:
    """Second, independent reader: qpdf (through pikepdf) must add no warning to the original's."""
    try:
        problems = _qpdf_warnings(updated)
        with pikepdf.open(io.BytesIO(updated)) as pdf:
            pages = len(pdf.pages)
            written = str(pdf.docinfo.get("/Title", ""))
            with pdf.open_metadata(set_pikepdf_as_editor=False, update_docinfo=False) as meta:
                written_xmp = meta.get("dc:title") if has_xmp else title
    except Exception as exc:
        raise Skip("check-qpdf-open") from exc
    if problems != source_warnings:
        log.info("qpdf warnings changed: %s", list((problems - source_warnings).elements())[:3])
        raise Skip("check-qpdf")
    if pages != page_count:
        raise Skip("check-qpdf-pages")
    if written != title or written_xmp != title:
        raise Skip("check-qpdf-title")
