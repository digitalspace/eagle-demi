"""`python3 -m pytest pdf-title/test_titler.py`. Every fixture is built here; nothing read from disk."""

import hashlib
import io
from collections import Counter

import pikepdf
import pytest
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, NameObject, NumberObject, StreamObject

import titler
from titler import set_title

TITLE = "Vol 4 - Append 6A - Wildlife & Species Objectives (é) ✓"

OLD_XMP_TITLE = b"AMEC Report Template"
PDFA_XMP = b"""<?xpacket begin="\xef\xbb\xbf" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
<pdfaid:part>1</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>
</rdf:Description>
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">AMEC Report Template</rdf:li></rdf:Alt></dc:title>
</rdf:Description>
</rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"""


def _pdf(pages=2, xmp=None, encrypt=None, user_password="", root_extra=None, flate_xmp=False):
    """Classic-xref PDF written by pypdf."""
    w = PdfWriter()
    for _ in range(pages):
        w.add_blank_page(200, 200)
    w.add_metadata({"/Title": "AMEC Report Template", "/Producer": "Acrobat Distiller 6.0.1",
                    "/ModDate": "D:20040102030405"})
    if xmp is not None and flate_xmp:
        stream = StreamObject()
        stream.set_data(xmp)
        w.root_object[NameObject("/Metadata")] = w._add_object(stream.flate_encode())
    elif xmp is not None:
        w.xmp_metadata = xmp
    if root_extra:
        w.root_object.update(root_extra)
    if encrypt:
        w.encrypt(user_password=user_password, owner_password="owner", algorithm=encrypt)
    out = io.BytesIO()
    w.write(out)
    return out.getvalue()


def _xref_stream_pdf(info=True, xmp=None):
    """PDF 1.5 whose only cross-reference section is an uncompressed xref stream."""
    catalog = b"<< /Type /Catalog /Pages 2 0 R%s >>" % (b" /Metadata 5 0 R" if xmp else b"")
    bodies = {1: catalog,
              2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
              3: b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>"}
    if info:
        bodies[4] = b"<< /Title (Old) /Producer (Hand) >>"
    if xmp:
        bodies[5] = (b"<< /Type /Metadata /Subtype /XML /Length %d >>\nstream\n%s\nendstream"
                     % (len(xmp), xmp))
    xref_num = 6
    out = bytearray(b"%PDF-1.5\n")
    offsets = {}
    for n, body in bodies.items():
        offsets[n] = len(out)
        out += b"%d 0 obj\n%s\nendobj\n" % (n, body)
    offsets[xref_num] = len(out)
    rows = [(0, 0, 0xFFFF)] + [(1, offsets[n], 0) if n in offsets else (0, 0, 0)
                               for n in range(1, xref_num + 1)]
    data = b"".join(t.to_bytes(1, "big") + o.to_bytes(4, "big") + g.to_bytes(2, "big")
                    for t, o, g in rows)
    out += (b"%d 0 obj\n<< /Type /XRef /Size %d /W [1 4 2] /Root 1 0 R%s /Length %d >>\n"
            b"stream\n%s\nendstream\nendobj\nstartxref\n%d\n%%%%EOF\n"
            % (xref_num, xref_num + 1, b" /Info 4 0 R" if info else b"", len(data), data,
               offsets[xref_num]))
    return bytes(out)


def _reopen(data):
    return PdfReader(io.BytesIO(data))


def _xmp_title(reader):
    return titler.xmp_title(reader.trailer["/Root"]["/Metadata"].get_object().get_data())


def _qpdf_problems(data):
    with pikepdf.open(io.BytesIO(data)) as pdf:
        return pdf.check_pdf_syntax() + pdf.get_warnings()


WRITABLE = {
    "classic": lambda: _pdf(),
    "classic-pdfa-xmp": lambda: _pdf(xmp=PDFA_XMP),
    "classic-flate-xmp": lambda: _pdf(xmp=PDFA_XMP, flate_xmp=True),
    "xref-stream": lambda: _xref_stream_pdf(),
    "xref-stream-xmp": lambda: _xref_stream_pdf(xmp=PDFA_XMP),
    "xref-stream-no-info": lambda: _xref_stream_pdf(info=False),
}


@pytest.mark.parametrize("build", WRITABLE.values(), ids=WRITABLE.keys())
def test_output_passes_qpdf_check_with_no_warnings(build):
    original = build()
    assert _qpdf_problems(original) == []  # the fixture itself is clean

    result = set_title(original, TITLE)

    assert _qpdf_problems(result.data) == []


def test_qpdf_check_refuses_an_update_with_a_wrong_size():
    # pypdf's own incremental writer leaves the xref stream out of its own section.
    original = _pdf()
    writer = PdfWriter(_reopen(original), incremental=True)
    writer.add_metadata({"/Title": TITLE})
    out = io.BytesIO()
    writer.write(out)

    with pytest.raises(titler.Skip, match="^check-qpdf$"):
        titler._check_with_qpdf(out.getvalue(), 2, TITLE, False, source_warnings=Counter())


def _with_content(data, flate=False):
    """One-page PDF whose content stream is `data`, raw or labelled FlateDecode."""
    w = PdfWriter()
    page = w.add_blank_page(100, 100)
    stream = StreamObject()
    stream.set_data(data)
    if flate:
        stream[NameObject("/Filter")] = NameObject("/FlateDecode")
    page[NameObject("/Contents")] = w._add_object(stream)
    out = io.BytesIO()
    w.write(out)
    return out.getvalue()


def test_original_with_qpdf_warnings_only_is_titled_and_the_count_recorded():
    original = _with_content(b"BT /F1 12 Tf (abc Tj ET")  # qpdf --check exit 3: EOF in a token
    assert len(_qpdf_problems(original)) == 1

    result = set_title(original, TITLE)

    assert (result.status, result.source_warnings) == ("ready", 1)
    assert result.data[: result.source_length] == original
    assert _reopen(result.data).metadata.title == TITLE


def test_clean_original_records_no_warnings():
    assert set_title(_pdf(), TITLE).source_warnings == 0


def test_original_with_qpdf_errors_is_skipped_untouched():
    original = _with_content(b"not zlib data", flate=True)  # qpdf --check exit 2

    result = set_title(original, TITLE)

    assert (result.status, result.reason, result.data) == ("skipped", "check-qpdf-source-errors", None)


def test_a_warning_the_output_adds_is_refused_even_when_the_original_had_others():
    original = _with_content(b"BT /F1 12 Tf (abc Tj ET")
    broken = PdfWriter(_reopen(original), incremental=True)  # leaves out its own xref entry
    broken.add_metadata({"/Title": TITLE})
    out = io.BytesIO()
    broken.write(out)

    with pytest.raises(titler.Skip, match="^check-qpdf$"):
        titler._check_with_qpdf(out.getvalue(), 1, TITLE, False, titler._qpdf_warnings(original))


def test_warning_comparison_ignores_stream_names_and_byte_offsets():
    a = "WARNING: stream <_io.BytesIO object at 0x7f01>, object 3 0 at offset 455: stream keyword"
    b = "WARNING: stream <_io.BytesIO object at 0x7e99>, object 3 0 at offset 1290: stream keyword"

    assert titler._normalise(a) == titler._normalise(b)
    assert titler._normalise(a) != titler._normalise(a.replace("object 3 0", "object 4 0"))


@pytest.mark.parametrize("build", WRITABLE.values(), ids=WRITABLE.keys())
def test_original_is_an_exact_prefix_and_the_info_title_is_set(build):
    original = build()

    result = set_title(original, TITLE)

    assert result.status == "ready"
    assert result.data.startswith(original)
    assert _reopen(result.data).metadata.title == TITLE


def test_truncating_to_the_recorded_length_restores_the_exact_original():
    original = _pdf(xmp=PDFA_XMP)

    result = set_title(original, TITLE)

    restored = result.data[: result.source_length]
    assert result.source_length == len(original)
    assert restored == original
    assert hashlib.sha256(restored).hexdigest() == result.source_sha256


def test_info_only_pdf_gets_no_xmp():
    result = set_title(_pdf(), TITLE)

    assert "/Metadata" not in _reopen(result.data).trailer["/Root"]


def test_info_only_pdf_keeps_producer_moddate_and_page_count():
    result = set_title(_pdf(pages=3), TITLE)

    updated = _reopen(result.data)
    assert updated.metadata.producer == "Acrobat Distiller 6.0.1"
    assert updated.metadata["/ModDate"] == "D:20040102030405"
    assert len(updated.pages) == 3


@pytest.mark.parametrize("build", [lambda: _pdf(xmp=PDFA_XMP), lambda: _xref_stream_pdf(xmp=PDFA_XMP)],
                         ids=["classic", "xref-stream"])
def test_xmp_title_that_differs_is_replaced_so_info_and_xmp_agree(build):
    original = build()
    assert _xmp_title(_reopen(original)) == OLD_XMP_TITLE.decode()

    updated = _reopen(set_title(original, TITLE).data)

    assert updated.metadata.title == TITLE
    assert _xmp_title(updated) == TITLE


def test_xref_stream_xmp_is_revised_in_place_not_pointed_elsewhere():
    original = _xref_stream_pdf(xmp=PDFA_XMP)

    updated = _reopen(set_title(original, TITLE).data)

    metadata_ref = updated.trailer["/Root"].raw_get("/Metadata")
    assert metadata_ref.idnum == 5
    assert updated.get_object(metadata_ref)["/Subtype"] == "/XML"


def test_missing_info_dict_gets_a_number_no_section_already_uses():
    original = _xref_stream_pdf(info=False)

    updated = _reopen(set_title(original, TITLE).data)

    assert updated.trailer.raw_get("/Info").idnum == 7  # 6 is the original xref stream
    assert updated.metadata.title == TITLE


def test_pdfa_id_survives_the_xmp_update():
    result = set_title(_pdf(xmp=PDFA_XMP), TITLE)

    xmp = _reopen(result.data).trailer["/Root"]["/Metadata"].get_object().get_data()
    assert b"<pdfaid:part>1</pdfaid:part>" in xmp


def test_flate_xmp_is_rewritten_unfiltered():
    original = _pdf(xmp=PDFA_XMP, flate_xmp=True)
    assert "/Filter" in _reopen(original).trailer["/Root"]["/Metadata"].get_object()

    stream = _reopen(set_title(original, TITLE).data).trailer["/Root"]["/Metadata"].get_object()

    assert "/Filter" not in stream


def test_xmp_without_dc_title_gets_one():
    xmp = PDFA_XMP.replace(
        b'<dc:title><rdf:Alt><rdf:li xml:lang="x-default">AMEC Report Template</rdf:li></rdf:Alt></dc:title>',
        b"")

    result = set_title(_pdf(xmp=xmp), TITLE)

    assert _xmp_title(_reopen(result.data)) == TITLE


ATTRIBUTE_XMP = b"""<?xpacket begin='' id='W5M0MpCehiHzreSzNTczkc9d'?>
<rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>
<rdf:Description about='' xmlns='http://purl.org/dc/elements/1.1/' \
xmlns:dc='http://purl.org/dc/elements/1.1/' dc:creator='Mike' dc:title='ArcView Print Job'/>
</rdf:RDF><?xpacket end='r'?>"""


def test_xmp_title_held_as_an_attribute_is_replaced_for_qpdf_and_pdfjs():
    result = set_title(_pdf(xmp=ATTRIBUTE_XMP), TITLE)

    with pikepdf.open(io.BytesIO(result.data)) as pdf:
        with pdf.open_metadata(set_pikepdf_as_editor=False, update_docinfo=False) as meta:
            assert meta.get("dc:title") == TITLE
    updated = _reopen(result.data)
    assert _xmp_title(updated) == TITLE
    assert b"ArcView Print Job" not in updated.trailer["/Root"]["/Metadata"].get_object().get_data()


def test_xmp_with_whitespace_inside_closing_tags_is_edited():
    xmp = PDFA_XMP.replace(b"</dc:title>", b"</dc:title\r\n>").replace(b"</rdf:RDF>", b"</rdf:RDF\r\n>")

    result = set_title(_pdf(xmp=xmp), TITLE)

    assert result.status == "ready"
    assert _xmp_title(_reopen(result.data)) == TITLE


def test_xmp_that_cannot_be_edited_is_reported_not_written():
    no_rdf = b'<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"/><?xpacket end="w"?>'

    result = set_title(_pdf(xmp=no_rdf), TITLE)

    assert (result.status, result.reason, result.data) == ("skipped", "xmp-unrecognised", None)


def test_title_whitespace_and_newlines_collapse_to_single_spaces():
    result = set_title(_pdf(xmp=PDFA_XMP), "  Appendix A7.13-2\n Palaeontological\tResources (é)\n")

    updated = _reopen(result.data)
    assert result.title == "Appendix A7.13-2 Palaeontological Resources (é)"
    assert updated.metadata.title == result.title
    assert _xmp_title(updated) == result.title


ENCRYPTED = {
    "rc4-40": ("RC4-40", ""),
    "rc4-128": ("RC4-128", ""),
    "aes-128": ("AES-128", ""),
    "aes-256": ("AES-256", ""),
    "aes-256-user-password": ("AES-256", "secret"),
}


@pytest.mark.parametrize("algorithm,user_password", ENCRYPTED.values(), ids=ENCRYPTED.keys())
def test_encrypted_pdf_is_skipped_and_no_output_produced(algorithm, user_password):
    result = set_title(_pdf(encrypt=algorithm, user_password=user_password), TITLE)

    assert (result.status, result.reason, result.data) == ("skipped", "encrypted", None)


SIGNED_BY_FLAGS = {NameObject("/AcroForm"): DictionaryObject({
    NameObject("/Fields"): ArrayObject(), NameObject("/SigFlags"): NumberObject(3)})}
SIGNED_BY_BYTERANGE = {NameObject("/SigDict"): DictionaryObject({
    NameObject("/ByteRange"): ArrayObject([NumberObject(0), NumberObject(10)])})}


@pytest.mark.parametrize("marker", [SIGNED_BY_FLAGS, SIGNED_BY_BYTERANGE], ids=["sigflags", "byterange"])
def test_signed_pdf_is_skipped(marker):
    result = set_title(_pdf(root_extra=marker), TITLE)

    assert (result.status, result.reason, result.data) == ("skipped", "signed", None)


def test_zero_byte_file_is_skipped():
    result = set_title(b"", TITLE)

    assert (result.status, result.reason, result.source_sha256) == ("skipped", "empty", None)


def test_file_that_will_not_open_is_skipped():
    result = set_title(b"<html>Access Denied</html>", TITLE)

    assert (result.status, result.reason) == ("skipped", "unreadable")


def test_startxref_that_points_at_no_xref_section_is_skipped():
    original = _pdf()
    broken = original[: original.rindex(b"startxref")] + b"startxref\n3\n%%EOF\n"
    assert _reopen(broken).metadata.title  # pypdf repairs it, so only the guard can refuse

    result = set_title(broken, TITLE)

    assert (result.status, result.reason) == ("skipped", "bad-startxref")


def test_blank_title_is_skipped():
    result = set_title(_pdf(), " \n ")

    assert (result.status, result.reason) == ("skipped", "no-title")


def test_an_update_that_revises_a_page_is_refused():
    original = _pdf()
    reader = _reopen(original)
    page = DictionaryObject(reader.pages[0])
    page[NameObject("/Rotate")] = NumberObject(90)
    ref = reader.pages[0].indirect_reference
    info_ref = titler._info_ref(reader)
    updated = titler._append(original, reader, {(ref.idnum, ref.generation): page}, info_ref)

    with pytest.raises(titler.Skip, match="check-pages"):
        titler._check(original, reader, updated, "AMEC Report Template", has_xmp=False)
